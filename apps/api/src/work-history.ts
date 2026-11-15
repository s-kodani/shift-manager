import { z } from "zod";
import { type InputDatabase, inputMonth } from "./input-versions";
import { ProductError, requireManager } from "./product";
import {
  historyCommand,
  historyWindow,
  requiredHistory,
} from "./history-contract";

export type HistorySource = {
  staffId: string;
  date: string;
  workedMinutes: number;
  evidence: string;
  operationId: string;
  revision: number;
  source?: 'manual' | 'published';
};
export function historyQuery(
  db: InputDatabase,
  company: string,
  team: string,
  month: string,
) {
  const w = historyWindow(month);
  return db
    .prepare(
      `SELECT staff_id AS staffId,date,worked_minutes AS workedMinutes,evidence,operation_id AS operationId,revision,source FROM (
 SELECT *,row_number() OVER(PARTITION BY staff_id,date ORDER BY priority DESC,revision DESC) AS rank FROM (
 SELECT staff_id,date,worked_minutes,evidence,operation_id,revision,'manual' AS source,0 AS priority FROM work_history_version WHERE company_id=? AND team_id=?
 UNION ALL
 SELECT a.staff_id,a.date,a.worked_minutes,'公開済み勤務版 '||p.id AS evidence,p.id,p.applied_revision,'published',1
 FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id
 JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id
 JOIN schedule_publication_assignment a ON a.company_id=p.company_id AND a.publication_id=p.id WHERE h.company_id=? AND h.team_id=?
 ) WHERE date>=? AND date<=? AND (date<? OR date>?)
 ) WHERE rank=1 ORDER BY staff_id,date`,
    )
    .bind(company, team, company, team, w.previousFrom, w.nextThrough, w.first, w.last);
}
export async function saveHistory(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof historyCommand>,
) {
  const c = historyCommand.parse(data);
  await requireManager(db, company, team, user);
  const fingerprint = JSON.stringify({ company, team, user, ...c });
  const replay = async () => {
    const old = await db
      .prepare(
        "SELECT fingerprint FROM work_history_operation WHERE company_id=? AND id=?",
      )
      .bind(company, c.operationId)
      .first<string>("fingerprint");
    if (old && old !== fingerprint)
      throw new ProductError("OPERATION_ID_CONFLICT");
    return !!old;
  };
  if (await replay())
    return {
      id: c.operationId,
      revision: c.expectedRevision + 1,
      replayed: true,
    };
  const w = historyWindow(c.month);
  if (
    c.records.some(
      (r) =>
        r.date < w.previousFrom ||
        r.date > w.nextThrough ||
        (r.date >= w.first && r.date <= w.last),
    )
  )
    throw new ProductError("HISTORY_OUTSIDE_BOUNDARY", 400);
  const staff = (
    await db
      .prepare("SELECT id FROM staff WHERE company_id=? AND team_id=?")
      .bind(company, team)
      .all<{ id: string }>()
  ).results;
  if (c.records.some((r) => !staff.some((s) => s.id === r.staffId)))
    throw new ProductError("UNKNOWN_STAFF", 400);
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO work_history_operation(company_id,id,team_id,actor_id,expected_revision,target_month,fingerprint,recorded_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          company,
          c.operationId,
          team,
          user,
          c.expectedRevision,
          c.month,
          fingerprint,
          Date.now(),
        ),
      ...c.records.map((r) =>
        db
          .prepare(
            "INSERT INTO work_history_version(company_id,operation_id,team_id,staff_id,date,worked_minutes,evidence,revision) VALUES (?,?,?,?,?,?,?,?)",
          )
          .bind(
            company,
            c.operationId,
            team,
            r.staffId,
            r.date,
            r.workedMinutes,
            r.evidence,
            c.expectedRevision + 1,
          ),
      ),
      db
        .prepare(
          "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'history:confirmed',?,?)",
        )
        .bind(company, c.operationId, user, c.expectedRevision + 1, Date.now()),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM work_history_operation o
        JOIN company c ON c.id=o.company_id JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        WHERE o.company_id=? AND o.id=? AND o.team_id=? AND o.actor_id=? AND o.target_month=?
          AND o.expected_revision=? AND o.fingerprint=? AND c.revision=o.expected_revision+1
          AND a.kind='history:confirmed' AND a.actor_id=o.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS history_saved`)
        .bind(company,c.operationId,team,user,c.month,c.expectedRevision,fingerprint),
      db.prepare(`WITH expected AS (
        SELECT json_extract(value,'$.staffId') staff_id,json_extract(value,'$.date') date,
          json_extract(value,'$.workedMinutes') worked_minutes,json_extract(value,'$.evidence') evidence FROM json_each(?)
      ),actual AS (SELECT staff_id,date,worked_minutes,evidence FROM work_history_version
        WHERE company_id=? AND operation_id=? AND team_id=? AND revision=?)
      SELECT CASE WHEN NOT EXISTS(SELECT * FROM expected EXCEPT SELECT * FROM actual)
        AND NOT EXISTS(SELECT * FROM actual EXCEPT SELECT * FROM expected)
        THEN 1 ELSE abs(-9223372036854775808) END AS records_saved`)
        .bind(JSON.stringify(c.records),company,c.operationId,team,c.expectedRevision+1),
    ]);
  } catch (error) {
    if (await replay()) {
      await requireManager(db, company, team, user);
      return {
        id: c.operationId,
        revision: c.expectedRevision + 1,
        replayed: true,
      };
    }
    if (String(error).includes("PUBLISHED_HISTORY_READ_ONLY"))
      throw new ProductError("PUBLISHED_HISTORY_READ_ONLY", 400);
    if (String(error).includes("HISTORY_FORBIDDEN"))
      throw new ProductError("FORBIDDEN", 403);
    if (String(error).includes("HISTORY_VERSION_CONFLICT"))
      throw new ProductError("VERSION_CONFLICT");
    if (String(error).includes("FOREIGN KEY constraint"))
      throw new ProductError("UNKNOWN_STAFF", 400);
    throw error;
  }
  return {
    id: c.operationId,
    revision: c.expectedRevision + 1,
    replayed: false,
  };
}
export async function readHistory(
  db: InputDatabase,
  bucket: R2Bucket,
  company: string,
  team: string,
  user: string,
  month: string,
) {
  inputMonth.parse(month);
  await requireManager(db, company, team, user);
  const { loadSources, compileInput } = await import("./input-snapshots");
  const { registrationDraft } = await import("./input-draft-context");
  const draft = await registrationDraft(
    db,
    bucket,
    { company, team, staff: null, kind: "planning", entity: team },
    user,
    month,
  );
  const sources = await loadSources(db, company, team, month),
    input = compileInput(
      company,
      team,
      month,
      crypto.randomUUID(),
      sources,
      draft.fixed,
    ).input;
  const records = sources.history ?? [],
    required = requiredHistory(input),
    known = new Set(records.map((r) => `${r.staffId}:${r.date}`));
  await requireManager(db, company, team, user);
  return {
    month,
    inputRevision: sources.revision,
    window: historyWindow(month),
    records,
    required,
    missing: required.filter((r) => !known.has(`${r.staffId}:${r.date}`)),
  };
}
