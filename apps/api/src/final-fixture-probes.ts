// Private final acceptance setup. No solve/Queue dispatch; product never imports.
import {z} from 'zod';
import {ProductError} from './product';
import {inputFixture} from './input-probes';
import {registeredOperationalFixture} from '../../../tests/fixtures/registered-operational';
import {optimizerInputSchema,optimizerAssignmentsSchema} from '../../../packages/contracts/optimizer-input.generated';
import {runCancellationProbe} from './cancellation-probes';
import {loadJob} from './compute-jobs';
import {handleJobBatch} from './compute-worker';
import {boundedBytes} from './compute-jobs';

const uuid=z.string().uuid();
const source=z.object({input:optimizerInputSchema.refine(d=>d.tenantId==='fictional-company-a'&&
 d.jobId==='fictional-operational-101-30-v1'&&d.staff.length===101&&d.slotMinutes===30,'FICTIONAL_101_REQUIRED'),assignments:optimizerAssignmentsSchema}).strict();
export const finalFixturePrepare=z.discriminatedUnion('profile',[
 z.object({ownerId:uuid,profile:z.literal('single'),jobIds:z.array(uuid).length(3)}).strict(),
 z.object({ownerId:uuid,profile:z.literal('operational101'),jobIds:z.array(uuid).length(1),source}).strict(),
]).refine(c=>new Set(c.jobIds).size===c.jobIds.length,'UNIQUE_JOB_IDS_REQUIRED');
export const finalFixtureCommand=z.object({ownerId:uuid,action:z.enum(['status','release','arm-fault','cleanup'])}).strict();
export const finalDeliveryCommand=z.object({ownerId:uuid,operationId:uuid,action:z.enum(['run','status'])}).strict();
type Metadata={schema:'final-acceptance-fixture-v1';profile:'single'|'operational101';jobIds:string[];ids:Record<string,string>;commands:Record<string,unknown>};
type Owner={id:string;company_id:string|null;team_id:string|null;admin_user_id:string|null;staff_user_id:string|null;
 stage:string;metadata:string;lease:string|null;expires_at:number;cleaned_at:number|null};
