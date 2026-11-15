import type { InputDatabase } from "./input-versions";
// A later manual edit/fix/unfix is distinct from an input revision change.
export async function snapshotDraftStale(
  db: InputDatabase,
  company: string,
  snapshot: string,
) {
  const ref = await db
    .prepare(
      `SELECT r.draft_id,r.draft_revision,h.draft_id AS current_id,h.revision AS current_revision
  FROM input_snapshot s LEFT JOIN input_snapshot_draft r ON s.company_id=r.company_id AND s.id=r.snapshot_id
  LEFT JOIN schedule_draft_head h ON h.company_id=s.company_id AND h.team_id=s.team_id AND h.month=s.month
  WHERE s.company_id=? AND s.id=?`,
    )
    .bind(company, snapshot)
    .first<{
      draft_id: string | null;
      draft_revision: number | null;
      current_id: string | null;
      current_revision: number | null;
    }>();
  return (
    !!ref &&
    (ref.draft_id !== ref.current_id ||
      ref.draft_revision !== ref.current_revision)
  );
}
export async function snapshotDraftSource(
  db: InputDatabase,
  company: string,
  snapshot: string,
) {
  const row = await db
    .prepare(
      "SELECT draft_id,draft_revision FROM input_snapshot_draft WHERE company_id=? AND snapshot_id=?",
    )
    .bind(company, snapshot)
    .first<{ draft_id: string; draft_revision: number }>();
  return row
    ? { draftId: row.draft_id, draftRevision: row.draft_revision }
    : null;
}
