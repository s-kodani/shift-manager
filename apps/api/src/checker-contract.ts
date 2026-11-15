import { z } from "zod";
export const draftValidation = z
  .object({
    scope: z.literal("multi-task-v1"),
    status: z.enum(["VERIFIED", "HISTORY_UNVERIFIED", "INVALID"]),
    violations: z.array(z.string()),
  })
  .passthrough();
const amount = z.number().finite().nonnegative();
// Publication requires the full checker certificate, including shortage metrics.
// A missing metric must never silently become zero or authorize publication.
export const publicationValidation = draftValidation.extend({
  missingHistory: z.array(z.string()),
  generalShortage: amount,
  roleSameShortage: amount,
  roleRequirements: z.array(
    z.object({ id: z.string(), shortagePersonMinutes: amount }).passthrough(),
  ),
});
