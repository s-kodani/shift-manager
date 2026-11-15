"""Build a value-free catalog from a D1 SQL export; never print row contents."""

import hashlib
import json
import re
import sqlite3
import sys
from pathlib import Path

REFERENCES = {
    "input_snapshot": ("object_key", "sha256", "byte_length"),
    "compute_job": ("result_key", "result_sha256", "result_bytes"),
    "schedule_draft_version": ("object_key", "sha256", "byte_length"),
    "schedule_publication_version": ("object_key", "sha256", "byte_length"),
    "publication_revalidation_source": ("object_key", "sha256", "byte_length"),
    "publication_revalidation_input": ("object_key", "sha256", "byte_length"),
    "publication_revalidation_result": ("object_key", "sha256", "byte_length"),
}


def quote(name):
    return '"' + name.replace('"', '""') + '"'


IMPORT_STATEMENT_BYTES = 64_000  # Below D1's 100,000-byte statement limit.


def quoted_end(text, start):
    """SQL doubled quotes escape a quote; backslashes have no SQL meaning."""
    delimiter = text[start]
    end = start + 1
    while end < len(text):
        if text[end] == delimiter:
            if end + 1 < len(text) and text[end + 1] == delimiter:
                end += 2
                continue
            return end + 1
        end += 1
    raise ValueError("UNTERMINATED_EXPORT_QUOTE")


def bounded_insert(stmt):
    """Keep large exported TEXT intact without exceeding the SQL text limit.

    Split VALUES rows outside quoted strings. Stage long literals in ordered
    chunks, reconstruct each value once, then remove the staging table before
    views/triggers are installed. Catalog and FK checks still cover everything.
    """
    if len(stmt.encode()) <= IMPORT_STATEMENT_BYTES:
        return [stmt]
    match = re.match(r"(INSERT INTO\s+.+?\s+VALUES\s*)(.*);$", stmt, re.I | re.S)
    if not match:
        raise ValueError("UNSUPPORTED_LARGE_EXPORT_INSERT")
    prefix, values = match.groups()
    rows, depth, start, i = [], 0, 0, 0
    while i < len(values):
        if values[i] in "'\"`":
            i = quoted_end(values, i)
            continue
        if values[i] == "(":
            depth += 1
        elif values[i] == ")":
            depth -= 1
        elif values[i] == "," and depth == 0:
            rows.append(values[start:i])
            start = i + 1
        if depth < 0:
            raise ValueError("INVALID_EXPORT_VALUES")
        i += 1
    if depth:
        raise ValueError("INVALID_EXPORT_VALUES")
    rows.append(values[start:])
    output = []
    for row in rows:
        statement = prefix + row + ";"
        if len(statement.encode()) <= IMPORT_STATEMENT_BYTES:
            output.append(statement)
            continue
        name = "__shift_restore_text_" + hashlib.sha256(statement.encode()).hexdigest()[:16]
        if name in stmt:
            raise ValueError("IMPORT_STAGING_NAME_COLLISION")
        staged, rewritten, last, i, literal = [], [], 0, 0, 0
        while i < len(statement):
            if statement[i] in "'\"`":
                end = quoted_end(statement, i)
                if statement[i] == "'" and end - i > 8_000:
                    value = statement[i + 1:end - 1].replace("''", "'")
                    for seq, offset in enumerate(range(0, len(value), 8_000)):
                        chunk = value[offset:offset + 8_000].replace("'", "''")
                        staged.append(f"INSERT INTO {quote(name)} VALUES({literal},{seq},'{chunk}');")
                    rewritten.append(statement[last:i])
                    rewritten.append(f"(SELECT group_concat(value,'') FROM (SELECT value FROM {quote(name)} WHERE literal_id={literal} ORDER BY chunk_index))")
                    literal += 1
                    last = end
                i = end
            else:
                i += 1
        if not staged:
            raise ValueError("UNSPLITTABLE_EXPORT_STATEMENT")
        rewritten.append(statement[last:])
        output.extend([
            f"CREATE TABLE {quote(name)}(literal_id INTEGER,chunk_index INTEGER,value TEXT,PRIMARY KEY(literal_id,chunk_index));",
            *staged, "".join(rewritten), f"DROP TABLE {quote(name)};",
        ])
    if any(len(s.encode()) > IMPORT_STATEMENT_BYTES for s in output):
        raise ValueError("IMPORT_STATEMENT_TOO_LARGE")
    return output


def prepare_import(source, target):
    """Preserve SQL statements, but create every referenced table before data."""
    text = Path(source).read_text()
    statements, buffer = [], ""
    # SQLite understands quoted semicolons and whole CREATE TRIGGER bodies.
    for char in text:
        buffer += char
        if char == ";" and sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise ValueError("INCOMPLETE_EXPORT_STATEMENT")
    tables, indexes, data, views, triggers = [], [], [], [], []
    for stmt in statements:
        if re.fullmatch(r"PRAGMA\s+defer_foreign_keys\s*=\s*TRUE;", stmt, re.I):
            continue
        if re.match(r"CREATE TABLE\s", stmt, re.I):
            tables.append(stmt)
        elif re.match(r"INSERT INTO\s", stmt, re.I):
            data.extend(bounded_insert(stmt))
        elif re.fullmatch(r'DELETE FROM ["`]?sqlite_sequence["`]?;', stmt, re.I):
            data.append(stmt)
        elif re.match(r"CREATE (?:UNIQUE )?INDEX\s", stmt, re.I):
            indexes.append(stmt)
        elif re.match(r"CREATE TRIGGER\s", stmt, re.I):
            triggers.append(stmt)
        elif re.match(r"CREATE VIEW\s", stmt, re.I):
            views.append(stmt)
        else:
            raise ValueError("UNSUPPORTED_EXPORT_STATEMENT")
    prepared = "PRAGMA defer_foreign_keys=TRUE;\n" + "\n".join(tables + indexes + data + views + triggers) + "\n"
    Path(target).write_text(prepared)
    Path(target).chmod(0o600)
    if catalog(source) != catalog(target):
        raise ValueError("IMPORT_PREPARATION_CHANGED_CONTENT")
    # Rehearse the exact order with foreign keys enabled in one transaction.
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript("BEGIN;\n" + prepared + "COMMIT;")
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("PREPARED_FOREIGN_KEYS_FAILED")
    return {"prepared": True, "statements": len(statements)}