const name=(id:string)=>'架空取消確定検証:'+id; // Same ledger/name as its existing expiry cleanup.
function privateOnly(env:Env){
 if(env.ENVIRONMENT!=='poc'||env.MAIL_DELIVERY!=='disabled'||env.AI_EXPLANATIONS!=='disabled')throw new ProductError('FORBIDDEN',403);
}
async function owned(env:Env,id:string){
 const o=await env.DB.prepare('SELECT * FROM cancellation_probe WHERE id=?').bind(id).first<Owner>();
 if(!o)throw new ProductError('NOT_FOUND',404);
 const m=z.object({schema:z.literal('final-acceptance-fixture-v1'),profile:z.enum(['single','operational101']),jobIds:z.array(uuid),ids:z.record(z.string(),z.string()),commands:z.record(z.string(),z.unknown())}).strict().safeParse(JSON.parse(o.metadata));
 if(!m.success)throw new ProductError('FORBIDDEN',403);
 return {o,m:m.data};
}
export async function prepareFinalFixture(env:Env,input:z.infer<typeof finalFixturePrepare>){
 privateOnly(env);const c=finalFixturePrepare.parse(input),lease=crypto.randomUUID();
 const meta:Metadata={schema:'final-acceptance-fixture-v1',profile:c.profile,jobIds:c.jobIds,ids:{},commands:{}};
 const expiresAt=Date.now()+35*60000;
 // Owner is durable before any company/account provisioning. An uncertain
 // preparation is inspected and retired, never repeated to obtain credentials.
 try{await env.DB.prepare("INSERT INTO cancellation_probe(id,stage,metadata,results,lease,created_at,expires_at) VALUES (?,'FINAL_PREPARING',?,'[]',?,?,?)")
  .bind(c.ownerId,JSON.stringify(meta),lease,Date.now(),expiresAt).run();}
 catch{if(await env.DB.prepare('SELECT 1 FROM cancellation_probe WHERE id=?').bind(c.ownerId).first())throw new ProductError('PROBE_ALREADY_EXISTS');throw Error('FINAL_OWNER_CLAIM_FAILED');}
 try{
  let companyId:string,teamId:string,adminId:string,staffId:string,staffUser:string,email:string,password:string,staffEmail:string,staffPassword:string;
  if(c.profile==='single'){
   const f=await inputFixture(env.DB,env.INPUTS,name(c.ownerId));
   companyId=f.company.companyId;teamId=f.team;adminId=f.company.userId;staffId=f.staff.staffId;staffUser=f.staffUser;
   if(!f.staff.initialPassword)throw Error('FINAL_CREDENTIALS_UNCONFIRMED');
   email=f.email;password=f.company.initialPassword;staffPassword=f.staff.initialPassword;
   staffEmail=(await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(staffUser).first<string>('email'))!;
  }else{
   const credentials:{admin:{email:string;password:string}|null;staff:{email:string;staffId:string;password:string}|null}={admin:null,staff:null};
   const f=await registeredOperationalFixture(env,c.source,undefined,{
    companyIssued:(issued,issuedEmail)=>{credentials.admin={email:issuedEmail,password:issued.initialPassword};},
    firstStaffIssued:(issuedEmail,issuedId,initial)=>{credentials.staff={email:issuedEmail,staffId:issuedId,password:initial};},
   },name(c.ownerId));
   if(!credentials.admin||!credentials.staff)throw Error('FINAL_CREDENTIALS_UNCONFIRMED');
   // Callback assignments remain transient and are never put in metadata/logs.
   const a=credentials.admin,s=credentials.staff;
   companyId=f.companyId;teamId=f.team;adminId=f.userId;staffId=s.staffId;email=a.email;password=a.password;staffEmail=s.email;staffPassword=s.password;
   staffUser=(await env.DB.prepare('SELECT user_id FROM staff WHERE company_id=? AND id=?').bind(companyId,staffId).first<string>('user_id'))!;
  }
  await env.DB.batch([
   env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id IN (?,?)').bind(adminId,staffUser),
   env.DB.prepare("UPDATE cancellation_probe SET company_id=?,team_id=?,admin_user_id=?,staff_user_id=?,stage='FINAL_READY' WHERE id=? AND lease=?")
    .bind(companyId,teamId,adminId,staffUser,c.ownerId,lease),
  ]);
  return {ownerId:c.ownerId,companyId,teamId,month:'2026-10',staffCount:c.profile==='single'?1:101,
   email,password,staffLogin:{staffId,email:staffEmail,initialPassword:staffPassword},jobIds:c.jobIds,expiresAt};
 }catch{
  await env.DB.prepare("UPDATE cancellation_probe SET stage='FINAL_PREPARATION_FAILED' WHERE id=? AND lease=?").bind(c.ownerId,lease).run();
  throw Error('FINAL_PREPARATION_FAILED_INSPECT_EXISTING_OWNER');
 }finally{await env.DB.prepare('UPDATE cancellation_probe SET lease=NULL WHERE id=? AND lease=?').bind(c.ownerId,lease).run();}
}
export async function controlFinalFixture(env:Env,input:z.infer<typeof finalFixtureCommand>){
 privateOnly(env);const c=finalFixtureCommand.parse(input),{o,m}=await owned(env,c.ownerId);
 if(c.action==='status')return {...await runCancellationProbe(env,{probeId:c.ownerId,action:'status'}),ownerId:c.ownerId,jobIds:m.jobIds};
 if(c.action==='cleanup'){
  const cleaned=await runCancellationProbe(env,{probeId:c.ownerId,action:'cleanup'});
  await env.DB.prepare('UPDATE compute_probe SET cleaned_at=COALESCE(cleaned_at,?) WHERE company_id=? AND id IN (SELECT value FROM json_each(?))')
   .bind(Date.now(),o.company_id,JSON.stringify(m.jobIds)).run();
  return cleaned;
 }
 if(o.lease||o.cleaned_at!==null||o.expires_at<=Date.now()||o.stage!=='FINAL_READY'||!o.company_id||!o.team_id||!o.admin_user_id||!o.staff_user_id)throw new ProductError('PROBE_BUSY');
 const jobs=(await env.DB.prepare('SELECT id,state,attempt FROM compute_job WHERE company_id=? AND team_id=? ORDER BY created_at').bind(o.company_id,o.team_id).all<{id:string;state:string;attempt:number}>()).results;
 if(jobs.some(j=>!m.jobIds.includes(j.id)))throw new ProductError('FINAL_UNOWNED_JOB',409);
 const stub=env.SOLVER.getByName(`company:${o.company_id}:team:${o.team_id}`);
 if(c.action==='arm-fault'){
  if(m.profile!=='single')throw new ProductError('FORBIDDEN',403);
  const id=m.jobIds[1],job=await loadJob(env.DB,o.company_id,o.team_id,id);
  if(!job||job.state!=='RUNNING'||job.attempt!==1)throw new ProductError('FAULT_NOT_ALLOWED');
  await env.DB.prepare(`INSERT INTO compute_probe(id,company_id,team_id,admin_user_id,staff_user_id,results,expires_at)
   VALUES (?,?,?,?,?,'[]',?) ON CONFLICT(id) DO NOTHING`).bind(id,o.company_id,o.team_id,o.admin_user_id,o.staff_user_id,o.expires_at).run();
  const row=await env.DB.prepare('SELECT company_id,team_id,admin_user_id,staff_user_id,cleaned_at FROM compute_probe WHERE id=?').bind(id).first();
  if(!row||row.company_id!==o.company_id||row.team_id!==o.team_id||row.admin_user_id!==o.admin_user_id||row.staff_user_id!==o.staff_user_id||row.cleaned_at!==null)throw new ProductError('OPERATION_ID_CONFLICT');
  return {armed:true,jobId:id,attempt:1};
 }
 if(c.action==='release'){
  if(jobs.some(j=>['QUEUED','RUNNING','CANCELLING'].includes(j.state)))throw new ProductError('PROBE_BUSY');
  return {ownerId:c.ownerId,...await stub.releaseIdleProbe()};
 }
 return {ownerId:c.ownerId,companyId:o.company_id,teamId:o.team_id,jobIds:m.jobIds,jobs,execution:await stub.executionState(),expiresAt:o.expires_at};
}

