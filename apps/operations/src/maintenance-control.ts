import {z} from 'zod';
import {maintenanceCommand,maintenanceFingerprint,maintenanceLeaseQuery,maintenanceLeases} from '../../../scripts/maintenance-contract.mjs';
export {maintenanceCommand} from '../../../scripts/maintenance-contract.mjs';
type Database=Pick<D1Database,'prepare'|'batch'>;
const mode=z.enum(['OPEN','DRAINING','FROZEN']);
const state=z.object({mode,revision:z.number().int().nonnegative(),maintenance_id:z.string().nullable(),last_operation_id:z.string().nullable(),updated_at:z.number().int().nonnegative()});
const uuid=z.string().uuid();
export class MaintenanceControlError extends Error {
 constructor(public code:string,public status:409|503=409){super(code);}
}
const receipt=z.object({id:uuid,principal:z.string(),action:z.enum(['begin','freeze','resume','reclaim','retire']),fingerprint:z.string(),maintenance_id:z.string().nullable(),mode,revision:z.number(),reason:z.string(),created_at:z.number()});
const execution=z.object({activeRpc:z.boolean(),persistedFence:z.boolean(),persistedCheckFence:z.boolean(),processRunning:z.boolean()});
const lease=z.object({id:uuid,kind:z.enum(['FOREGROUND','BACKGROUND']),started_at:z.number().int().nonnegative(),completed_at:z.number().int().nonnegative().nullable(),guard_version:z.union([z.literal(0),z.literal(1)]),resource_guard:z.union([z.literal(0),z.literal(1)]),delivery_guard:z.union([z.literal(0),z.literal(1)])});
export async function maintenanceStatus(db:Database){
 const row=state.parse(await db.prepare('SELECT * FROM maintenance_state WHERE id=1').first());
 const counts=await db.prepare(`SELECT
  (SELECT count(*) FROM maintenance_lease) AS activeLeases,
  (SELECT count(*) FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING')) AS activeJobs,
  (SELECT count(*) FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING')) AS activeRevalidations`).first<{activeLeases:number;activeJobs:number;activeRevalidations:number}>();
 if(!counts)throw new MaintenanceControlError('MAINTENANCE_INSPECTION_UNAVAILABLE',503);
 return {schema:'maintenance-status-v1',...row,...counts};
}
export async function inspectMaintenanceOperation(db:Database,principal:string,id:string){
 const row=await db.prepare('SELECT * FROM maintenance_operation WHERE id=? AND principal=? UNION ALL SELECT * FROM maintenance_retirement_operation WHERE id=? AND principal=?').bind(uuid.parse(id),principal,id,principal).first();
 return row?{found:true as const,...await checkedReceipt(db,row)}:{found:false as const};
}
async function checkedReceipt(db:Database,row:unknown){
 const r=receipt.parse(row);
 if(r.action==='reclaim'){
  const proof=await db.prepare(`SELECT c.expected_count FROM maintenance_recovery_commit c
   WHERE c.operation_id=? AND c.expected_count=(SELECT count(*) FROM maintenance_lease_recovery WHERE operation_id=c.operation_id)`)
   .bind(r.id).first();
  if(!proof)throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);
 }
 if(r.action==='retire'){
  const proof=await db.prepare(`SELECT c.expected_count FROM maintenance_retirement_commit c
   WHERE c.operation_id=? AND c.expected_count=((SELECT count(*) FROM maintenance_lease_retirement WHERE operation_id=c.operation_id)
    +(SELECT count(*) FROM maintenance_delivery_lease_retirement WHERE operation_id=c.operation_id))`).bind(r.id).first();
  if(!proof)throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);
 }
 return r;
}
export async function listMaintenanceLeases(db:Database,input:unknown){
 const {cursor}=maintenanceLeaseQuery.parse(input);
 // State and the bounded page are observed at one D1 transaction boundary.
 const rows=await db.batch([
  db.prepare('SELECT * FROM maintenance_state WHERE id=1'),
  db.prepare('SELECT id,kind,started_at,completed_at,guard_version,resource_guard,delivery_guard FROM maintenance_lease WHERE (? IS NULL OR id>?) ORDER BY id LIMIT 51').bind(cursor,cursor),
 ]);
 const current=state.parse(rows[0].results[0]),leases=rows[1].results.slice(0,50).map(row=>lease.parse(row));
 return maintenanceLeases.parse({schema:'maintenance-leases-v4',mode:current.mode,revision:current.revision,maintenance_id:current.maintenance_id,leases,nextCursor:rows[1].results.length>50?leases[49].id:null});
}
export async function changeMaintenance(db:Database,principal:string,input:z.infer<typeof maintenanceCommand>,inspect:(name:string)=>Promise<unknown>,recoveryId=''){
 const c=maintenanceCommand.parse(input),hash=await maintenanceFingerprint(c);
 // A copied resume receipt belongs to its old namespace. Even a replay must
 // pass the current restore's security gate before reporting success.
 if(c.action==='resume'&&recoveryId&&!await db.prepare('SELECT 1 FROM recovery_security_authorization WHERE restore_id=?').bind(recoveryId).first())throw new MaintenanceControlError('RECOVERY_SECURITY_REQUIRED');
 const replay=async()=>{
  const row=await db.prepare('SELECT * FROM maintenance_operation WHERE id=? UNION ALL SELECT * FROM maintenance_retirement_operation WHERE id=?').bind(c.operationId,c.operationId).first();
  if(!row)return null;
  const r=await checkedReceipt(db,row);
  if(r.principal!==principal||r.fingerprint!==hash)throw new MaintenanceControlError('MAINTENANCE_OPERATION_REUSED');
  return {found:true as const,...r};
 };
 const previous=await replay();if(previous)return previous;
 const current=await maintenanceStatus(db);
 const expectedMode=c.action==='begin'?'OPEN':['freeze','reclaim','retire'].includes(c.action)?'DRAINING':null;
 if(current.revision!==c.expectedRevision||(expectedMode&&current.mode!==expectedMode)||
  (c.action!=='begin'&&(current.mode==='OPEN'||current.maintenance_id!==c.maintenanceId))){const r=await replay();if(r)return r;throw new MaintenanceControlError('MAINTENANCE_CONFLICT');}
 if(c.action==='freeze'){
  if(current.activeLeases||current.activeJobs||current.activeRevalidations)throw new MaintenanceControlError('MAINTENANCE_NOT_DRAINED');
  const teams=await db.prepare('SELECT company_id,id FROM team ORDER BY company_id,id LIMIT 1025').all<{company_id:string;id:string}>();
  if(teams.results.length>1024)throw new MaintenanceControlError('MAINTENANCE_INVENTORY_LIMIT');
  const names=['synthetic-poc',...teams.results.map(t=>`company:${t.company_id}:team:${t.id}`)];
  try{
   for(let i=0;i<names.length;i+=4){
    const rows=await Promise.all(names.slice(i,i+4).map(inspect));
    for(const row of rows){const s=execution.parse(row);if(s.activeRpc||s.persistedFence||s.persistedCheckFence||s.processRunning)throw new MaintenanceControlError('MAINTENANCE_EXECUTION_ACTIVE');}
   }
  }catch(error){if(error instanceof MaintenanceControlError)throw error;throw new MaintenanceControlError('MAINTENANCE_INSPECTION_UNAVAILABLE',503);}
 }
 const next=['begin','reclaim','retire'].includes(c.action)?'DRAINING':c.action==='freeze'?'FROZEN':'OPEN';
 const session=c.action==='begin'?c.operationId:c.action==='resume'?null:c.maintenanceId;
 const now=Date.now();
 const frozenCondition=c.action==='freeze'?`AND NOT EXISTS(SELECT 1 FROM maintenance_lease)
  AND NOT EXISTS(SELECT 1 FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING'))
  AND NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING'))`:'';
 const leaseIds=['reclaim','retire'].includes(c.action)&&'leaseIds' in c?c.leaseIds:[],slots=leaseIds.map(()=>'?').join(',');
 if(c.action==='reclaim'){
  const ready=await db.prepare(`SELECT count(*) AS n FROM maintenance_lease WHERE id IN (${slots}) AND completed_at IS NOT NULL`).bind(...leaseIds).first<number>('n');
  if(ready!==leaseIds.length){const r=await replay();if(r)return r;throw new MaintenanceControlError('MAINTENANCE_COMPLETION_REQUIRED');}
 }
 if(c.action==='retire'){
  const ready=await db.prepare(`SELECT count(*) AS n FROM maintenance_lease WHERE id IN (${slots}) AND completed_at IS NULL
   AND ((kind='FOREGROUND' AND guard_version=1 AND delivery_guard=0)
    OR (kind='BACKGROUND' AND guard_version=0 AND resource_guard=0 AND delivery_guard=1))`).bind(...leaseIds).first<number>('n');
  if(ready!==leaseIds.length){const r=await replay();if(r)return r;throw new MaintenanceControlError('MAINTENANCE_DATABASE_GUARD_REQUIRED');}
 }
 const selected=['reclaim','retire'].includes(c.action);
 const selection=c.action==='retire'?"completed_at IS NULL AND ((kind='FOREGROUND' AND guard_version=1 AND delivery_guard=0) OR (kind='BACKGROUND' AND guard_version=0 AND resource_guard=0 AND delivery_guard=1))":'completed_at IS NOT NULL';
 const completionCondition=selected?`AND (SELECT count(*) FROM maintenance_lease WHERE id IN (${slots}) AND ${selection})=?`:'';
 const operationTable=c.action==='retire'?'maintenance_retirement_operation':'maintenance_operation';
 try{
  // State, receipt and recovery share a transaction. A zero-row update is an
  // explicit conflict; it cannot create a success receipt for another command.
  const statements=[
   db.prepare(`UPDATE maintenance_state SET mode=?,revision=revision+1,maintenance_id=?,last_operation_id=?,updated_at=?
    WHERE id=1 AND revision=? AND mode=? AND maintenance_id IS ? ${frozenCondition} ${completionCondition}
     AND (?='' OR EXISTS(SELECT 1 FROM recovery_security_authorization WHERE restore_id=?))`)
    .bind(next,session,c.operationId,now,c.expectedRevision,current.mode,current.maintenance_id,...(selected?[...leaseIds,leaseIds.length]:[]),c.action==='resume'?recoveryId:'',c.action==='resume'?recoveryId:''),
   db.prepare(`INSERT INTO ${operationTable}(id,principal,action,fingerprint,maintenance_id,mode,revision,reason,created_at)
    SELECT ?,?,?,?,?,mode,revision,?,? FROM maintenance_state WHERE id=1 AND last_operation_id=? AND revision=?`)
    .bind(c.operationId,principal,c.action,hash,session,c.reason,now,c.operationId,c.expectedRevision+1),
  ];
  if(c.action==='reclaim'){
   statements.push(
    db.prepare(`INSERT INTO maintenance_lease_recovery(lease_id,operation_id,kind,started_at,completed_at)
     SELECT l.id,?,l.kind,l.started_at,l.completed_at FROM maintenance_lease l
     WHERE l.id IN (${slots}) AND l.completed_at IS NOT NULL AND
      EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='DRAINING' AND maintenance_id=? AND last_operation_id=? AND revision=?)`)
     .bind(c.operationId,...leaseIds,c.maintenanceId,c.operationId,c.expectedRevision+1),
    db.prepare('DELETE FROM maintenance_lease WHERE id IN (SELECT lease_id FROM maintenance_lease_recovery WHERE operation_id=?)').bind(c.operationId),
    db.prepare(`INSERT INTO maintenance_recovery_commit(operation_id,expected_count)
     SELECT ?,? FROM maintenance_state WHERE id=1 AND last_operation_id=? AND revision=?`)
     .bind(c.operationId,leaseIds.length,c.operationId,c.expectedRevision+1),
   );
  }
  if(c.action==='retire'){
   statements.push(
    db.prepare(`INSERT INTO maintenance_lease_retirement(lease_id,operation_id,kind,started_at,guard_version,retired_at,resource_guard)
     SELECT l.id,?,l.kind,l.started_at,l.guard_version,?,l.resource_guard FROM maintenance_lease l
     WHERE l.id IN (${slots}) AND l.kind='FOREGROUND' AND l.guard_version=1 AND l.completed_at IS NULL AND
      EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='DRAINING' AND maintenance_id=? AND last_operation_id=? AND revision=?)`)
     .bind(c.operationId,now,...leaseIds,c.maintenanceId,c.operationId,c.expectedRevision+1),
    db.prepare(`INSERT INTO maintenance_delivery_lease_retirement(lease_id,operation_id,kind,started_at,delivery_guard,retired_at)
     SELECT l.id,?,l.kind,l.started_at,l.delivery_guard,? FROM maintenance_lease l
     WHERE l.id IN (${slots}) AND l.kind='BACKGROUND' AND l.delivery_guard=1 AND l.completed_at IS NULL AND
      EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='DRAINING' AND maintenance_id=? AND last_operation_id=? AND revision=?)`)
     .bind(c.operationId,now,...leaseIds,c.maintenanceId,c.operationId,c.expectedRevision+1),
    db.prepare(`DELETE FROM maintenance_lease WHERE id IN
     (SELECT lease_id FROM maintenance_lease_retirement WHERE operation_id=? UNION ALL SELECT lease_id FROM maintenance_delivery_lease_retirement WHERE operation_id=?)`).bind(c.operationId,c.operationId),
    db.prepare(`INSERT INTO maintenance_retirement_commit(operation_id,expected_count)
     SELECT ?,? FROM maintenance_state WHERE id=1 AND last_operation_id=? AND revision=?`)
     .bind(c.operationId,leaseIds.length,c.operationId,c.expectedRevision+1),
   );
  }
  if(selected){
   const commitTable=c.action==='retire'?'maintenance_retirement_commit':'maintenance_recovery_commit';
   // Even a silently skipped final receipt insert must abort the transaction,
   // not become a client-side error after state and deletion already commit.
   statements.push(db.prepare(`SELECT CASE WHEN
    NOT EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND last_operation_id=? AND revision=?)
    OR EXISTS(SELECT 1 FROM ${commitTable} WHERE operation_id=? AND expected_count=?)
    THEN 1 ELSE abs(-9223372036854775808) END AS committed`)
    .bind(c.operationId,c.expectedRevision+1,c.operationId,leaseIds.length));
  }
  const rows=await db.batch(statements);
  if(rows[0].meta.changes!==1||rows[1].meta.changes!==1){const r=await replay();if(r)return r;throw new MaintenanceControlError('MAINTENANCE_CONFLICT');}
  if(c.action==='reclaim'&&(rows[2].meta.changes!==leaseIds.length||rows[3].meta.changes!==leaseIds.length||rows[4].meta.changes!==1))throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);
  if(c.action==='retire'&&(rows[2].meta.changes+rows[3].meta.changes!==leaseIds.length||rows[4].meta.changes!==leaseIds.length||rows[5].meta.changes!==1))throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);
 }catch(error){const r=await replay();if(r)return r;if(error instanceof MaintenanceControlError)throw error;throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);}
 const r=await replay();if(!r)throw new MaintenanceControlError('MAINTENANCE_COMMAND_UNAVAILABLE',503);return r;
}
