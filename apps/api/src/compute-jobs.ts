import {boundedBytes} from './bounded-body';
import {decodeStoredSchedule} from './schedule-serialization';
import {z} from 'zod';
import {ProductError,requireManager} from './product';
import {readInputSnapshot,sha256} from './input-snapshots';
import type {InputDatabase} from './input-versions';
import {snapshotDraftStale} from './draft-lineage';

export const jobCommand=z.object({operationId:z.string().uuid(),snapshotId:z.string().uuid(),expectedRevision:z.number().int().nonnegative()}).strict();
export const cancelCommand=z.object({operationId:z.string().uuid(),expectedAttempt:z.number().int().min(0).max(3)}).strict();
export const jobMessage=z.object({version:z.literal(1),companyId:z.string().uuid(),teamId:z.string().uuid(),jobId:z.string().uuid()}).strict();
export type JobMessage=z.infer<typeof jobMessage>;
export type JobRow={company_id:string;id:string;team_id:string;actor_id:string;snapshot_id:string;input_revision:number;fingerprint:string;
 state:'QUEUED'|'RUNNING'|'CANCELLING'|'SUCCEEDED'|'NO_SOLUTION'|'STALE'|'FAILED'|'CANCELLED';attempt:number;lease_token:string|null;lease_expires_at:number|null;
 failure_code:string|null;result_key:string|null;result_sha256:string|null;result_bytes:number|null;solver_status:string|null;validation_status:string|null;created_at:number;updated_at:number};
