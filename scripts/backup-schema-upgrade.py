"""Rehearse reviewed maintenance-era migrations without exposing SQL or rows."""

import hashlib
import importlib.util
import json
import re
import sqlite3
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location("backup_catalog", Path(__file__).with_name("backup-catalog.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)

MINIMUM_VERSION = 27
CURRENT_VERSION = 34
# Optional, reviewed PoC-only receipt. It is not a product migration and must
# match exactly; do not ignore arbitrary extra tables in schema comparison.
FINAL_D1_SCHEMA = """CREATE TABLE final_d1_probe (
 id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETE','FAILED')),
 results_json TEXT,created_at INTEGER NOT NULL,finished_at INTEGER)"""
# Appending a migration requires an explicit recovery compatibility review.
UPGRADES = [
    "0028_maintenance_completion.sql",
    "0029_maintenance_database_retirement.sql",
    "0030_recovery_security.sql",
    "0031_maintenance_business_authority.sql",
    "0032_maintenance_delivery_authority.sql",
    "0033_recovery_reissue.sql",
    "0034_staff_lifecycle.sql",
]


def safe_database(sql):
    db = sqlite3.connect(":memory:")
    db.set_authorizer(
        lambda action, a, b, *_: sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH)
        or (action == sqlite3.SQLITE_FUNCTION and b == "load_extension")
        else sqlite3.SQLITE_OK
    )
    db.executescript(sql)
    return db


def schema(db):
    # D1 exports quote identifiers. Compare SQL tokens, preserving literals and
    # operators; don't mistake whitespace/identifier quoting for schema changes.
    token = re.compile(r"--[^\n]*(?:\n|$)|/\*.*?\*/|'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`(?:``|[^`])*`|\[[^\]]*\]|\w+|[^\s]", re.S)
    result = {}
    for kind, name, sql in db.execute(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL "
        "AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA','d1_migrations','local_ui_fixture','local_business_check_probe')"
    ):
        tokens = []
        for t in token.findall(sql):
            if t.startswith(("--", "/*")):
                continue
            if t[0] in ('"', '`', '['):
                t = t[1:-1].replace(t[0] * 2, t[0])
            tokens.append(t if t.startswith("'") else t.lower())
        result[(kind, name)] = tokens
    return result


def prepare(source, migration_directory, bundle, expected_file, applied_at):
    before = backup.catalog(source)
    frozen = before.get("maintenance")
    if not frozen or frozen["mode"] != "FROZEN" or frozen["revision"] <= 0 or frozen["activeLeases"] or frozen["activeRevalidations"] or before["activeJobs"]:
        raise ValueError("UPGRADE_REQUIRES_FROZEN_IDLE_BACKUP")
    files = sorted(Path(migration_directory).glob("*.sql"))
    if len(files) != CURRENT_VERSION or [f.name for f in files[MINIMUM_VERSION:]] != UPGRADES:
        raise ValueError("UPGRADE_MIGRATIONS_REQUIRE_REVIEW")
    if [int(f.name[:4]) for f in files] != list(range(1, CURRENT_VERSION + 1)):
        raise ValueError("UPGRADE_MIGRATION_ORDER")
    db = safe_database(Path(source).read_text())
    ledger = db.execute("SELECT id,name,applied_at FROM d1_migrations ORDER BY id").fetchall()
    version = len(ledger)
    if not MINIMUM_VERSION <= version <= CURRENT_VERSION:
        raise ValueError("UNREVIEWED_BACKUP_SCHEMA_VERSION")
    if [(r[0], r[1]) for r in ledger] != [(i + 1, f.name) for i, f in enumerate(files[:version])]:
        raise ValueError("BACKUP_MIGRATION_LEDGER_MISMATCH")
    reference = safe_database("\n".join(f.read_text() for f in files[:version]))
    if db.execute("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='final_d1_probe'").fetchone():
        reference.execute(FINAL_D1_SCHEMA)
    if schema(db) != schema(reference):
        raise ValueError("BACKUP_SCHEMA_DOES_NOT_MATCH_LEDGER")
    # 0034 adds status='active' to existing staff. Keep comparing every old
    # column and row, rather than allowing arbitrary staff changes because
    # the full-row catalog hash necessarily changes when a column is added.
    staff_columns = [r[1] for r in db.execute("PRAGMA table_info(staff)")]
    staff_projection = ",".join(backup.quote(c) for c in staff_columns)
    staff_query = f"SELECT {staff_projection} FROM staff ORDER BY {staff_projection}"
    staff_before = db.execute(staff_query).fetchall() if version < 34 else None
    if reference.execute("SELECT 1 FROM sqlite_schema WHERE name='final_d1_probe'").fetchone():
        if db.execute("SELECT 1 FROM final_d1_probe WHERE state='RUNNING' LIMIT 1").fetchone():
            raise ValueError("UPGRADE_REQUIRES_SETTLED_PROBES")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", applied_at):
        raise ValueError("UPGRADE_APPLIED_AT_INVALID")
    parts = ["PRAGMA defer_foreign_keys=TRUE;"]
    for i, f in enumerate(files[version:], start=version + 1):
        parts += [f.read_text(), f"INSERT INTO d1_migrations(id,name,applied_at) VALUES({i},'{f.name}','{applied_at}');"]
    sql = "\n".join(parts) + "\n"
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("BEGIN;\n" + sql + "COMMIT;")
    Path(bundle).write_text(sql)
    Path(bundle).chmod(0o600)
    Path(expected_file).write_text("\n".join(db.iterdump()) + "\n")
    Path(expected_file).chmod(0o600)
    after = backup.catalog(expected_file)
    if version < 34:
        if db.execute(staff_query).fetchall() != staff_before:
            raise ValueError("UPGRADE_CHANGED_EXISTING_STAFF")
        if db.execute("SELECT 1 FROM staff WHERE status != 'active' LIMIT 1").fetchone():
            raise ValueError("UPGRADE_CHANGED_INITIAL_STAFF_STATUS")
    # Apart from the reviewed staff column addition, every pre-existing
    # application row (including credentials) must stay intact.
    for name, table in before["tables"].items():
        if name == "staff" and version < 34:
            continue
        if name != "d1_migrations" and after["tables"].get(name) != table:
            raise ValueError("UPGRADE_CHANGED_EXISTING_ROWS")
    for name, table in after["tables"].items():
        if name not in before["tables"] and table["rows"]:
            raise ValueError("UPGRADE_CREATED_UNREVIEWED_DATA")
    if before["objects"] != after["objects"] or before["maintenance"] != after["maintenance"]:
        raise ValueError("UPGRADE_CHANGED_RESTORE_BOUNDARY")
    return {
        "version": "restore-schema-plan-v1", "fromVersion": version,
        "toVersion": CURRENT_VERSION, "appliedAt": applied_at,
        "migrations": [{"name": f.name, "sha256": hashlib.sha256(f.read_bytes()).hexdigest()} for f in files],
        "bundleSha256": hashlib.sha256(Path(bundle).read_bytes()).hexdigest(),
        "expectedSqlSha256": hashlib.sha256(Path(expected_file).read_bytes()).hexdigest(),
        "catalog": after,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(prepare(*sys.argv[1:]), ensure_ascii=False))
    except Exception:
        print("BACKUP_SCHEMA_UPGRADE_FAILED", file=sys.stderr)
        sys.exit(1)
