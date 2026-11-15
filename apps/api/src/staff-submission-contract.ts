import { z } from 'zod';
import { mutation } from './operation-contract';
import { staffMonth } from './input-contracts';

export const staffSubmission = mutation.extend({payload: staffMonth}).strict();
export const submissionWindowCommand = mutation.extend({
  closesAt: z.number().int().positive().max(8_640_000_000_000_000).nullable(),
}).strict();
export const submissionWindow = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(), closesAt: z.number().int().nullable(),
});
export const submissionContext = z.object({
  month: z.string(), revision: z.number().int().nonnegative(), staffId: z.string().uuid(),
  calendarId: z.string().uuid(), serverTime: z.number().int(),
  deadline: z.object({month:z.string(),configuredDay:z.number().int(),deadlineDate:z.string(),timeZone:z.literal('Asia/Tokyo'),closesAt:z.number().int()}),
  window: submissionWindow.nullable(), accepting: z.boolean(),
  version: z.object({id:z.string().uuid(),revision:z.number().int(),payload:staffMonth}).nullable(),
  patterns: z.array(z.object({id:z.string(),start:z.number().int(),end:z.number().int()})),
});
export const submissionWindowContext = z.object({
  month:z.string(),serverTime:z.number().int(),window:submissionWindow.nullable(),
  deadline:submissionContext.shape.deadline,
});
export const submissionReceipt = z.object({id:z.string().uuid(),revision:z.number().int(),replayed:z.boolean()});
