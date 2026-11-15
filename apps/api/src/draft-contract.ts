import { z } from "zod";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../../packages/contracts/optimizer-input.generated";
import { mutation } from "./product";

export const draftCommand = mutation
  .extend({
    sourceJobId: z.string().uuid(),
    expectedDraftRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    assignments: optimizerAssignmentsSchema,
    locks: optimizerInputSchema.shape.locks,
    exceptions: optimizerInputSchema.shape.exceptions,
  })
  .strict();
export const candidateCommand = draftCommand
  .pick({ assignments: true, locks: true, exceptions: true })
  .extend({
    companyId: z.string().uuid(),
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    snapshotId: z.string().uuid(),
  })
  .strict();
export type CandidateCommand = z.infer<typeof candidateCommand>;
export { draftValidation } from "./checker-contract";
import { draftValidation } from "./checker-contract";
export const candidateResult = z
  .object({
    snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    validation: draftValidation,
  })
  .strict();
export type CandidateResult = z.infer<typeof candidateResult>;
