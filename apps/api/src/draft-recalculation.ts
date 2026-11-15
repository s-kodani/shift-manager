import { z } from "zod";
import {
  type OptimizerInput,
  optimizerInputSchema,
  optimizerAssignmentsSchema,
} from "../../../packages/contracts/optimizer-input.generated";
import { readDraft } from "./schedule-drafts";
import {
  loadSources,
  compileInput,
  persistCompiledSnapshot,
  snapshotRow,
} from "./input-snapshots";
import { type InputDatabase, inputReplay } from "./input-versions";
import { mutation, ProductError, requireManager } from "./product";
import { ensureCurrentFixedSource } from "./published-fixed";
export const draftSnapshotCommand = mutation
  .extend({
    expectedDraftRevision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
export function fixedDraftInput(data: {
  assignments: unknown;
  locks: unknown;
  exceptions: unknown;
}): Pick<OptimizerInput, "locks" | "exceptions"> {
  const assignments = optimizerAssignmentsSchema.parse(data.assignments),
    locks = optimizerInputSchema.shape.locks.parse(data.locks),
    exceptions = optimizerInputSchema.shape.exceptions.parse(data.exceptions);
  const complete = (
    lock: OptimizerInput["locks"][number],
    e: OptimizerInput["exceptions"][number],
  ) => {
    const assignment = assignments.find(
      (a) => a.staffId === e.staffId && a.date === e.date,
    );
    const a = assignment?.shift,
      b = lock.shift;
    return (
      lock.staffId === e.staffId &&
      lock.date === e.date &&
      ["pattern", "time", "break"].every((p) =>
        lock.parts.includes(p as "pattern" | "time" | "break"),
      ) &&
      a &&
      b &&
      a.patternId === b.patternId &&
      a.start === b.start &&
      a.end === b.end &&
      a.breakKind === b.breakKind &&
      JSON.stringify(a.break) === JSON.stringify(b.break) &&
      e.start >= a.start &&
      e.end <= a.end
    );
  };
  return {
    locks,
    exceptions: exceptions.flatMap((e) => {
      const fixed = locks.find(
        (l) => (e.lockId === null || l.id === e.lockId) && complete(l, e),
      );
      return fixed ? [{ ...e, lockId: fixed.id }] : [];
    }),
  };
}
export async function createDraftSnapshot(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  user: string,
  id: string,
  data: z.infer<typeof draftSnapshotCommand>,
) {
  const c = draftSnapshotCommand.parse(data);
  await requireManager(env.DB, company, team, user);
  const fingerprint = JSON.stringify({
    company,
    team,
    user,
    draftId: id,
    ...c,
  });
  if (await inputReplay(env.DB, company, c.operationId, fingerprint))
    return {
      snapshot: await snapshotRow(env.DB, company, c.operationId),
      replayed: true,
    };
  const saved = await readDraft(env, company, team, user, id);
  if (saved.superseded || saved.draft.draftRevision !== c.expectedDraftRevision)
    throw new ProductError("DRAFT_VERSION_CONFLICT");
  await ensureCurrentFixedSource(env, company, team, saved.draft.month);
  const sources = await loadSources(env.DB, company, team, saved.draft.month);
  if (sources.revision !== c.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  const compiled = compileInput(
    company,
    team,
    saved.draft.month,
    c.operationId,
    sources,
    fixedDraftInput(saved.draft),
    { fixedRevision: saved.draft.inputRevision },
  );
  compiled.lineage.push({
    kind: "manual_draft",
    entity: team,
    version: id,
    revision: c.expectedDraftRevision,
  });
  return persistCompiledSnapshot(
    env.DB,
    env.INPUTS,
    company,
    team,
    user,
    { ...c, month: saved.draft.month },
    fingerprint,
    compiled,
    [
      env.DB.prepare(
        "INSERT INTO input_snapshot_draft(company_id,snapshot_id,draft_id,draft_revision) VALUES (?,?,?,?)",
      ).bind(company, c.operationId, id, c.expectedDraftRevision),
    ],
  );
}
