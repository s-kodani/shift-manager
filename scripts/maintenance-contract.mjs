import {z} from 'zod';
const uuid=z.string().uuid(),mode=z.enum(['OPEN','DRAINING','FROZEN']);
const common={operationId:uuid,expectedRevision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1),reason:z.string().trim().min(1).max(240)};
export const maintenanceCommand=z.discriminatedUnion('action',[
 z.object({...common,action:z.literal('begin')}).strict(),
 z.object({...common,action:z.literal('freeze'),maintenanceId:uuid}).strict(),
 z.object({...common,action:z.literal('resume'),maintenanceId:uuid}).strict(),
 z.object({...common,action:z.literal('reclaim'),maintenanceId:uuid,leaseIds:z.array(uuid).min(1).max(40)
  .refine(ids=>new Set(ids).size===ids.length,'DUPLICATE_LEASE_IDS').transform(ids=>[...ids].sort())}).strict(), z.object({...common,action:z.literal('retire'),maintenanceId:uuid,leaseIds:z.array(uuid).min(1).max(40)
  .refine(ids=>new Set(ids).size===ids.length,'DUPLICATE_LEASE_IDS').transform(ids=>[...ids].sort())}).strict(),
]);
export const maintenanceReceipt=z.object({found:z.literal(true),id:uuid,principal:z.string().min(1),action:z.enum(['begin','freeze','resume','reclaim','retire']),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),maintenance_id:uuid.nullable(),mode,revision:z.number().int().nonnegative(),reason:z.string(),created_at:z.number().int().nonnegative()}).strict();
export const maintenanceState=z.object({schema:z.literal('maintenance-status-v1'),mode,revision:z.number().int().nonnegative(),maintenance_id:uuid.nullable(),last_operation_id:uuid.nullable(),updated_at:z.number().int().nonnegative(),activeLeases:z.number().int().nonnegative(),activeJobs:z.number().int().nonnegative(),activeRevalidations:z.number().int().nonnegative()}).strict();
export const maintenanceLeaseQuery=z.object({cursor:uuid.nullable().default(null)}).strict();
export const maintenanceLeases=z.object({schema:z.literal('maintenance-leases-v4'),mode,revision:z.number().int().nonnegative(),maintenance_id:uuid.nullable(),leases:z.array(z.object({id:uuid,kind:z.enum(['FOREGROUND','BACKGROUND']),started_at:z.number().int().nonnegative(),completed_at:z.number().int().nonnegative().nullable(),guard_version:z.union([z.literal(0),z.literal(1)]),resource_guard:z.union([z.literal(0),z.literal(1)]),delivery_guard:z.union([z.literal(0),z.literal(1)])}).strict()).max(50),nextCursor:uuid.nullable()}).strict();
export async function maintenanceFingerprint(input){
 const c=maintenanceCommand.parse(input);
 const data=JSON.stringify({version:'maintenance-command-v1',action:c.action,operationId:c.operationId,expectedRevision:c.expectedRevision,reason:c.reason,maintenanceId:c.action==='begin'?null:c.maintenanceId,...(['reclaim','retire'].includes(c.action)?{leaseIds:c.leaseIds}:{})});
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data));
 return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
