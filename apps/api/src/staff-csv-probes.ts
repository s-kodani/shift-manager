import {settledMaintenanceWork} from './maintenance';
import {interceptProbeBatch} from './probe-database';
// Only imported by the bearer-protected, fictional PoC entry point.
import { z } from "zod";
import { createApp } from "./index";
import { inputFixture } from "./input-probes";
import { ProductError } from "./product";
import { staffCsvColumns, staffCsvPreview, staffCsvResponse, staffCsvReceipt } from "./staff-csv-contract";
import { createInputSnapshot, readInputSnapshot } from "./input-snapshots";
import { resolveVersion } from "./input-versions";

export const staffCsvProbeCommand = z.object({
  probeId: z.string().uuid(),
  mode: z.enum(["suite", "capacity"]).default("suite"),
}).strict();
export const staffCsvProbeOwner = staffCsvProbeCommand.pick({ probeId: true });
const label = (id: string) => `架空スタッフCSV検証:${id}`;
const ownedUsers = `SELECT user_id FROM company_admin WHERE company_id IN (SELECT id FROM company WHERE name=?)
 UNION SELECT user_id FROM staff WHERE company_id IN (SELECT id FROM company WHERE name=?)`;
function privateOnly(env: Env) {
  if (env.ENVIRONMENT !== "poc") throw new ProductError("FORBIDDEN", 403);
}
export async function inspectStaffCsvProbe(env: Env, probeId: string) {
  privateOnly(env);
  const name = label(probeId);
  const companies = (await env.DB.prepare("SELECT id,revision FROM company WHERE name=?").bind(name).all<{ id: string; revision: number }>()).results;
  const count = async (sql: string) => (await env.DB.prepare(sql).bind(name, name).first<number>("n"))!;
  return {
    probeId, companies,
    enabled: await count(`SELECT count(*) n FROM access_state WHERE enabled=1 AND user_id IN (${ownedUsers})`),
    sessions: await count(`SELECT count(*) n FROM session WHERE userId IN (${ownedUsers})`),
    passwords: await count(`SELECT count(*) n FROM account WHERE password IS NOT NULL AND userId IN (${ownedUsers})`),
    receipts: (await env.DB.prepare("SELECT count(*) n FROM staff_csv_receipt WHERE company_id IN (SELECT id FROM company WHERE name=?)").bind(name).first<number>("n"))!,
  };
}
export async function cleanupStaffCsvProbe(env: Env, probeId: string) {
  privateOnly(env);
  const name = label(probeId);
  const active = await env.DB.prepare("SELECT count(*) n FROM compute_job WHERE company_id IN (SELECT id FROM company WHERE name=?) AND state IN ('QUEUED','RUNNING','CANCELLING')").bind(name).first<number>("n");
  if (active) throw new ProductError("PROBE_BUSY", 409);
  await env.DB.batch([
    env.DB.prepare(`UPDATE access_state SET enabled=0 WHERE user_id IN (${ownedUsers})`).bind(name, name),
    env.DB.prepare(`DELETE FROM session WHERE userId IN (${ownedUsers})`).bind(name, name),
    env.DB.prepare(`DELETE FROM verification WHERE value IN (${ownedUsers})`).bind(name, name),
    env.DB.prepare(`UPDATE account SET password=NULL WHERE userId IN (${ownedUsers})`).bind(name, name),
  ]);
  return inspectStaffCsvProbe(env, probeId);
}

