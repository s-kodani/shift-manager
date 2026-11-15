import { z } from "zod";
import { publicationValidation } from "./checker-contract";
const uuid = z.string().uuid();
const revision = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
export const cancellationCheckCommand = z
  .object({
    operationId: uuid,
    expectedRevision: revision,
    expectedRequestRevision: revision.refine((n) => n > 0),
    publicationId: uuid,
    expectedPublicationRevision: revision.refine((n) => n > 0),
  })
  .strict();
export const cancellationCandidateCommand = cancellationCheckCommand
  .extend({
    companyId: uuid,
    teamId: uuid,
    userId: uuid,
    requestId: uuid,
  })
  .strict();
export type CancellationCandidateCommand = z.infer<
  typeof cancellationCandidateCommand
>;
export const cancellationCheckResult = z
  .object({
    operationId: uuid,
    requestId: uuid,
    requestRevision: revision,
    publicationId: uuid,
    publicationRevision: revision,
    inputRevision: revision,
    candidateSha256: z.string().regex(/^[a-f0-9]{64}$/),
    publicationSha256: z.string().regex(/^[a-f0-9]{64}$/),
    capacityScale: z.number().int().positive(),
    validation: publicationValidation,
    removedParticipations: z.array(
      z.object({
        eventId: z.string(),
        staffId: uuid,
        date: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      }),
    ),
    approval: z.literal("NOT_COMMITTED"),
  })
  .strict();
export type CancellationCheckResult = z.infer<typeof cancellationCheckResult>;
export const cancellationCommitCommand = cancellationCheckCommand
  .extend({ acknowledgeShortage: z.boolean() })
  .strict();
export const cancellationCommitResult = z
  .object({
    operationId: uuid,
    requestId: uuid,
    requestRevision: revision,
    status: z.enum(["APPROVED", "CANCELLATION_CONFIRMED"]),
    publicationId: uuid,
    publicationRevision: revision,
    revision,
    replayed: z.boolean(),
  })
  .strict();
export type CancellationCommitCommand = z.infer<
  typeof cancellationCommitCommand
>;
export const cancellationInspection = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z
    .object({ found: z.literal(true), result: cancellationCommitResult })
    .strict(),
]);

// RPC serializes Errors without preserving the ProductError prototype. Carry
// known business failures explicitly; process/transport failures still reject.
export const cancellationRpcResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: cancellationCheckResult }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.string().min(1).max(128),
      status: z.union([
        z.literal(400),
        z.literal(403),
        z.literal(404),
        z.literal(409),
      ]),
    })
    .strict(),
]);
