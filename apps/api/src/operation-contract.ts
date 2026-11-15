import { z } from 'zod';
// Browser-safe operation envelope; no runtime bindings or business authority.
export const mutation=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1)});
