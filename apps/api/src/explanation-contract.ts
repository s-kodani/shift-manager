import { z } from 'zod';

export const explanationSource = z.object({kind:z.enum(['job','draft']),id:z.string().uuid()}).strict();
export const explanationCommand = z.object({operationId:z.string().uuid(),source:explanationSource,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const explanationFact = z.object({
  id:z.string(),category:z.string(),text:z.string(),
  reference:z.object({section:z.string(),index:z.number().int().nonnegative().optional()}),
  values:z.record(z.string(),z.union([z.string(),z.number(),z.boolean(),z.null()])),
});
export const explanationGrounds = z.object({
  version:z.literal('explanation-v1'),digest:z.string(),stale:z.boolean(),
  source:explanationSource,month:z.string(),jobId:z.string(),snapshotId:z.string(),
  inputRevision:z.number().int(),resultDigest:z.string(),inputDigest:z.string(),
  solverStatus:z.string(),validationStatus:z.string(),metricsAvailable:z.boolean(),
  currentDraftId:z.string().nullable(),currentDraftRevision:z.number().int(),
  taskAliases:z.array(z.object({alias:z.string(),id:z.string()})),
  roleAliases:z.array(z.object({alias:z.string(),id:z.string()})),
  facts:z.array(explanationFact),omittedFacts:z.number().int().nonnegative(),
});
export const generatedSummary = z.object({
  factIds:z.array(z.string()).min(2).max(5),summary:z.string().min(1).max(2000),
}).strict();
export const explanationResponse = z.object({
  grounds:explanationGrounds,
  mode:z.enum(['template','ai','pending']),summary:z.string(),factIds:z.array(z.string()),
  reason:z.string().nullable(),model:z.string().nullable(),promptVersion:z.string(),
  generatedAt:z.number().nullable(),operationId:z.string().nullable(),cached:z.boolean(),
});
export type ExplanationGrounds = z.infer<typeof explanationGrounds>;
export type ExplanationFact = z.infer<typeof explanationFact>;
export type ExplanationResponse = z.infer<typeof explanationResponse>;
