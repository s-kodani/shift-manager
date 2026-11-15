import { z } from "zod";
export const calendarSettings = z
  .object({
    weekStart: z.number().int().min(0).max(6), // Sunday=0; no implicit default.
    deadlineDay: z.number().int().min(1).max(31),
    halfDayDivider: z.number().int().min(30).max(1410).multipleOf(30),
    roleRounding: z.enum(["ceil", "floor"]),
  })
  .strict();
