import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
  type OptimizerInput,
} from "../../../packages/contracts/optimizer-input.generated";
import type { PublicationDocument } from "./publication-contract";
import { requestedWork, type LeaveRecord } from "./leave-contract";
import { ProductError, requireManager } from "./product";
import { readLeave } from "./leave-intake";
import { publicationEvidence } from "./schedule-publications";
import { ensureFixedSource } from "./published-fixed";
import { loadSources, compileInput, sha256 } from "./input-snapshots";
import {
  cancellationCandidateCommand,
  type CancellationCandidateCommand,
} from "./cancellation-contract";
import type { InputDatabase } from "./input-versions";

type Interval = [number, number];
// Minutes remain exact, with half-open boundaries. No 30-minute rounding.
export function unionIntervals(intervals: number[][]): Interval[] {
  const merged: Interval[] = [];
  for (const [left, right] of [...intervals].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  )) {
    const last = merged.at(-1);
    if (last && left <= last[1]) last[1] = Math.max(last[1], right);
    else merged.push([left, right]);
  }
  return merged;
}
const includes = (ranges: number[][], minute: number) =>
  ranges.some(([a, b]) => a <= minute && minute < b);
function segments(
  start: number,
  end: number,
  allowed: (minute: number) => boolean,
): Interval[] {
  const result: Interval[] = [];
  for (let m = start; m < end; m++)
    if (allowed(m)) {
      const last = result.at(-1);
      if (last?.[1] === m) last[1] = m + 1;
      else result.push([m, m + 1]);
    }
  return result;
}

// This function only derives the requested cancellation. It never fills a newly
// freed event interval with an invented task or changes another person's work.
export function deriveCancellation(
  input: OptimizerInput,
  assignments: PublicationDocument["assignments"],
  request: Pick<LeaveRecord, "staffId" | "date" | "start" | "end">,
) {
  const data = optimizerInputSchema.parse(structuredClone(input));
  const candidate = optimizerAssignmentsSchema.parse(
    structuredClone(assignments),
  );
  const target = candidate.find(
    (a) => a.staffId === request.staffId && a.date === request.date,
  );
  if (!target?.shift) throw new ProductError("LEAVE_EMPTY_WORK", 400);
  const interval: Interval = [request.start, request.end],
    shift = target.shift;
  if (
    interval[0] < shift.start ||
    interval[1] > shift.end ||
    interval[0] >= interval[1]
  )
    throw new ProductError("LEAVE_PUBLICATION_CONFLICT");
  const cancelled = unionIntervals([...shift.cancelled, interval]);
  const remaining = (m: number) => !includes(cancelled, m);
  const work = (m: number) =>
    remaining(m) && !(shift.break && includes([shift.break], m));
  const previouslyWorked = segments(
    request.start,
    request.end,
    (m) =>
      !includes(shift.cancelled, m) &&
      !(shift.break && includes([shift.break], m)),
  );
  if (!previouslyWorked.length) throw new ProductError("LEAVE_EMPTY_WORK", 400);
  shift.cancelled = cancelled;
  shift.workedMinutes = segments(shift.start, shift.end, work).reduce(
    (sum, [a, b]) => sum + b - a,
    0,
  );
  const removed = data.events.filter(
    (e) =>
      e.date === request.date &&
      e.staffIds.includes(request.staffId) &&
      e.start < request.end &&
      request.start < e.end,
  );
  data.events = data.events.map((e) =>
    removed.some((r) => r.id === e.id)
      ? { ...e, staffIds: e.staffIds.filter((id) => id !== request.staffId) }
      : e,
  );
  const events = data.events.filter(
    (e) => e.date === request.date && e.staffIds.includes(request.staffId),
  );
  const active = (m: number) =>
    work(m) && !events.some((e) => e.start <= m && m < e.end);
  target.blocks = target.blocks.filter(
    (b) => segments(b.start, b.end, active).length > 0,
  );
  target.roleIntervals = (target.roleIntervals ?? []).flatMap((r) =>
    segments(r.start, r.end, active).map(([start, end]) => ({
      ...r,
      start,
      end,
    })),
  );
  data.published = data.published.map((a) =>
    a.staffId === request.staffId && a.date === request.date
      ? { ...a, shift: structuredClone(shift) }
      : a,
  );
  // Only retain the previously authorized portions which still exist. Split
  // intervals keep distinct stable IDs; no new unavailable time is authorized.
  const reservedIds = new Set(data.exceptions.map((e) => e.id));
  data.exceptions = data.exceptions.flatMap((e, exceptionIndex) =>
    e.staffId === request.staffId && e.date === request.date
      ? segments(e.start, e.end, remaining).map(([start, end], i) => {
          if (start === e.start && end === e.end) return e;
          let id: string,
            suffix = 0;
          do {
            id = `cancellation-remaining:${exceptionIndex}:${i}:${suffix++}`;
          } while (reservedIds.has(id));
          reservedIds.add(id);
          return { ...e, id, start, end };
        })
      : e,
  );
  return {
    input: optimizerInputSchema.parse(data),
    assignments: optimizerAssignmentsSchema.parse(candidate),
    removedParticipations: removed.map((e) => ({
      eventId: e.id,
      staffId: request.staffId,
      date: e.date,
      start: e.start,
      end: e.end,
    })),
  };
}

