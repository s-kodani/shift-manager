import {z} from 'zod';
import {optimizerInputSchema} from '../../../packages/contracts/optimizer-input.generated';

export const optimizerBenchmark = z.object({
  strategy:z.enum(['legacy-first-v1','balanced-coverage-v1','balanced-incumbent-v1','balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4']),
  budgetSeconds:z.number().finite().min(1).max(120),
  input:optimizerInputSchema.refine(input => input.tenantId==='fictional-company-a' &&
    input.teamId==='fictional-team-a' && input.jobId.startsWith('fictional-') &&
    input.staff.every(staff=>staff.id.startsWith('fictional-')), 'FICTIONAL_BENCHMARK_ONLY'),
}).strict();
export type OptimizerBenchmark = z.infer<typeof optimizerBenchmark>;
