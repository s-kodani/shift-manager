import { z } from "zod";
import { draftValidation, publicationValidation } from "./checker-contract";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
export const revalidationMessage = z
  .object({
    version: z.literal(1),
    kind: z.literal("publication-revalidation"),
    companyId: z.string().uuid(),
    teamId: z.string().uuid(),
    requestId: z.string().regex(/^[a-f0-9]{32}$/),
  })
  .strict();
export type RevalidationMessage = z.infer<typeof revalidationMessage>;
export const revalidationRetry = z
  .object({
    operationId: z.string().uuid(),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    expectedAttempt: z.number().int().positive(),
    requiredRevision: z.number().int().nonnegative(),
  })
  .strict();
export const revalidationStatus = z.enum([
  "VERIFIED",
  "HISTORY_UNVERIFIED",
  "INVALID",
  "INPUT_INVALID",
  "FAILED",
  "PROCESS_INTERRUPTED",
]);
// Early shape rejection may omit metrics; complete VERIFIED/HISTORY_UNVERIFIED
// certificates are required. Missing shortage values are never treated as zero.
export const revalidationCertificate = z
  .object({
    schemaVersion: z.literal("publication-revalidation-v1"),
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    teamId: z.string().uuid(),
    publicationId: z.string().uuid(),
    month: optimizerInputSchema.shape.month,
    requestId: revalidationMessage.shape.requestId,
    attempt: z.number().int().positive(),
    requiredRevision: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    inputSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    publicationSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    status: revalidationStatus,
    validation: draftValidation.nullable(),
    failureCode: z.string().nullable(),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (["VERIFIED", "HISTORY_UNVERIFIED", "INVALID"].includes(c.status)) {
      if (
        !c.validation ||
        c.validation.status !== c.status ||
        !c.inputSha256 ||
        !c.publicationSha256
      )
        ctx.addIssue({
          code: "custom",
          message: "Certificate missing checker/input identity",
        });
      if (
        c.status !== "INVALID" &&
        !publicationValidation.safeParse(c.validation).success
      )
        ctx.addIssue({ code: "custom", message: "Incomplete checker metrics" });
      if (
        c.status === "VERIFIED" &&
        (c.validation?.violations.length ||
          (c.validation?.missingHistory as unknown[])?.length)
      )
        ctx.addIssue({
          code: "custom",
          message: "Contradictory verified certificate",
        });
      if (c.status === "INVALID" && !c.validation?.violations.length)
        ctx.addIssue({
          code: "custom",
          message: "Invalid certificate has no violations",
        });
      if (
        c.status === "HISTORY_UNVERIFIED" &&
        (!Array.isArray(c.validation?.missingHistory) ||
          !c.validation.missingHistory.length)
      )
        ctx.addIssue({
          code: "custom",
          message: "History certificate has no missing history",
        });
    }
  });
export const revalidationSummary = z.object({
  status: z.enum([
    "ORIGINAL_VERIFIED",
    "PENDING",
    "RUNNING",
    "FAILED",
    "VERIFIED",
    "HISTORY_UNVERIFIED",
    "INVALID",
    "INPUT_INVALID",
  ]),
  requiredRevision: z.number().int(),
  inputRevision: z.number().int().nullable(),
  requestId: revalidationMessage.shape.requestId.nullable(),
  attempt: z.number().int(),
  validationId: z.string().uuid().nullable(),
});