// Exercise the real consumer with controlled envelopes, not the Queue broker.
// Only this private owner's terminal jobs can be delivered, twice each. A
// durable receipt precedes dispatch; lost responses never authorize replay.
async function deliveryDigest(env:Env,companyId:string){
 const tables=['compute_job','compute_attempt','compute_outbox','product_audit',
  'schedule_draft_head','schedule_draft_version','schedule_publication_head',
  'schedule_publication_version','schedule_publication_assignment',
  'schedule_publication_event','schedule_publication_notice','schedule_publication_commit'];
 const queries=[env.DB.prepare('SELECT * FROM company WHERE id=?').bind(companyId),
  ...tables.map(table=>env.DB.prepare(`SELECT * FROM ${table} WHERE company_id=?`).bind(companyId))];
 const rows=await env.DB.batch(queries),names=['company',...tables];
 const canonical=rows.map((r,i)=>({table:names[i],rows:r.results.map(row=>JSON.stringify(row)).sort()}));
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical)));
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
async function terminalResultDigests(env:Env,companyId:string,teamId:string,jobIds:string[]){
 const results=[];
 for(const jobId of jobIds){
  const job=await loadJob(env.DB,companyId,teamId,jobId);
  if(!job||['QUEUED','RUNNING','CANCELLING'].includes(job.state))throw new ProductError('PROBE_BUSY');
  if(job.result_key){
   const object=await env.INPUTS.get(job.result_key);
   if(!object)throw Error('FINAL_DELIVERY_RESULT_MISSING');
   const raw=await boundedBytes(object.body,8_000_000),digest=await crypto.subtle.digest('SHA-256',raw);
   const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
   if(hash!==job.result_sha256||raw.byteLength!==job.result_bytes)throw Error('FINAL_DELIVERY_RESULT_CHANGED');
   results.push({jobId,sha256:hash,bytes:raw.byteLength});
  }
 }
 return results;
}
export async function probeFinalDelivery(env:Env,input:z.infer<typeof finalDeliveryCommand>){
 privateOnly(env);const c=finalDeliveryCommand.parse(input),{o,m}=await owned(env,c.ownerId);
 const existing=z.object({operationId:uuid,state:z.enum(['RUNNING','COMPLETE','FAILED'])}).passthrough().safeParse(m.commands.delivery);
 if(c.action==='status'){
  if(!existing.success)throw new ProductError('NOT_FOUND',404);
  if(existing.data.operationId!==c.operationId)throw new ProductError('OPERATION_ID_CONFLICT');
  return {schema:'final-delivery-probe-v1',ownerId:c.ownerId,...existing.data};
 }
 if(m.commands.delivery!==undefined)throw new ProductError('PROBE_ALREADY_DISPATCHED');
 if(o.lease||o.cleaned_at!==null||o.expires_at<=Date.now()||o.stage!=='FINAL_READY'||!o.company_id||!o.team_id)throw new ProductError('PROBE_BUSY');
 const companyId=o.company_id,teamId=o.team_id;
 const jobs=(await env.DB.prepare('SELECT id,state FROM compute_job WHERE company_id=? AND team_id=?').bind(companyId,teamId).all<{id:string;state:string}>()).results;
 if(jobs.length!==m.jobIds.length||jobs.some(j=>!m.jobIds.includes(j.id)||['QUEUED','RUNNING','CANCELLING'].includes(j.state)))throw new ProductError('PROBE_BUSY');
 const stub=env.SOLVER.getByName(`company:${companyId}:team:${teamId}`);
 const idle=async()=>{const s=await stub.executionState();if(s.activeRpc||s.persistedFence||s.persistedCheckFence||s.processRunning)throw new ProductError('PROBE_BUSY');};
 await idle();
 m.commands.delivery={operationId:c.operationId,state:'RUNNING'};
 const lease=crypto.randomUUID(),accepted=await env.DB.prepare("UPDATE cancellation_probe SET lease=?,metadata=? WHERE id=? AND metadata=? AND lease IS NULL AND cleaned_at IS NULL AND expires_at>? AND stage='FINAL_READY' RETURNING id")
  .bind(lease,JSON.stringify(m),c.ownerId,o.metadata,Date.now()).all();
 if(accepted.results.length!==1)throw new ProductError('PROBE_BUSY');
 const persist=async(value:Record<string,unknown>)=>{m.commands.delivery=value;await env.DB.prepare('UPDATE cancellation_probe SET metadata=? WHERE id=? AND lease=?').bind(JSON.stringify(m),c.ownerId,lease).run();};
 try{
  const before=await deliveryDigest(env,companyId),objects=await terminalResultDigests(env,companyId,teamId,m.jobIds);
  const acknowledgements:string[]=[],retries:string[]=[];
  for(const copy of [1,2]){
   const messages:Message<unknown>[]=m.jobIds.map(jobId=>({id:jobId+':'+copy,timestamp:new Date(Date.now()-copy*60_000),attempts:copy+1,
    body:{version:1,companyId,teamId,jobId},ack(){acknowledgements.push(this.id);},retry(){retries.push(this.id);}}));
   const batch:MessageBatch<unknown>={queue:'final-controlled-terminal-delivery',metadata:{metrics:{backlogCount:messages.length,backlogBytes:0}},messages,
    ackAll(){for(const message of messages)message.ack();},retryAll(){for(const message of messages)message.retry();}};
   await handleJobBatch(batch,env);
  }
  await idle();
  const after=await deliveryDigest(env,companyId),afterObjects=await terminalResultDigests(env,companyId,teamId,m.jobIds);
  const expected=m.jobIds.flatMap(jobId=>[jobId+':1',jobId+':2']).sort();
  if(retries.length||JSON.stringify(acknowledgements.sort())!==JSON.stringify(expected)||before!==after||JSON.stringify(objects)!==JSON.stringify(afterObjects))throw Error('FINAL_DELIVERY_CHANGED_OR_UNCONFIRMED');
  const result={operationId:c.operationId,state:'COMPLETE',transport:'CONTROLLED_ENVELOPES_REAL_CONSUMER',jobIds:m.jobIds,deliveries:expected.length,acknowledged:expected.length,retries:0,beforeSha256:before,afterSha256:after,resultObjects:objects,idle:true};
  await persist(result);return {schema:'final-delivery-probe-v1',ownerId:c.ownerId,...result};
 }catch{
  await persist({operationId:c.operationId,state:'FAILED'});throw Error('FINAL_DELIVERY_FAILED_INSPECT_SAME_OPERATION');
 }finally{await env.DB.prepare('UPDATE cancellation_probe SET lease=NULL WHERE id=? AND lease=?').bind(c.ownerId,lease).run();}
}
