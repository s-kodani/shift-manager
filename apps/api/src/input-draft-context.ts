import type { OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import type { InputDatabase, ResourceTarget } from "./input-versions";
import { ProductError } from "./product";
import {
  ensureCurrentFixedSource,
  currentPublishedFixed,
  loadPublishedFixed,
} from "./published-fixed";

export type RegistrationDraft = {
  id: string | null;
  revision: number;
  fixed: Pick<OptimizerInput, "locks" | "exceptions">;
};

// The client cannot supply approved exceptions or the head used for validation.
// Even a stale input revision of a saved draft can supply explicit fixed facts;
// the new conditions are validated separately before the input is committed.
export async function registrationDraft(
  db: InputDatabase,
  bucket: R2Bucket | undefined,
  target: ResourceTarget,
  user: string,
  month: string,
  self = false,
): Promise<RegistrationDraft> {
  const publication = await db
    .prepare(
      "SELECT publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
    )
    .bind(target.company, target.team, month)
    .first<string>("publication_id");
  if (publication) {
    if (!bucket) throw new ProductError("PUBLISHED_FIXED_SOURCE_REQUIRED");
    await ensureCurrentFixedSource(
      { DB: db, INPUTS: bucket },
      target.company,
      target.team!,
      month,
    );
  }
  const head = await db
    .prepare(
      "SELECT revision,draft_id FROM schedule_draft_head WHERE company_id=? AND team_id=? AND month=?",
    )
    .bind(target.company, target.team, month)
    .first<{ revision: number; draft_id: string | null }>();
  if (!head?.draft_id)
    return { id: null, revision: 0, fixed: { locks: [], exceptions: [] } };
  if (!bucket) throw new ProductError("DRAFT_SOURCE_REQUIRED");
  const { readDraft, readOwnRegistrationDraft } = await import("./schedule-drafts");
  const { fixedDraftInput } = await import("./draft-recalculation");
  const saved = self ? await readOwnRegistrationDraft(
    { DB: db, INPUTS: bucket }, target.company, target.team!, user, head.draft_id,
  ) : await (async () => {
    const loaded = await readDraft({DB:db,INPUTS:bucket},target.company,target.team!,user,head.draft_id!);
    return {month:loaded.draft.month,inputRevision:loaded.draft.inputRevision,
      draftRevision:loaded.draft.draftRevision,superseded:loaded.superseded,fixed:fixedDraftInput(loaded.draft)};
  })();
  const fixed = saved.fixed;
  if (saved.superseded || saved.draftRevision !== head.revision)
    throw new ProductError("DRAFT_VERSION_CONFLICT");
  if (saved.month !== month)
    throw new Error("DRAFT_REGISTRATION_MONTH_MISMATCH");
  return {
    id: head.draft_id,
    revision: head.revision,
    fixed: publication
      ? currentPublishedFixed(
          await loadPublishedFixed(db, target.company, publication),
          fixed,
          saved.inputRevision,
        )
      : fixed,
  };
}

export function registrationDraftGuard(
  db: InputDatabase,
  target: ResourceTarget,
  id: string,
  month: string,
  draft: RegistrationDraft,
) {
  return db
    .prepare(
      "INSERT INTO input_registration_draft(company_id,operation_id,team_id,month,draft_id,draft_revision) VALUES (?,?,?,?,?,?)",
    )
    .bind(target.company, id, target.team, month, draft.id, draft.revision);
}
