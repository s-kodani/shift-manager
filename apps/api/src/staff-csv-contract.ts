import { z } from "zod";
import { staffContract } from "./input-contracts";
export const staffCsvColumns = [
  "staff_number",
  "name",
  "email",
  "employment_type_id",
  "weekdays",
  "start",
  "end",
  "daily_max",
  "weekly_max",
  "monthly_min",
  "monthly_max",
  "min_days",
  "min_off",
  "max_consecutive",
  "skills",
  "role_ids",
] as const;
const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const inputMonth = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
const errors = z.array(
  z.object({ column: z.string(), code: z.string() }).strict(),
);
export const staffCsvCommand = z
  .object({
    month: inputMonth,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 102),
    csv: z.string().max(1_000_000),
  })
  .strict();
export const staffCsvApply = staffCsvCommand
  .extend({ operationId: uuid, previewSha256: digest })
  .strict();
const person = z
  .object({
    staffNumber: z.string(),
    name: z.string(),
    email: z.string(),
    profile: staffContract,
  })
  .strict();
export const staffCsvPreview = z
  .object({
    month: inputMonth,
    inputRevision: z.number().int(),
    csvSha256: digest,
    previewSha256: digest,
    added: z.number().int(),
    updated: z.number().int(),
    rows: z
      .array(
        z
          .object({
            line: z.number().int().positive(),
            person: person.nullable(),
            action: z.enum(["ADD", "UPDATE"]).nullable(),
            errors,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const staffCsvReceipt = z
  .object({
    id: uuid,
    revision: z.number().int(),
    month: inputMonth,
    added: z.number().int(),
    updated: z.number().int(),
    rejectedRows: z.number().int(),
    replayed: z.boolean(),
    rows: z.array(
      z
        .object({
          line: z.number().int(),
          staffId: uuid,
          staffNumber: z.string(),
          action: z.enum(["ADD", "UPDATE"]),
          contractVersion: uuid,
        })
        .strict(),
    ),
    errors: z.array(z.object({ line: z.number().int(), errors }).strict()),
  })
  .strict();
export const staffCsvResponse = z
  .object({
    receipt: staffCsvReceipt,
    initialPasswords: z.array(
      z
        .object({ staffNumber: z.string(), initialPassword: z.string() })
        .strict(),
    ),
  })
  .strict();
export type StaffCsvPreview = z.infer<typeof staffCsvPreview>;
export type StaffCsvReceipt = z.infer<typeof staffCsvReceipt>;