export async function runStaffCsvProbes(env: Env, command: z.infer<typeof staffCsvProbeCommand>) {
  privateOnly(env);
  if ((await inspectStaffCsvProbe(env, command.probeId)).companies.length) throw new ProductError("PROBE_ALREADY_EXISTS", 409);
  const start = Date.now(), results: { name: string; passed: true }[] = [];
  const ensure = (ok: unknown) => { if (!ok) throw new Error("STAFF_CSV_PROBE_FAILED"); };
  const record = (name: string) => results.push({ name, passed: true });
  let cleanup: Awaited<ReturnType<typeof inspectStaffCsvProbe>> | null = null;
  let importedRows = 0, applyMilliseconds = 0;
  try {
    const f = await inputFixture(env.DB, env.INPUTS, label(command.probeId)), company = f.company.companyId;
    const prefix = `/api/companies/${company}/inputs/teams/${f.team}/staff-csv`, app = createApp();
    const request = async (path: string, body?: object, cookie = "", expected = 200, bindings = env) => {
      const r = await app.request(env.AUTH_BASE_URL + path, { method: body ? "POST" : "GET", headers: { origin: env.AUTH_BASE_URL, "content-type": "application/json", cookie }, ...(body ? { body: JSON.stringify(body) } : {}) }, bindings);
      if (r.status !== expected || r.headers.get("cache-control") !== "no-store") throw new Error(`STAFF_CSV_PROBE_HTTP:${r.status}:${expected}`);
      return { data: await r.json(), cookie: r.headers.get("set-cookie")?.split(";")[0] ?? "" };
    };
    const signed = await request("/api/auth/sign-in/email", { email: f.email, password: f.company.initialPassword });
    const managerCookie = signed.cookie;
    const revision = async () => (await env.DB.prepare("SELECT revision FROM company WHERE id=?").bind(company).first<number>("revision"))!;
    const state = async () => {
      const staff = (await env.DB.prepare("SELECT s.id,s.user_id,s.name,u.email,a.password FROM staff s JOIN user u ON u.id=s.user_id JOIN account a ON a.userId=u.id AND a.providerId='credential' WHERE s.company_id=? ORDER BY s.id").bind(company).all()).results;
      const inputs = (await env.DB.prepare("SELECT operation_id,payload FROM work_input_version WHERE company_id=? ORDER BY revision").bind(company).all()).results;
      const receipts = (await env.DB.prepare("SELECT operation_id,payload FROM staff_csv_receipt WHERE company_id=? ORDER BY operation_id").bind(company).all()).results;
      return JSON.stringify({ revision: await revision(), staff, inputs, receipts });
    };
    const row = (overrides: Record<string, string> = {}) => {
      const p = f.profile, cells: Record<string, string> = {
        staff_number: "0001", name: "架空CSVスタッフ", email: `${crypto.randomUUID()}@example.invalid`, employment_type_id: f.employment,
        weekdays: p.contract.weekdays.join(";"), start: "10:00", end: "17:00",
        daily_max: String(p.rule.dailyMax), weekly_max: String(p.rule.weeklyMax), monthly_min: String(p.rule.monthlyMin), monthly_max: String(p.rule.monthlyMax), min_days: String(p.rule.minDays), min_off: String(p.rule.minOff), max_consecutive: String(p.rule.maxConsecutive), skills: JSON.stringify(p.skills), role_ids: JSON.stringify(p.roleIds), ...overrides,
      };
      return staffCsvColumns.map(c => '"' + cells[c].replaceAll('"', '""') + '"').join(",");
    };
    const file = (...rows: string[]) => staffCsvColumns.join(",") + "\n" + rows.join("\n");
    const prepare = async (csv: string) => {
      const c = { csv, month: "2026-10", expectedRevision: await revision() };
      const preview = staffCsvPreview.parse((await request(prefix + "/preview", c, managerCookie)).data);
      return { command: { ...c, operationId: crypto.randomUUID(), previewSha256: preview.previewSha256 }, preview };
    };
    const apply = async (c: Awaited<ReturnType<typeof prepare>>["command"], expected = 200, bindings = env) => request(prefix + "/apply", c, managerCookie, expected, bindings);
    if (command.mode === "capacity") {
      const c = await prepare(file(...Array.from({ length: 100 }, (_, i) => row({ staff_number: `csv-${i + 1}` }))));
      ensure(c.preview.added === 100 && c.preview.rows.every(r => !r.errors.length));
      const t = Date.now(), response = staffCsvResponse.parse((await apply(c.command)).data);
      applyMilliseconds = Date.now() - t; importedRows = response.receipt.rows.length;
      ensure(response.receipt.added === 100 && response.receipt.revision === c.command.expectedRevision + 101 && response.initialPasswords.length === 100);
      ensure((await env.DB.prepare("SELECT count(*) n FROM staff s JOIN access_state a ON a.user_id=s.user_id JOIN account c ON c.userId=s.user_id AND c.providerId='credential' WHERE s.company_id=? AND s.staff_number LIKE 'csv-%' AND a.enabled=1 AND a.must_change_password=1 AND c.password IS NOT NULL").bind(company).first<number>("n")) === 100);
      const replay = staffCsvResponse.parse((await apply(c.command)).data);
      ensure(replay.receipt.replayed && !replay.initialPasswords.length && await revision() === response.receipt.revision);
      record("100_new_accounts_contracts_revision_and_secret_free_replay");
    } else {
      const old = (await env.DB.prepare("SELECT s.id,s.user_id,u.email,a.password FROM staff s JOIN user u ON u.id=s.user_id JOIN account a ON a.userId=u.id AND a.providerId='credential' WHERE s.company_id=? AND s.id=?").bind(company, f.staff.staffId).first<{ id: string; user_id: string; email: string; password: string } >())!;
      const oldLogin = await request("/api/auth/sign-in/email", { email: old.email, password: f.staff.initialPassword });
      const now = new Date().toISOString();
      await env.DB.prepare("INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").bind(crypto.randomUUID(), `reset-password:fictional-${command.probeId}`, old.user_id, new Date(Date.now() + 60000).toISOString(), now, now).run();
      const nextEmail = `${crypto.randomUUID()}@example.invalid`, newEmail = `${crypto.randomUUID()}@example.invalid`;
      const before = await state(), c = await prepare(file(row({ email: nextEmail }), row({ staff_number: "0002", email: newEmail }), row({ staff_number: "0003", start: "10:07" })));
      ensure(c.preview.added === 1 && c.preview.updated === 1 && c.preview.rows[2].errors.some(e => e.code === "CSV_TIME_NOT_ALIGNED") && await state() === before);
      record("preview_abort_read_only_and_invalid_row_diagnosis");
      const faulty=interceptProbeBatch(env.DB,'INSERT INTO staff_csv_operation',
        statements=>[...statements,env.DB.prepare('SELECT abs(-9223372036854775808)')]);
      await apply(c.command, 500, { ...env, DB: faulty });
      ensure(await state() === before && !(await env.DB.prepare("SELECT 1 FROM staff_csv_operation WHERE company_id=? AND id=?").bind(company, c.command.operationId).first()));
      record("real_D1_late_statement_failure_rolls_back_all_csv_writes");
      const t = Date.now(), accepted = staffCsvResponse.parse((await apply(c.command)).data);
      applyMilliseconds = Date.now() - t; importedRows = accepted.receipt.rows.length;
      ensure(accepted.receipt.added === 1 && accepted.receipt.updated === 1 && accepted.receipt.rejectedRows === 1 && accepted.receipt.revision === c.command.expectedRevision + 3 && accepted.initialPasswords.length === 1);
      const updated = (await env.DB.prepare("SELECT s.id,s.user_id,u.email,a.password FROM staff s JOIN user u ON u.id=s.user_id JOIN account a ON a.userId=u.id AND a.providerId='credential' WHERE s.company_id=? AND s.id=?").bind(company, f.staff.staffId).first())!;
      ensure(updated.id === old.id && updated.user_id === old.user_id && updated.password === old.password && updated.email === nextEmail);
      const receipt = staffCsvReceipt.parse((await request(prefix + "/receipts/" + c.command.operationId, undefined, managerCookie)).data);
      ensure(JSON.stringify(receipt.rows) === JSON.stringify(accepted.receipt.rows));
      const replay = staffCsvResponse.parse((await apply(c.command)).data);
      ensure(replay.receipt.replayed && !replay.initialPasswords.length && await revision() === accepted.receipt.revision);
      await apply({ ...c.command, csv: c.command.csv + "\n" }, 409);
      await apply({ ...c.command, operationId: crypto.randomUUID() }, 409);
      record("normal_rows_identity_password_preservation_receipt_replay_and_stale_conflicts");
      await request("/api/access", undefined, oldLogin.cookie, 401);
      ensure(!(await env.DB.prepare("SELECT 1 FROM verification WHERE value=?").bind(old.user_id).first()));
      await request("/api/auth/sign-in/email", { email: old.email, password: f.staff.initialPassword }, "", 401);
      await request("/api/auth/sign-in/email", { email: nextEmail, password: f.staff.initialPassword });
      record("real_Better_Auth_email_change_revokes_old_session_and_reset_link");
      const initial = accepted.initialPasswords[0].initialPassword;
      const first = await request("/api/auth/sign-in/email", { email: newEmail, password: initial });
      await request("/api/context", undefined, first.cookie, 403);
      const newPassword = `Fictional-${crypto.randomUUID()}-Aa1!`;
      await request("/api/password", { currentPassword: initial, newPassword }, first.cookie);
      const changed = await request("/api/auth/sign-in/email", { email: newEmail, password: newPassword });
      await request("/api/context", undefined, changed.cookie);
      await request(prefix + "/preview", { month: "2026-10", expectedRevision: await revision(), csv: c.command.csv }, changed.cookie, 403);
      record("new_account_first_change_gate_and_staff_import_denied");
      const same = await prepare(file(row({ staff_number: "0004" })));
      const deliveries = await settledMaintenanceWork([apply(same.command), apply(same.command)]);
      const responses = deliveries.map(d => staffCsvResponse.parse(d.data));
      ensure(responses.filter(r => !r.receipt.replayed).length === 1 && responses.flatMap(r => r.initialPasswords).length === 1 && await revision() === same.command.expectedRevision + 2);
      record("parallel_same_operation_one_account_one_initial_password");
      const a = await prepare(file(row({ email: nextEmail, name: "架空競合A" }))), b = await prepare(file(row({ email: nextEmail, name: "架空競合B" })));
      // Separate requests record HTTP status rather than assuming zero-row updates throw.
      const compete = async (body: typeof a.command) => { const r = await app.request(env.AUTH_BASE_URL + prefix + "/apply", { method: "POST", headers: { origin: env.AUTH_BASE_URL, "content-type": "application/json", cookie: managerCookie }, body: JSON.stringify(body) }, env); await r.body?.cancel(); return r.status; };
      const statuses = await settledMaintenanceWork([compete(a.command), compete(b.command)]);
      ensure(statuses.sort().join(",") === "200,409" && await revision() === a.command.expectedRevision + 2);
      record("parallel_distinct_operations_one_revision_winner");
      const snap = await createInputSnapshot(env.DB, env.INPUTS, company, f.team, f.company.userId, { operationId: crypto.randomUUID(), month: "2026-10", expectedRevision: await revision() });
      const frozen = await readInputSnapshot(env.DB, env.INPUTS, company, f.team, f.company.userId, snap.snapshot.id);
      const lineage = JSON.parse(frozen.snapshot.lineage) as { version: string }[];
      ensure(!frozen.stale && frozen.input.staff.length === 3);
      for (const person of [...accepted.receipt.rows, ...responses[0].receipt.rows]) {
        const current = await resolveVersion(env.DB, company, "staff_contract", person.staffId, "2026-10");
        ensure(current && lineage.some(l => l.version === current.operation_id) && JSON.stringify(JSON.parse(current.payload)) === JSON.stringify(f.profile));
      }
      record("R2_current_contracts_and_csv_lineage");
    }
  } finally {
    cleanup = await cleanupStaffCsvProbe(env, command.probeId);
    ensure(cleanup.enabled === 0 && cleanup.sessions === 0 && cleanup.passwords === 0);
  }
  record("owned_fictional_credentials_and_sessions_disabled");
  return { scope: "private-fictional-staff-csv", probeId: command.probeId, mode: command.mode, results, importedRows, applyMilliseconds, totalMilliseconds: Date.now() - start, cleanup };
}