export async function buildCancellationCandidate(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  data: CancellationCandidateCommand,
) {
  const c = cancellationCandidateCommand.parse(data),
    db = env.DB;
  await requireManager(db, c.companyId, c.teamId, c.userId);
  const { record } = await readLeave(
    db,
    c.companyId,
    c.teamId,
    c.userId,
    c.requestId,
  );
  if (
    !["PENDING", "REPORTED"].includes(record.status) ||
    record.requestRevision !== c.expectedRequestRevision
  )
    throw new ProductError("LEAVE_VERSION_CONFLICT");
  const month = record.date.slice(0, 7);
  const head = await db
    .prepare(
      "SELECT publication_id,revision FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
    )
    .bind(c.companyId, c.teamId, month)
    .first<{ publication_id: string; revision: number }>();
  if (
    !head ||
    head.publication_id !== c.publicationId ||
    head.revision !== c.expectedPublicationRevision
  )
    throw new ProductError("LEAVE_PUBLICATION_CONFLICT");
  const evidence = await publicationEvidence(
    env,
    c.companyId,
    c.teamId,
    c.publicationId,
  );
  await ensureFixedSource(env, c.companyId, c.teamId, c.publicationId);
  const sources = await loadSources(db, c.companyId, c.teamId, month);
  if (sources.revision !== c.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  if (
    sources.publication?.id !== c.publicationId ||
    sources.publication.revision !== c.expectedPublicationRevision
  )
    throw new ProductError("LEAVE_PUBLICATION_CONFLICT");
  if (
    sources.fixed!.locks.some(
      (l) => l.staffId === record.staffId && l.date === record.date,
    )
  )
    throw new ProductError("LEAVE_FIXED_RELEASE_REQUIRED");
  const storedCalendar = await db
    .prepare("SELECT calendar_id FROM leave_record WHERE company_id=? AND id=?")
    .bind(c.companyId, c.requestId)
    .first<string>("calendar_id");
  if (sources.calendar.operation_id !== storedCalendar)
    throw new ProductError("LEAVE_CALENDAR_CONFLICT");
  const target = evidence.document.assignments.find(
    (a) => a.staffId === record.staffId && a.date === record.date,
  );
  const calendar = JSON.parse(sources.calendar.payload) as {
    halfDayDivider: number | null;
  };
  const interval = requestedWork(
    target?.shift ?? null,
    record.part,
    calendar.halfDayDivider,
  );
  if (!interval) throw new ProductError("LEAVE_EMPTY_WORK", 400);
  if (interval.start !== record.start || interval.end !== record.end)
    throw new ProductError("LEAVE_PUBLICATION_CONFLICT");
  const compiled = compileInput(
    c.companyId,
    c.teamId,
    month,
    c.operationId,
    sources,
    {
      locks: evidence.document.locks,
      exceptions: evidence.document.exceptions,
    },
  );
  const candidate = deriveCancellation(
    compiled.input,
    evidence.document.assignments,
    record,
  );
  const payload = {
    input: candidate.input,
    assignments: candidate.assignments,
  };
  const digest = await sha256(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  await requireManager(db, c.companyId, c.teamId, c.userId);
  return {
    command: c,
    record,
    evidence,
    ...candidate,
    lineage: compiled.lineage,
    planningId:sources.versions.find(v=>v.kind==='planning'&&v.entity_id===c.teamId)!.operation_id,
    candidateSha256: digest,
  };
}

export async function assertCancellationCurrent(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  candidate: Awaited<ReturnType<typeof buildCancellationCandidate>>,
) {
  const fresh = await buildCancellationCandidate(env, candidate.command);
  if (
    fresh.candidateSha256 !== candidate.candidateSha256 ||
    fresh.evidence.row.sha256 !== candidate.evidence.row.sha256
  )
    throw new ProductError("VERSION_CONFLICT");
}
