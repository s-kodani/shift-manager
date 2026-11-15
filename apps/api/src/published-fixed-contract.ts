import { z } from "zod";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";

export const fixedPart = z.enum(["pattern", "time", "break"]);
export const releasePublishedFixed = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    publicationId: z.string().uuid(),
    expectedPublicationRevision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    staffId: z.string().uuid(),
    date: optimizerInputSchema.shape.history.element.shape.date,
    parts: z
      .array(fixedPart)
      .min(1)
      .max(3)
      .refine((p) => new Set(p).size === p.length),
  })
  .strict();
export const publishedFixedState = z.object({
  publicationId: z.string().uuid(),
  publicationRevision: z.number().int().positive(),
  inputRevision: z.number().int().nonnegative(),
  locks: optimizerInputSchema.shape.locks,
  releases: z.array(
    z.object({
      id: z.string().uuid(),
      actorId: z.string().uuid(),
      staffId: z.string().uuid(),
      date: releasePublishedFixed.shape.date,
      parts: releasePublishedFixed.shape.parts,
      appliedRevision: z.number().int().positive(),
      recordedAt: z.number().int(),
    }),
  ),
});
