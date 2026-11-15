import { z } from "zod";
import { ProductError, resolveCalendarSettings, teamRole } from "./product";
import { inputMonth, type InputDatabase } from "./input-versions";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
import {
  leaveSubmission,
  leaveRejection,
  leaveRecord,
  leaveCursor,
  requestedWork,
} from "./leave-contract";

type Database = InputDatabase;
export async function leaveAccess(
  db: Database,
  company: string,
  team: string,
  user: string,
) {
  const live = await db
    .prepare(
      "SELECT enabled,must_change_password FROM access_state WHERE user_id=?",
    )
    .bind(user)
    .first<{ enabled: number; must_change_password: number }>();
  const role = await teamRole(db, company, team, user);
  if (!live?.enabled || live.must_change_password || !role)
    throw new ProductError("FORBIDDEN", 403);
  const staff = await db
    .prepare(
      `SELECT s.id FROM staff s JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
    WHERE s.company_id=? AND s.team_id=? AND s.user_id=?`,
    )
    .bind(company, team, user)
    .first<string>("id");
  return { manager: role !== "staff", staff: staff ?? null };
}
async function subjectAccess(
  db: Database,
  company: string,
  team: string,
  user: string,
  staff: string,
  fact: boolean,
) {
  const access = await leaveAccess(db, company, team, user);
  if (fact ? !access.manager : access.staff !== staff)
    throw new ProductError("FORBIDDEN", 403);
  return access;
}
async function replay(
  db: Database,
  company: string,
  id: string,
  fingerprint: string,
) {
  const rows = await db
    .prepare(
      `SELECT fingerprint FROM leave_record WHERE company_id=? AND id=? UNION ALL
    SELECT fingerprint FROM leave_rejection WHERE company_id=? AND id=?`,
    )
    .bind(company, id, company, id)
    .all<{ fingerprint: string }>();
  if (rows.results.some((r) => r.fingerprint !== fingerprint))
    throw new ProductError("OPERATION_ID_CONFLICT");
  return rows.results.length > 0;
}
function mapError(error: unknown): never {
  const message = String(error);
  for (const code of [
    "LEAVE_FORBIDDEN",
    "LEAVE_PUBLICATION_CONFLICT",
    "LEAVE_CALENDAR_CONFLICT",
    "LEAVE_VERSION_CONFLICT",
    "LEAVE_OVERLAP",
    "LEAVE_EMPTY_WORK",
    "LEAVE_FUTURE_FACT",
  ])
    if (message.includes(code))
      throw new ProductError(
        code,
        code === "LEAVE_FORBIDDEN"
          ? 403
          : ["LEAVE_EMPTY_WORK", "LEAVE_FUTURE_FACT"].includes(code)
            ? 400
            : 409,
      );
  if (message.includes("UNIQUE constraint"))
    throw new ProductError("OPERATION_ID_CONFLICT");
  throw error;
}
export async function submitLeave(
  db: Database,
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof leaveSubmission>,
) {
  const c = leaveSubmission.parse(data),
    fact = c.kind === "ABSENCE_FACT";
  await subjectAccess(db, company, team, user, c.staffId, fact);
  const fingerprint = JSON.stringify({ company, team, user, input: c });
  const response = (replayed: boolean) => ({
    requestId: c.operationId,
    requestRevision: 1,
    status: fact ? ("REPORTED" as const) : ("PENDING" as const),
    replayed,
  });
  if (await replay(db, company, c.operationId, fingerprint)) {
    await subjectAccess(db, company, team, user, c.staffId, fact);
    return response(true);
  }
  const assignment = await db
    .prepare(
      `SELECT a.shift FROM schedule_publication_head h
    JOIN schedule_publication_commit v ON v.company_id=h.company_id AND v.publication_id=h.publication_id
    JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id
    WHERE h.company_id=? AND h.team_id=? AND h.month=? AND h.publication_id=? AND h.revision=? AND a.staff_id=? AND a.date=? AND a.worked_minutes>0`,
    )
    .bind(
      company,
      team,
      c.date.slice(0, 7),
      c.publicationId,
      c.expectedPublicationRevision,
      c.staffId,
      c.date,
    )
    .first<{ shift: string }>();
  if (!assignment) throw new ProductError("LEAVE_PUBLICATION_CONFLICT");
  const calendar = await resolveCalendarSettings(
    db,
    company,
    c.date.slice(0, 7),
  );
  if (!calendar) throw new ProductError("LEAVE_CALENDAR_CONFLICT");
  const shift = optimizerInputSchema.shape.published.element.shape.shift.parse(
    JSON.parse(assignment.shift),
  );
  const interval = requestedWork(
    shift,
    c.part,
    calendar.settings.halfDayDivider,
  );
  if (!interval) throw new ProductError("LEAVE_EMPTY_WORK", 400);
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO leave_record(company_id,id,team_id,staff_id,actor_id,kind,date,part,reason,publication_id,publication_revision,calendar_id,start,end,fingerprint,recorded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          company,
          c.operationId,
          team,
          c.staffId,
          user,
          c.kind,
          c.date,
          c.part,
          c.reason,
          c.publicationId,
          c.expectedPublicationRevision,
          calendar.id,
          interval.start,
          interval.end,
          fingerprint,
          now,
        ),
      db
        .prepare(
          "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) SELECT ?,?,?,'leave_intake',revision,? FROM company WHERE id=?",
        )
        .bind(company, c.operationId, user, now, company),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM leave_record r
        JOIN leave_head h ON h.company_id=r.company_id AND h.request_id=r.id
        JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
        JOIN leave_notice n ON n.company_id=r.company_id AND n.event_id=r.id AND n.request_id=r.id AND n.user_id=s.user_id
        JOIN product_audit a ON a.company_id=r.company_id AND a.id=r.id JOIN company c ON c.id=r.company_id
        WHERE r.company_id=? AND r.id=? AND r.team_id=? AND r.staff_id=? AND r.actor_id=? AND r.kind=?
          AND r.date=? AND r.part=? AND r.reason=? AND r.fingerprint=? AND r.publication_id=? AND r.publication_revision=?
          AND r.calendar_id=? AND r.start=? AND r.end=? AND r.recorded_at=?
          AND h.revision=1 AND h.decision_id IS NULL AND h.status=CASE WHEN r.kind='ABSENCE_FACT' THEN 'REPORTED' ELSE 'PENDING' END
          AND n.kind='RECEIVED' AND n.recorded_at=r.recorded_at AND a.kind='leave_intake' AND a.actor_id=r.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS intake_saved`)
        .bind(company,c.operationId,team,c.staffId,user,c.kind,c.date,c.part,c.reason,fingerprint,c.publicationId,c.expectedPublicationRevision,calendar.id,interval.start,interval.end,now),
    ]);
  } catch (error) {
    if (await replay(db, company, c.operationId, fingerprint)) {
      await subjectAccess(db, company, team, user, c.staffId, fact);
      return response(true);
    }
    mapError(error);
  }
  await subjectAccess(db, company, team, user, c.staffId, fact);
  return response(false);
}
const rowSql = `SELECT r.id,r.staff_id AS staffId,s.name AS staffName,s.staff_number AS staffNumber,r.date,r.kind,r.part,r.reason,
 r.publication_id AS publicationId,r.publication_revision AS publicationRevision,r.start,r.end,r.recorded_at AS recordedAt,
 h.status,h.revision AS requestRevision,d.reason AS decisionReason,COALESCE(d.recorded_at,x.recorded_at) AS decidedAt
 FROM leave_record r JOIN staff s ON s.company_id=r.company_id AND s.team_id=r.team_id AND s.id=r.staff_id
 JOIN leave_effective_head h ON h.company_id=r.company_id AND h.request_id=r.id
 LEFT JOIN leave_rejection d ON d.company_id=h.company_id AND d.id=h.decision_id
 LEFT JOIN leave_cancellation_operation x ON x.company_id=h.company_id AND x.id=h.decision_id`;
export async function readLeave(
  db: Database,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  const access = await leaveAccess(db, company, team, user);
  const row = await db
    .prepare(
      rowSql +
        " WHERE r.company_id=? AND r.team_id=? AND r.id=? AND (?=1 OR r.staff_id=?)",
    )
    .bind(company, team, id, Number(access.manager), access.staff)
    .first();
  if (!row) throw new ProductError("NOT_FOUND", 404);
  const after = await leaveAccess(db, company, team, user);
  const record = leaveRecord.parse(row);
  if (!after.manager && after.staff !== record.staffId)
    throw new ProductError("FORBIDDEN", 403);
  return { record };
}
export async function listLeaves(
  db: Database,
  company: string,
  team: string,
  user: string,
  month: string,
  cursor?: z.infer<typeof leaveCursor>,
) {
  inputMonth.parse(month);
  const access = await leaveAccess(db, company, team, user),
    c = cursor ? leaveCursor.parse(cursor) : null;
  const rows = await db
    .prepare(
      rowSql +
        ` WHERE r.company_id=? AND r.team_id=? AND substr(r.date,1,7)=? AND (?=1 OR r.staff_id=?)
   AND (? IS NULL OR r.recorded_at<? OR (r.recorded_at=? AND r.id<?)) ORDER BY r.recorded_at DESC,r.id DESC LIMIT 51`,
    )
    .bind(
      company,
      team,
      month,
      Number(access.manager),
      access.staff,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.id ?? null,
    )
    .all();
  const after = await leaveAccess(db, company, team, user);
  const parsed = z.array(leaveRecord).parse(rows.results);
  if (!after.manager && parsed.some((r) => r.staffId !== after.staff))
    throw new ProductError("FORBIDDEN", 403);
  const records = parsed.slice(0, 50),
    last = records.at(-1);
  return {
    records,
    nextCursor:
      parsed.length > 50 && last
        ? { recordedAt: last.recordedAt, id: last.id }
        : null,
  };
}
export async function rejectLeave(
  db: Database,
  company: string,
  team: string,
  user: string,
  id: string,
  data: z.infer<typeof leaveRejection>,
) {
  const c = leaveRejection.parse(data);
  if (!(await leaveAccess(db, company, team, user)).manager)
    throw new ProductError("FORBIDDEN", 403);
  const { record } = await readLeave(db, company, team, user, id);
  const fingerprint = JSON.stringify({ company, team, user, id, input: c }),
    response = (replayed: boolean) => ({
      requestId: id,
      requestRevision: c.expectedRequestRevision + 1,
      status: "REJECTED" as const,
      replayed,
    });
  if (await replay(db, company, c.operationId, fingerprint)) {
    if (!(await leaveAccess(db, company, team, user)).manager)
      throw new ProductError("FORBIDDEN", 403);
    return response(true);
  }
  if (
    record.status !== "PENDING" ||
    record.requestRevision !== c.expectedRequestRevision
  )
    throw new ProductError("LEAVE_VERSION_CONFLICT");
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO leave_rejection(company_id,id,request_id,actor_id,expected_revision,reason,fingerprint,recorded_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          company,
          c.operationId,
          id,
          user,
          c.expectedRequestRevision,
          c.reason,
          fingerprint,
          now,
        ),
      db
        .prepare(
          "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) SELECT ?,?,?,'leave_rejection',revision,? FROM company WHERE id=?",
        )
        .bind(company, c.operationId, user, now, company),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM leave_rejection d
        JOIN leave_record r ON r.company_id=d.company_id AND r.id=d.request_id
        JOIN leave_head h ON h.company_id=r.company_id AND h.request_id=r.id
        JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
        JOIN leave_notice n ON n.company_id=d.company_id AND n.event_id=d.id AND n.request_id=r.id AND n.user_id=s.user_id
        JOIN product_audit a ON a.company_id=d.company_id AND a.id=d.id JOIN company c ON c.id=d.company_id
        WHERE d.company_id=? AND d.id=? AND d.request_id=? AND r.team_id=? AND d.actor_id=?
          AND d.expected_revision=? AND d.reason=? AND d.fingerprint=? AND d.recorded_at=?
          AND h.decision_id=d.id AND h.status='REJECTED' AND h.revision=d.expected_revision+1
          AND n.kind='REJECTED' AND n.recorded_at=d.recorded_at AND a.kind='leave_rejection' AND a.actor_id=d.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS rejection_saved`)
        .bind(company,c.operationId,id,team,user,c.expectedRequestRevision,c.reason,fingerprint,now),
    ]);
  } catch (error) {
    if (await replay(db, company, c.operationId, fingerprint)) {
      if (!(await leaveAccess(db, company, team, user)).manager)
        throw new ProductError("FORBIDDEN", 403);
      return response(true);
    }
    mapError(error);
  }
  if (!(await leaveAccess(db, company, team, user)).manager)
    throw new ProductError("FORBIDDEN", 403);
  return response(false);
}
export async function leaveIntakeContext(
  db: Database,
  company: string,
  team: string,
  user: string,
  month: string,
) {
  inputMonth.parse(month);
  const access = await leaveAccess(db, company, team, user);
  const results = await db.batch([
    db
      .prepare(
        "SELECT publication_id AS id,revision FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
      )
      .bind(company, team, month),
    db
      .prepare(
        `SELECT s.id,s.name,s.staff_number AS staffNumber FROM staff s JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
      WHERE s.company_id=? AND s.team_id=? AND (?=1 OR s.id=?) ORDER BY s.staff_number`,
      )
      .bind(company, team, Number(access.manager), access.staff),
    db
      .prepare(
        `SELECT a.staff_id AS staffId,a.date,a.shift FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id
      JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id
      WHERE h.company_id=? AND h.team_id=? AND h.month=? AND a.worked_minutes>0 AND (?=1 OR a.staff_id=?) ORDER BY a.staff_id,a.date`,
      )
      .bind(company, team, month, Number(access.manager), access.staff),
    db
      .prepare(
        `SELECT payload FROM calendar_settings_version WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,revision DESC LIMIT 1`,
      )
      .bind(company, month),
  ]);
  const head = z
    .object({ id: z.string().uuid().nullable(), revision: z.number().int() })
    .nullable()
    .parse(results[0].results[0] ?? null);
  const staff = z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        staffNumber: z.string(),
      }),
    )
    .parse(results[1].results);
  const assignments = results[2].results.map((r) => {
    const row = z
      .object({
        staffId: z.string().uuid(),
        date: z.string(),
        shift: z.string(),
      })
      .parse(r);
    return optimizerInputSchema.shape.published.element.parse({
      ...row,
      shift: JSON.parse(row.shift),
    });
  });
  const after = await leaveAccess(db, company, team, user);
  if (
    !after.manager &&
    (staff.some((s) => s.id !== after.staff) ||
      assignments.some((a) => a.staffId !== after.staff))
  )
    throw new ProductError("FORBIDDEN", 403);
  const calendar = results[3].results[0];
  const divider = calendar
    ? z
        .object({
          halfDayDivider: z.number().int().min(30).max(1410).multipleOf(30),
        })
        .parse(
          JSON.parse(z.object({ payload: z.string() }).parse(calendar).payload),
        ).halfDayDivider
    : null;
  return {
    publicationId: head?.id ?? null,
    publicationRevision: head?.revision ?? 0,
    staff,
    assignments,
    halfDayDivider: divider,
  };
}
export async function leaveNotices(
  db: Database,
  company: string,
  team: string,
  user: string,
  cursor?: z.infer<typeof leaveCursor>,
) {
  await leaveAccess(db, company, team, user);
  const c = cursor ? leaveCursor.parse(cursor) : null;
  const rows = await db
    .prepare(
      `SELECT n.event_id AS id,n.request_id AS requestId,n.kind,n.recorded_at AS recordedAt,n.read_at AS readAt,r.date,r.part,r.kind AS requestKind,d.reason AS decisionReason
    FROM leave_all_notice n JOIN leave_record r ON r.company_id=n.company_id AND r.id=n.request_id
    JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
    JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
    LEFT JOIN leave_rejection d ON d.company_id=n.company_id AND d.id=n.event_id
    WHERE n.company_id=? AND r.team_id=? AND n.user_id=? AND s.user_id=?
     AND (? IS NULL OR n.recorded_at<? OR (n.recorded_at=? AND n.event_id<?)) ORDER BY n.recorded_at DESC,n.event_id DESC LIMIT 51`,
    )
    .bind(
      company,
      team,
      user,
      user,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.recordedAt ?? null,
      c?.id ?? null,
    )
    .all<{ id: string; recordedAt: number; kind:string }>();
  await leaveAccess(db, company, team, user);
  const notices = rows.results.slice(0, 50),
    last = notices.at(-1);
  return {
    notices,
    nextCursor:
      rows.results.length > 50 && last
        ? { recordedAt: last.recordedAt, id: last.id }
        : null,
  };
}
export async function readLeaveNotice(
  db: Database,
  company: string,
  team: string,
  user: string,
  id: string,
) {
  await leaveAccess(db, company, team, user);
  const updates=await db.batch(['leave_notice','leave_cancellation_notice'].map(table=>db.prepare(
      `UPDATE ${table} SET read_at=max(?,recorded_at) WHERE company_id=? AND event_id=? AND user_id=? AND read_at IS NULL
    AND EXISTS(SELECT 1 FROM leave_record r JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
     JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
     JOIN access_state a ON a.user_id=s.user_id WHERE r.company_id=${table}.company_id AND r.id=${table}.request_id AND r.team_id=? AND s.user_id=? AND a.enabled=1 AND a.must_change_password=0)`,
    )
    .bind(Date.now(), company, id, user, team, user)));
  await leaveAccess(db, company, team, user);
  const found = await db
    .prepare(
      `SELECT n.read_at AS readAt FROM leave_all_notice n JOIN leave_record r ON r.company_id=n.company_id AND r.id=n.request_id WHERE n.company_id=? AND n.event_id=? AND n.user_id=? AND r.team_id=?`,
    )
    .bind(company, id, user, team)
    .first<{readAt:number|null}>();
  if (!found) throw new ProductError("NOT_FOUND", 404);
  if (found.readAt===null) throw new ProductError('NOTICE_UPDATE_FAILED',503);
  return { read: true, changed: updates.some(r=>r.meta.changes>0) };
}
