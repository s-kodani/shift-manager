import { z } from "zod";
import { planning } from "./input-contracts";
const inputMonth = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const demandCsvCommand = z
  .object({
    month: inputMonth,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    csv: z.string().max(1_000_000),
  })
  .strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const demandCsvRowErrors = z
  .object({
    line: z.number().int().positive(),
    errors: z
      .array(z.object({ column: z.string(), code: z.string() }).strict())
      .min(1),
  })
  .strict();
export const demandCsvApply = demandCsvCommand
  .extend({ operationId: z.string().uuid(), previewSha256: digest })
  .strict();
export const demandCsvPreview = z
  .object({
    month: inputMonth,
    inputRevision: z.number().int(),
    csvSha256: digest,
    previewSha256: digest,
    capacityScale: z.number().int().positive(),
    added: z.number().int().nonnegative(),
    replaced: z.number().int().nonnegative(),
    rows: z.array(
      z
        .object({
          line: z.number().int().positive(),
          demand: planning.shape.demand.element.nullable(),
          action: z.enum(["ADD", "REPLACE"]).nullable(),
          errors: z.array(
            z.object({ column: z.string(), code: z.string() }).strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export const demandCsvReceipt = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    importedRows: z.number().int().positive(),
    rejectedRows: z.number().int().nonnegative(),
    added: z.number().int().nonnegative(),
    replaced: z.number().int().nonnegative(),
    replayed: z.boolean(),
    errors: z.array(demandCsvRowErrors).max(10_000),
  })
  .strict();
export type DemandCsvPreview = z.infer<typeof demandCsvPreview>;
export type DemandCsvReceipt = z.infer<typeof demandCsvReceipt>;
