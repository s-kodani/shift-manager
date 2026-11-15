import { z } from "zod";
import { CsvError, parseCsv } from "./csv";
import { planning, storedTeamConfig } from "./input-contracts";
import { ProductError, requireManager } from "./product";
import {
  commitInput,
  inputReplay,
  requiredVersion,
  resolveVersion,
  validateResource,
  type InputDatabase,
  type ResourceTarget,
} from "./input-versions";
import { sha256 } from "./input-snapshots";
import {
  registrationDraft,
  registrationDraftGuard,
} from "./input-draft-context";
import {
  demandCsvApply,
  demandCsvCommand,
  demandCsvPreview,
  demandCsvReceipt,
  type DemandCsvPreview,
} from "./demand-csv-contract";

const columns = [
  "date",
  "start",
  "end",
  "task_id",
  "direct",
  "calculated",
] as const;
const key = (d: { date: string; start: number; taskId: string }) =>
  JSON.stringify([d.date, d.start, d.taskId]);
const hash = (v: unknown) =>
  sha256(new TextEncoder().encode(JSON.stringify(v)));
const time = (value: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(value))
    throw new Error("CSV_INVALID_TIME");
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
};
// Exact rational conversion. Never parseFloat/round, and bound BigInt inputs.
function count(value: string, scale: number): number | null {
  if (!value) return null;
  const decimal = value.match(/^(\d{1,20})(?:\.(\d{1,20}))?$/),
    fraction = value.match(/^(\d{1,20})\/(\d{1,20})$/);
  if (!decimal && !fraction) throw new Error("CSV_INVALID_NUMBER");
  const denominator = fraction
    ? BigInt(fraction[2])
    : 10n ** BigInt(decimal![2]?.length ?? 0);
  const numerator =
    BigInt(fraction ? fraction[1] : decimal![1] + (decimal![2] ?? "")) *
    BigInt(scale);
  if (!denominator || numerator % denominator)
    throw new Error("CSV_INVALID_PRECISION");
  const result = Number(numerator / denominator);
  if (!Number.isSafeInteger(result) || result > 5_000_000)
    throw new Error("CSV_NUMBER_OUT_OF_RANGE");
  return result;
}
type Environment = { DB: InputDatabase; INPUTS: R2Bucket };
export async function readDemandCsvReceipt(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  id: string,
  replayed = false,
) {
  await requireManager(db, company, team, user);
  const row = await db
    .prepare(
      `SELECT revision,imported_rows,rejected_rows,added,replaced,errors FROM demand_csv_receipt
    WHERE company_id=? AND operation_id=? AND team_id=?`,
    )
    .bind(company, id, team)
    .first<{
      revision: number;
      imported_rows: number;
      rejected_rows: number;
      added: number;
      replaced: number;
      errors: string;
    }>();
  if (!row) throw new ProductError("NOT_FOUND", 404);
  await requireManager(db, company, team, user);
  return demandCsvReceipt.parse({
    id,
    revision: row.revision,
    importedRows: row.imported_rows,
    rejectedRows: row.rejected_rows,
    added: row.added,
    replaced: row.replaced,
    errors: JSON.parse(row.errors),
    replayed,
  });
}
const target = (company: string, team: string): ResourceTarget => ({
  company,
  team,
  staff: null,
  kind: "planning",
  entity: team,
});
async function current(
  env: Environment,
  company: string,
  team: string,
  user: string,
  command: z.infer<typeof demandCsvCommand>,
) {
  await requireManager(env.DB, company, team, user);
  const revision = await env.DB.prepare(
    "SELECT revision FROM company WHERE id=?",
  )
    .bind(company)
    .first<number>("revision");
  if (revision !== command.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  const configRow = requiredVersion(
      await resolveVersion(env.DB, company, "team_config", team, command.month),
    ),
    planRow = await resolveVersion(
      env.DB,
      company,
      "planning",
      team,
      command.month,
    );
  return {
    configRow,
    planRow,
    config: storedTeamConfig.parse(JSON.parse(configRow.payload)),
    plan: planning.parse(
      planRow
        ? JSON.parse(planRow.payload)
        : { demand: [], events: [], roleRequirements: [] },
    ),
  };
}

export async function buildDemandCsvPreview(
  env: Environment,
  company: string,
  team: string,
  user: string,
  value: z.infer<typeof demandCsvCommand>,
) {
  const command = demandCsvCommand.parse(value);
  const context = await current(env, company, team, user, command);
  const records = parseCsv(command.csv),
    header = records.shift();
  if (!header) throw new ProductError("CSV_EMPTY", 400);
  const names = header.cells.map((c) => c.trim());
  if (
    names.length !== columns.length ||
    new Set(names).size !== columns.length ||
    columns.some((c) => !names.includes(c))
  )
    throw new CsvError("CSV_INVALID_HEADER", header.line, 1);
  if (!records.length) throw new ProductError("CSV_EMPTY_ROWS", 400);
  const index = Object.fromEntries(names.map((c, i) => [c, i]));
  const existing = new Map(context.plan.demand.map((d) => [key(d), d]));
  const identities: (string | null)[] = [];
  const rows: DemandCsvPreview["rows"] = records.map((record) => {
    const errors: DemandCsvPreview["rows"][number]["errors"] = [];
    identities.push(null);
    if (record.cells.length !== names.length)
      return {
        line: record.line,
        demand: null,
        action: null,
        errors: [{ column: "row", code: "CSV_COLUMN_COUNT" }],
      };
    const read = (name: (typeof columns)[number]) =>
      record.cells[index[name]].trim();
    const parse = <T>(column: string, fn: () => T): T | null => {
      try {
        return fn();
      } catch (e) {
        errors.push({
          column,
          code: e instanceof Error ? e.message : "INVALID_INPUT",
        });
        return null;
      }
    };
    const date = read("date"),
      taskId = read("task_id");
    const start = parse("start", () => time(read("start"))),
      end = parse("end", () => time(read("end")));
    if (!planning.shape.demand.element.shape.date.safeParse(date).success)
      errors.push({ column: "date", code: "CSV_INVALID_DATE" });
    else if (date.slice(0, 7) !== command.month)
      errors.push({ column: "date", code: "OUTSIDE_MONTH" });
    if (
      !context.config.tasks.some((t) => t.id === taskId && t.kind === "general")
    )
      errors.push({ column: "task_id", code: "INVALID_DEMAND_TASK" });
    if (start !== null)
      identities[identities.length - 1] = key({ date, start, taskId });
    if (
      start !== null &&
      end !== null &&
      (end - start !== context.config.slotMinutes ||
        start % context.config.slotMinutes)
    )
      errors.push({ column: "end", code: "INVALID_DEMAND_SLOT" });
    const direct = parse("direct", () =>
        count(read("direct"), context.config.capacityScale),
      ),
      calculated = parse("calculated", () =>
        count(read("calculated"), context.config.capacityScale),
      );
    if (
      direct === null &&
      calculated === null &&
      !errors.some((e) => ["direct", "calculated"].includes(e.column))
    )
      errors.push({ column: "direct/calculated", code: "DEMAND_UNSET" });
    if (errors.length)
      return { line: record.line, demand: null, action: null, errors };
    const demand = planning.shape.demand.element.parse({
      date,
      start,
      end,
      taskId,
      direct,
      calculated,
    });
    return {
      line: record.line,
      demand,
      action: existing.has(key(demand)) ? "REPLACE" : "ADD",
      errors,
    };
  });
  const frequency = new Map<string, number>();
  for (const identity of identities)
    if (identity) frequency.set(identity, (frequency.get(identity) ?? 0) + 1);
  rows.forEach((row, i) => {
    if (identities[i] && frequency.get(identities[i]!)! > 1) {
      row.errors.push({
        column: "date/start/task_id",
        code: "DUPLICATE_DEMAND",
      });
      row.demand = null;
      row.action = null;
    }
  });
  const merged = new Map(existing);
  for (const row of rows)
    if (row.demand) merged.set(key(row.demand), row.demand);
  const payload = planning.parse({
    ...context.plan,
    demand: [...merged.values()],
  });
  const t = target(company, team),
    draft = await registrationDraft(env.DB, env.INPUTS, t, user, command.month);
  await validateResource(env.DB, t, command.month, payload, draft);
  const csvSha256 = await sha256(new TextEncoder().encode(command.csv));
  const content = {
    month: command.month,
    inputRevision: command.expectedRevision,
    csvSha256,
    capacityScale: context.config.capacityScale,
    added: rows.filter((r) => r.action === "ADD").length,
    replaced: rows.filter((r) => r.action === "REPLACE").length,
    rows,
  };
  const previewSha256 = await hash({
    company,
    team,
    user,
    configVersion: context.configRow.operation_id,
    planningVersion: context.planRow?.operation_id ?? null,
    draft,
    content,
    payload,
  });
  // The preview is read-only. Reject changes during the reads/hash work.
  await requireManager(env.DB, company, team, user);
  const after = await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(company)
    .first<number>("revision");
  if (after !== command.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  return {
    preview: demandCsvPreview.parse({ ...content, previewSha256 }),
    payload,
    draft,
  };
}

export async function applyDemandCsv(
  env: Environment,
  company: string,
  team: string,
  user: string,
  value: z.infer<typeof demandCsvApply>,
) {
  const c = demandCsvApply.parse(value);
  await requireManager(env.DB, company, team, user);
  const csvSha256 = await sha256(new TextEncoder().encode(c.csv));
  const fingerprint = JSON.stringify({
    kind: "demand-csv",
    company,
    team,
    user,
    operationId: c.operationId,
    month: c.month,
    expectedRevision: c.expectedRevision,
    previewSha256: c.previewSha256,
    csvSha256,
  });
  const receipt = (replayed: boolean) =>
    readDemandCsvReceipt(env.DB, company, team, user, c.operationId, replayed);
  if (await inputReplay(env.DB, company, c.operationId, fingerprint))
    return receipt(true);
  try {
    const { preview, payload, draft } = await buildDemandCsvPreview(
      env,
      company,
      team,
      user,
      { month: c.month, expectedRevision: c.expectedRevision, csv: c.csv },
    );
    if (preview.previewSha256 !== c.previewSha256)
      throw new ProductError("CSV_PREVIEW_MISMATCH");
    const imported = preview.added + preview.replaced;
    if (!imported) throw new ProductError("CSV_NO_VALID_ROWS", 400);
    const t = target(company, team);
    const replayed = await commitInput(
      env.DB,
      t,
      user,
      c.operationId,
      c.expectedRevision,
      fingerprint,
      [
        env.DB.prepare(
          `INSERT INTO work_input_version(company_id,operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload)
      VALUES (?,?,?,NULL,'planning',?,?,?,?)`,
        ).bind(
          company,
          c.operationId,
          team,
          team,
          c.month,
          c.expectedRevision + 1,
          JSON.stringify(payload),
        ),
        registrationDraftGuard(env.DB, t, c.operationId, c.month, draft),
        env.DB.prepare(
          `INSERT INTO demand_csv_receipt(company_id,operation_id,team_id,actor_id,month,revision,csv_sha256,preview_sha256,imported_rows,rejected_rows,added,replaced,errors)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          company,
          c.operationId,
          team,
          user,
          c.month,
          c.expectedRevision + 1,
          csvSha256,
          c.previewSha256,
          imported,
          preview.rows.length - imported,
          preview.added,
          preview.replaced,
          JSON.stringify(
            preview.rows
              .filter((r) => r.errors.length)
              .map(({ line, errors }) => ({ line, errors })),
          ),
        ),
      ],
      [env.DB.prepare(`SELECT CASE WHEN EXISTS(
        SELECT 1 FROM demand_csv_receipt r
        JOIN input_operation o ON o.company_id=r.company_id AND o.id=r.operation_id
        JOIN work_input_version v ON v.company_id=o.company_id AND v.operation_id=o.id
        JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        JOIN company c ON c.id=o.company_id
        WHERE r.company_id=? AND r.operation_id=? AND r.team_id=? AND r.actor_id=?
          AND r.month=? AND r.revision=? AND r.csv_sha256=? AND r.preview_sha256=?
          AND o.fingerprint=? AND v.kind='planning' AND v.payload=?
          AND v.revision=r.revision AND a.kind='input:planning' AND a.actor_id=r.actor_id
          AND a.revision=r.revision AND c.revision=r.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS completed`)
        .bind(company,c.operationId,team,user,c.month,c.expectedRevision+1,csvSha256,c.previewSha256,fingerprint,JSON.stringify(payload))],
    );
    await requireManager(env.DB, company, team, user);
    return receipt(replayed);
  } catch (error) {
    // Another delivery of this exact operation may commit during preflight.
    // Reconcile that existing receipt rather than inventing a second operation.
    if (await inputReplay(env.DB, company, c.operationId, fingerprint))
      return receipt(true);
    throw error;
  }
}