export const ACTIVE_STATES=new Set(['QUEUED','RUNNING','CANCELLING']);
export async function loadJob(db:InputDatabase,company:string,team:string,id:string) {
 return db.prepare('SELECT * FROM compute_job WHERE company_id=? AND team_id=? AND id=?').bind(company,team,id).first<JobRow>();
}
function mapJobError(error:unknown):never {
 const message=String(error);
 if(message.includes('JOB_FORBIDDEN'))throw new ProductError('FORBIDDEN',403);
 if(message.includes('JOB_DRAFT_VERSION_CONFLICT'))throw new ProductError('DRAFT_VERSION_CONFLICT');
 if(message.includes('JOB_VERSION_CONFLICT'))throw new ProductError('VERSION_CONFLICT');
 if(message.includes('JOB_ATTEMPT_CONFLICT'))throw new ProductError('ATTEMPT_CONFLICT');
 if(message.includes('UNIQUE constraint failed: compute_job.company_id, compute_job.team_id'))throw new ProductError('TEAM_JOB_ACTIVE');
 if(message.includes('UNIQUE constraint failed: compute_job.company_id, compute_job.id'))throw new ProductError('OPERATION_ID_CONFLICT');
 throw error;
}
function audit(db:InputDatabase,job:Pick<JobRow,'company_id'|'actor_id'|'input_revision'>,id:string,kind:string,now=Date.now()) {
 return db.prepare('INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)')
  .bind(job.company_id,id,job.actor_id,kind,job.input_revision,now);
}
function publicJob(job:JobRow) {
 const {lease_token:_,fingerprint:__,actor_id:___,result_key:____,...view}=job;
 return {...view,publication:'BLOCKED_A1' as const};
}
export async function createJob(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,data:z.infer<typeof jobCommand>) {
 const c=jobCommand.parse(data);await requireManager(db,company,team,user);
 const fingerprint=JSON.stringify({company,team,user,...c});
 const old=await loadJob(db,company,team,c.operationId);
 if(old){if(old.fingerprint!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');return {job:publicJob(old),replayed:true};}
 const frozen=await readInputSnapshot(db,bucket,company,team,user,c.snapshotId,true);
 if(frozen.snapshot.input_revision!==c.expectedRevision)throw new ProductError('VERSION_CONFLICT');
 const now=Date.now();
 try {
  await db.batch([
   db.prepare(`INSERT INTO compute_job(company_id,id,team_id,actor_id,snapshot_id,input_revision,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .bind(company,c.operationId,team,user,c.snapshotId,c.expectedRevision,fingerprint,now,now),
   db.prepare('INSERT INTO compute_outbox(company_id,job_id,next_delivery_at) VALUES (?,?,0)').bind(company,c.operationId),
   audit(db,{company_id:company,actor_id:user,input_revision:c.expectedRevision},c.operationId,'compute:accepted',now),
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compute_job j
    JOIN compute_outbox o ON o.company_id=j.company_id AND o.job_id=j.id
    JOIN product_audit a ON a.company_id=j.company_id AND a.id=j.id
    WHERE j.company_id=? AND j.id=? AND j.team_id=? AND j.actor_id=? AND j.snapshot_id=? AND j.input_revision=? AND j.fingerprint=?
     AND j.state='QUEUED' AND j.attempt=0 AND j.created_at=? AND j.updated_at=j.created_at
     AND o.next_delivery_at=0 AND o.deliveries=0 AND o.last_sent_at IS NULL
     AND a.actor_id=j.actor_id AND a.kind='compute:accepted' AND a.revision=j.input_revision AND a.recorded_at=j.created_at)
    THEN 1 ELSE abs(-9223372036854775808) END AS job_accepted`)
    .bind(company,c.operationId,team,user,c.snapshotId,c.expectedRevision,fingerprint,now),
  ]);
 }catch(error){
  const replay=await loadJob(db,company,team,c.operationId);
  if(replay){await requireManager(db,company,team,user);if(replay.fingerprint!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');return {job:publicJob(replay),replayed:true};}
  mapJobError(error);
 }
 return {job:publicJob((await loadJob(db,company,team,c.operationId))!),replayed:false};
}
export async function getJob(db:InputDatabase,company:string,team:string,user:string,id:string) {
 await requireManager(db,company,team,user);const job=await loadJob(db,company,team,id);
 if(!job)throw new ProductError('NOT_FOUND',404);
 const current=await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision');
 const attempts=await db.prepare('SELECT attempt,started_at,finished_at,final_state,failure_code FROM compute_attempt WHERE company_id=? AND job_id=? ORDER BY attempt').bind(company,id).all();
 return {...publicJob(job),attempts:attempts.results,stale:current!==job.input_revision||await snapshotDraftStale(db,company,job.snapshot_id)};
}
export async function listJobs(db:InputDatabase,company:string,team:string,user:string){
 await requireManager(db,company,team,user);
 const rows=await db.prepare(`SELECT j.*,s.month FROM compute_job j JOIN input_snapshot s ON s.company_id=j.company_id AND s.id=j.snapshot_id
  WHERE j.company_id=? AND j.team_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 30`).bind(company,team).all<JobRow&{month:string}>();
 return {jobs:rows.results.map(publicJob)};
}
export async function cancelJob(db:InputDatabase,company:string,team:string,user:string,id:string,data:z.infer<typeof cancelCommand>) {
 const c=cancelCommand.parse(data);await requireManager(db,company,team,user);
 const job=await loadJob(db,company,team,id);if(!job)throw new ProductError('NOT_FOUND',404);
 const fingerprint=JSON.stringify({company,team,user,id,...c});
 const replay=async()=>{
  const old=await db.prepare('SELECT fingerprint FROM compute_cancel_operation WHERE company_id=? AND id=?').bind(company,c.operationId).first<string>('fingerprint');
  if(old&&old!==fingerprint)throw new ProductError('OPERATION_ID_CONFLICT');return !!old;
 };
 if(await replay())return {job:await getJob(db,company,team,user,id),replayed:true};
 const now=Date.now();
 try {
  await db.batch([
   db.prepare('INSERT INTO compute_cancel_operation(company_id,id,job_id,actor_id,expected_attempt,fingerprint) VALUES (?,?,?,?,?,?)').bind(company,c.operationId,id,user,c.expectedAttempt,fingerprint),
   db.prepare(`UPDATE compute_job SET state=CASE state WHEN 'QUEUED' THEN 'CANCELLED' ELSE 'CANCELLING' END,updated_at=? WHERE company_id=? AND id=?`).bind(now,company,id),
   db.prepare('UPDATE compute_outbox SET next_delivery_at=0 WHERE company_id=? AND job_id=?').bind(company,id),
   audit(db,{company_id:company,actor_id:user,input_revision:job.input_revision},c.operationId,'compute:cancel_requested',now),
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compute_cancel_operation p
    JOIN compute_job j ON j.company_id=p.company_id AND j.id=p.job_id
    JOIN compute_outbox o ON o.company_id=j.company_id AND o.job_id=j.id
    JOIN product_audit a ON a.company_id=p.company_id AND a.id=p.id
    WHERE p.company_id=? AND p.id=? AND p.job_id=? AND p.actor_id=? AND p.expected_attempt=? AND p.fingerprint=?
     AND j.team_id=? AND j.attempt=p.expected_attempt AND j.state=? AND j.updated_at=? AND o.next_delivery_at=0
     AND a.actor_id=p.actor_id AND a.kind='compute:cancel_requested' AND a.revision=j.input_revision AND a.recorded_at=j.updated_at)
    THEN 1 ELSE abs(-9223372036854775808) END AS cancellation_requested`)
    .bind(company,c.operationId,id,user,c.expectedAttempt,fingerprint,team,job.state==='QUEUED'?'CANCELLED':'CANCELLING',now),
  ]);
 }catch(error){if(await replay()){await requireManager(db,company,team,user);return {job:await getJob(db,company,team,user,id),replayed:true};}mapJobError(error);}
 return {job:await getJob(db,company,team,user,id),replayed:false};
}
export async function dispatchJobs(db:InputDatabase,queue:Pick<Queue,'send'>,now=Date.now()) {
 const due=await db.prepare(`SELECT j.company_id,j.team_id,j.id FROM compute_outbox o JOIN compute_job j ON j.company_id=o.company_id AND j.id=o.job_id
  WHERE o.next_delivery_at<=? AND (j.state='QUEUED' OR j.state='CANCELLING' OR (j.state='RUNNING' AND j.lease_expires_at<=?)) ORDER BY o.next_delivery_at LIMIT 50`).bind(now,now).all<{company_id:string;team_id:string;id:string}>();
 let sent=0,failed=0;
 for(const job of due.results){
  const claimed=await db.prepare('UPDATE compute_outbox SET next_delivery_at=?,deliveries=deliveries+1 WHERE company_id=? AND job_id=? AND next_delivery_at<=? RETURNING job_id').bind(now+60_000,job.company_id,job.id,now).first();
  if(!claimed)continue;
  try{await queue.send({version:1,companyId:job.company_id,teamId:job.team_id,jobId:job.id} satisfies JobMessage);sent++;
   await db.prepare('UPDATE compute_outbox SET last_sent_at=? WHERE company_id=? AND job_id=?').bind(Date.now(),job.company_id,job.id).run();
  }catch{failed++;} // Send/ack uncertainty remains eligible for a later replay.
 }
 return {sent,failed};
}
export async function claimJob(db:InputDatabase,message:JobMessage) {
 const token=crypto.randomUUID(),now=Date.now();
 const result=await db.batch<JobRow>([db.prepare(`UPDATE compute_job SET state='RUNNING',attempt=attempt+1,lease_token=?,lease_expires_at=?,updated_at=?
  WHERE company_id=? AND team_id=? AND id=? AND state='QUEUED' AND attempt<3 RETURNING *`)
  .bind(token,now+180_000,now,message.companyId,message.teamId,message.jobId),
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compute_job j WHERE j.company_id=? AND j.id=? AND j.lease_token=?
   AND NOT EXISTS(SELECT 1 FROM compute_attempt a WHERE a.company_id=j.company_id AND a.job_id=j.id AND a.attempt=j.attempt
    AND a.lease_token=j.lease_token AND a.started_at=j.updated_at AND a.finished_at IS NULL AND a.final_state IS NULL AND a.failure_code IS NULL))
   THEN abs(-9223372036854775808) ELSE 1 END AS attempt_started`).bind(message.companyId,message.jobId,token),
 ]);
 return result[0].results[0]??null; // Zero rows is a normal losing claim, not a SQL failure.
}
export async function endJob(db:InputDatabase,job:JobRow,state:'FAILED'|'STALE'|'CANCELLED'|'QUEUED',code:string|null) {
 const now=Date.now();
 const results=await db.batch([db.prepare(`UPDATE compute_job SET state=CASE WHEN state='CANCELLING' THEN 'CANCELLED' ELSE ? END,failure_code=CASE WHEN state='CANCELLING' THEN NULL ELSE ? END,lease_token=NULL,lease_expires_at=NULL,updated_at=?
  WHERE company_id=? AND id=? AND state IN ('RUNNING','CANCELLING') AND lease_token=? RETURNING id`)
  .bind(state,code,now,job.company_id,job.id,job.lease_token),
  db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compute_job j WHERE j.company_id=? AND j.id=? AND j.attempt=? AND (
   (j.state IN ('RUNNING','CANCELLING') AND j.lease_token=?) OR
   (j.updated_at=? AND ((j.state=? AND j.failure_code IS ?) OR (j.state='CANCELLED' AND j.failure_code IS NULL))
    AND NOT EXISTS(SELECT 1 FROM compute_attempt a WHERE a.company_id=j.company_id AND a.job_id=j.id AND a.attempt=j.attempt
     AND a.lease_token=? AND a.finished_at=j.updated_at AND a.final_state=j.state AND a.failure_code IS j.failure_code))))
   THEN abs(-9223372036854775808) ELSE 1 END AS attempt_finished`)
   .bind(job.company_id,job.id,job.attempt,job.lease_token,now,state,code,job.lease_token),
 ]);
 return results[0].results.length===1; // meta.changes also counts attempt-history trigger writes.
}
export type ResultManifest={key:string;digest:string;bytes:number;solverStatus:string;validationStatus:string;state:'SUCCEEDED'|'NO_SOLUTION'};
export async function completeJob(db:InputDatabase,job:JobRow,result:ResultManifest,now=Date.now()) {
 try{
  const committed=await db.batch([
   db.prepare(`UPDATE compute_job SET state=?,result_key=?,result_sha256=?,result_bytes=?,solver_status=?,validation_status=?,failure_code=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=?
    WHERE company_id=? AND id=? AND state='RUNNING' AND attempt=? AND lease_token=? AND lease_expires_at>? RETURNING id`)
    .bind(result.state,result.key,result.digest,result.bytes,result.solverStatus,result.validationStatus,now,job.company_id,job.id,job.attempt,job.lease_token,now),
   db.prepare(`INSERT OR IGNORE INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at)
    SELECT company_id,?,actor_id,'compute:completed',input_revision,? FROM compute_job WHERE company_id=? AND id=? AND state IN ('SUCCEEDED','NO_SOLUTION') AND attempt=? AND result_key=?`)
    .bind(job.id+':completed',now,job.company_id,job.id,job.attempt,result.key),
   // INSERT OR IGNORE/RAISE(IGNORE) may succeed with zero rows. Prove that the
   // adopted result has its exact canonical audit inside the same transaction,
   // so a silent omission rolls back result adoption instead of losing history.
   db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM compute_job j
    WHERE j.company_id=? AND j.id=? AND j.state IN ('SUCCEEDED','NO_SOLUTION') AND j.attempt=? AND j.result_key=?
    AND (j.state!=? OR j.result_sha256!=? OR j.result_bytes!=? OR j.solver_status!=? OR j.validation_status!=?
     OR NOT EXISTS(SELECT 1 FROM compute_attempt t WHERE t.company_id=j.company_id AND t.job_id=j.id AND t.attempt=j.attempt
      AND t.lease_token=? AND t.finished_at=j.updated_at AND t.final_state=j.state AND t.failure_code IS NULL)
     OR NOT EXISTS(SELECT 1 FROM product_audit a WHERE a.company_id=j.company_id AND a.id=?
      AND a.actor_id=j.actor_id AND a.kind='compute:completed' AND a.revision=j.input_revision AND a.recorded_at=j.updated_at)))
    THEN abs(-9223372036854775808) ELSE 1 END AS audit_recorded`)
    .bind(job.company_id,job.id,job.attempt,result.key,result.state,result.digest,result.bytes,result.solverStatus,result.validationStatus,job.lease_token,job.id+':completed'),
  ]);
  return committed[0].results.length===1;
 }catch(error){
  const text=String(error);
  if(text.includes('JOB_DRAFT_VERSION_CONFLICT')){await endJob(db,job,'STALE','DRAFT_CHANGED');return false;}
  if(text.includes('JOB_VERSION_CONFLICT')){await endJob(db,job,'STALE','INPUT_CHANGED');return false;}
  if(text.includes('JOB_FORBIDDEN')){await endJob(db,job,'FAILED','ACCESS_REVOKED');return false;}
  throw error;
 }
}
export async function readJobResult(db:InputDatabase,bucket:R2Bucket,company:string,team:string,user:string,id:string) {
 await requireManager(db,company,team,user);const job=await loadJob(db,company,team,id);
 if(!job)throw new ProductError('NOT_FOUND',404);
 if(!job.result_key||!job.result_bytes||!job.result_sha256)throw new ProductError('RESULT_NOT_READY');
 const object=await bucket.get(job.result_key);
 if(!object||object.size!==job.result_bytes)throw new Error('RESULT_OBJECT_MISSING');
 const bytes=await boundedBytes(object.body,job.result_bytes);
 if(bytes.byteLength!==job.result_bytes||await sha256(bytes)!==job.result_sha256)throw new Error('RESULT_DIGEST_MISMATCH');
 const data=await decodeStoredSchedule(bytes);
 if(data.jobId!==id||data.tenantId!==company||data.teamId!==team||data.attempt!==job.attempt||data.inputVersion!==job.input_revision)throw new Error('RESULT_IDENTITY_MISMATCH');
 const current=await db.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision');
 return {result:data,inputStale:current!==job.input_revision,stale:current!==job.input_revision||await snapshotDraftStale(db,company,job.snapshot_id),publication:'BLOCKED_A1' as const};
}
export {boundedBytes} from './bounded-body';
