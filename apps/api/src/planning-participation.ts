import { z } from "zod";
import { planning } from "./input-contracts";
import type { InputDatabase, VersionRow } from "./input-versions";
export const participationRemoval = z.object({
  operationId: z.string().uuid(),
  planningId: z.string().uuid(),
  eventId: z.string(),
  staffId: z.string().uuid(),
  date: z.string(),
  start: z.number().int(),
  end: z.number().int(),
  revision: z.number().int().positive(),
});
export type ParticipationRemoval = z.infer<typeof participationRemoval>;
export async function loadParticipationRemovals(
  db: InputDatabase,
  company: string,
  team: string,
  month: string,
) {
  const rows = await db
    .prepare(
      `SELECT r.operation_id AS operationId,r.planning_id AS planningId,r.event_id AS eventId,r.staff_id AS staffId,r.date,r.start,r.end,o.applied_revision AS revision
 FROM planning_participation_removal r JOIN leave_cancellation_operation o ON o.company_id=r.company_id AND o.id=r.operation_id
 JOIN schedule_publication_commit c ON c.company_id=o.company_id AND c.publication_id=o.id WHERE o.company_id=? AND o.team_id=? AND substr(r.date,1,7)=? ORDER BY o.applied_revision,r.event_id,r.staff_id`,
    )
    .bind(company, team, month)
    .all();
  return z.array(participationRemoval).parse(rows.results);
}
// Keep the stored plan immutable. Only committed removals for this exact base
// version affect effective registrations; later planning saves are new sources.
export function effectivePlanning(
  row: VersionRow,
  removals: ParticipationRemoval[],
): VersionRow {
  if (row.kind !== "planning") return row;
  const matching = removals.filter((r) => r.planningId === row.operation_id);
  if (!matching.length) return row;
  const plan = planning.parse(JSON.parse(row.payload));
  return {
    ...row,
    payload: JSON.stringify({
      ...plan,
      events: plan.events.map((e) => ({
        ...e,
        staffIds: e.staffIds.filter(
          (id) =>
            !matching.some(
              (r) =>
                r.eventId === e.id &&
                r.staffId === id &&
                r.date === e.date &&
                r.start === e.start &&
                r.end === e.end,
            ),
        ),
      })),
    }),
  };
}