def catalog(sql_path):
    source = Path(sql_path)
    if source.stat().st_size > 128_000_000:
        raise ValueError("EXPORT_TOO_LARGE_FOR_MVP_TOOL")
    db = sqlite3.connect(":memory:")
    # Exports are operator-selected artifacts. Block file attachment and SQL
    # extension loading even if a modified dump is supplied to the verifier.
    db.set_authorizer(
        lambda action, a, b, *_: sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH)
        or (action == sqlite3.SQLITE_FUNCTION and b == "load_extension")
        else sqlite3.SQLITE_OK
    )
    db.executescript(source.read_text())
    if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
        raise ValueError("DATABASE_INTEGRITY_FAILED")
    if db.execute("PRAGMA foreign_key_check").fetchall():
        raise ValueError("FOREIGN_KEYS_FAILED")
    tables = {}
    objects = {}
    schema = db.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema "
        "WHERE name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY type,name"
    ).fetchall()
    names = [row[1] for row in schema if row[0] == "table"]
    if not set(REFERENCES).issubset(names):
        raise ValueError("BACKUP_SCHEMA_PROFILE_MISMATCH")
    for name in names:
        columns = [r[1] for r in db.execute(f"PRAGMA table_info({quote(name)})")]
        object_columns = {c for c in columns if c in {"object_key", "result_key"}}
        if object_columns and name not in REFERENCES:
            raise ValueError("UNCATALOGUED_OBJECT_REFERENCE")
        digest = hashlib.sha256()
        count = 0
        order = ",".join(quote(c) for c in columns)
        for row in db.execute(f"SELECT * FROM {quote(name)} ORDER BY {order}"):
            if any(isinstance(v, bytes) for v in row):
                raise ValueError("BLOB_NOT_SUPPORTED_BY_CURRENT_APP_BACKUP_PROFILE")
            encoded = json.dumps(
                row,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
            count += 1
        tables[name] = {"rows": count, "sha256": digest.hexdigest()}
        if name in REFERENCES:
            key, sha, length = REFERENCES[name]
            for obj_key, obj_sha, obj_size in db.execute(
                f"SELECT {quote(key)},{quote(sha)},{quote(length)} FROM {quote(name)} "
                f"WHERE {quote(key)} IS NOT NULL"
            ):
                if (
                    not isinstance(obj_key, str)
                    or not obj_key
                    or not isinstance(obj_sha, str)
                    or not re.fullmatch("[a-f0-9]{64}", obj_sha)
                    or not isinstance(obj_size, int)
                    or not 0 < obj_size <= 8_000_000
                ):
                    raise ValueError("INVALID_OBJECT_REFERENCE")
                ref = {"key": obj_key, "sha256": obj_sha, "bytes": obj_size}
                if obj_key in objects and objects[obj_key] != ref:
                    raise ValueError("CONFLICTING_OBJECT_REFERENCE")
                objects[obj_key] = ref
    active = db.execute(
        "SELECT count(*) FROM compute_job "
        "WHERE state IN ('QUEUED','RUNNING','CANCELLING')"
    ).fetchone()[0]
    revalidating = db.execute(
        "SELECT count(*) FROM publication_revalidation_request WHERE state='RUNNING'"
    ).fetchone()[0]
    maintenance = None
    if "maintenance_state" in tables:
        row = db.execute(
            "SELECT mode,revision,maintenance_id FROM maintenance_state WHERE id=1"
        ).fetchone()
        if row is None:
            raise ValueError("MISSING_MAINTENANCE_STATE")
        maintenance = {
            "mode": row[0],
            "revision": row[1],
            "maintenanceId": row[2],
            "activeLeases": db.execute("SELECT count(*) FROM maintenance_lease").fetchone()[0],
            "activeRevalidations": db.execute(
                "SELECT count(*) FROM publication_revalidation_request "
                "WHERE state IN ('PENDING','RUNNING')"
            ).fetchone()[0],
        }
    return {
        "schemaSha256": hashlib.sha256(
            json.dumps(schema, separators=(",", ":")).encode()
        ).hexdigest(),
        "tables": tables,
        "objects": [objects[key] for key in sorted(objects)],
        "activeJobs": active,
        "runningRevalidations": revalidating,
        "foreignKeyViolations": 0,
        # Preserve byte-for-byte catalog compatibility for historical backups.
        **({"maintenance": maintenance} if maintenance is not None else {}),
    }


if __name__ == "__main__":
    try:
        result = prepare_import(sys.argv[2], sys.argv[3]) if sys.argv[1] == "prepare-import" else catalog(sys.argv[1])
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        # SQL/rows may contain credentials or personal information. Deliberately
        # omit database exceptions and the SQL statement from terminal output.
        print("BACKUP_CATALOG_FAILED", file=sys.stderr)
        sys.exit(1)
