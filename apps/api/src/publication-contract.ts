import { z } from "zod";
import { mutation } from "./product";
import { publicationValidation } from "./checker-contract";
export { publicationValidation } from "./checker-contract";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../../packages/contracts/optimizer-input.generated";

export const publicationCommand = mutation
  .extend({
    expectedDraftRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    expectedPublicationRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    source: z
      .object({ kind: z.enum(["job", "draft"]), id: z.string().uuid() })
      .strict(),
    acknowledgeShortage: z.boolean(),
  })
  .strict();
export const publicationDocument = z
  .object({
    publicationId: z.string().uuid(),
    tenantId: z.string().uuid(),
    teamId: z.string().uuid(),
    month: optimizerInputSchema.shape.month,
    actorId: z.string().uuid(),
    source: publicationCommand.shape.source,
    sourceJobId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputRevision: z.number().int().nonnegative(),
    appliedRevision: z.number().int().nonnegative(),
    publicationRevision: z.number().int().positive(),
    expectedDraftRevision: publicationCommand.shape.expectedDraftRevision,
    assignments: optimizerAssignmentsSchema,
    locks: optimizerInputSchema.shape.locks,
    exceptions: optimizerInputSchema.shape.exceptions,
    validation: publicationValidation,
    shortageAcknowledged: z.boolean(),
    recordedAt: z.number().int().nonnegative(),
    publication: z.literal("PUBLISHED"),
    cancellation: z
      .object({
        operationId: z.string().uuid(),
        requestId: z.string().uuid(),
        parentPublicationId: z.string().uuid(),
        parentPublicationSha256: z.string().regex(/^[a-f0-9]{64}$/),
        candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
        planningId: z.string().uuid(),
        input: optimizerInputSchema,
        lineage: z.array(
          z.object({
            kind: z.string(),
            entity: z.string(),
            version: z.string(),
            revision: z.number().int().nonnegative(),
            effectiveFrom: z.string().optional(),
          }),
        ),
        removedParticipations: z.array(
          z.object({
            eventId: z.string(),
            staffId: z.string().uuid(),
            date: z.string(),
            start: z.number().int(),
            end: z.number().int(),
          }),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PublicationDocument = z.infer<typeof publicationDocument>;
