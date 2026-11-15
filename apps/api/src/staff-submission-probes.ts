import {settledMaintenanceWork} from './maintenance';
import {interceptProbeBatch} from './probe-database';
// Dedicated fictional PoC only; never exported by product/local entry points.
import { z } from 'zod';
import { createApp } from './index';
import { inputFixture } from './input-probes';
import { ProductError } from './product';
import { saveInputVersion } from './input-versions';
import { createInputSnapshot,readInputSnapshot } from './input-snapshots';
import { submissionContext,submissionReceipt } from './staff-submission-contract';

export const submissionProbeCommand=z.object({probeId:z.string().uuid()}).strict();
const label=(id:string)=>'架空本人提出検証:'+id;
const users=`SELECT user_id FROM company_admin WHERE company_id IN (SELECT id FROM company WHERE name=?) UNION SELECT user_id FROM staff WHERE company_id IN (SELECT id FROM company WHERE name=?)`;
const privateOnly=(env:Env)=>{if(env.ENVIRONMENT!=='poc')throw new ProductError('FORBIDDEN',403);};
export async function inspectSubmissionProbe(env:Env,id:string) {
  privateOnly(env);submissionProbeCommand.parse({probeId:id});const name=label(id);
  const companies=(await env.DB.prepare('SELECT id,revision FROM company WHERE name=?').bind(name).all<{id:string;revision:number}>()).results;
  const count=(table:string,condition:string)=>env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE ${condition} IN (${users})`).bind(name,name).first<number>('n');
  return {probeId:id,companies,enabled:(await count('access_state','enabled=1 AND user_id'))!,sessions:(await count('session','userId'))!,passwords:(await count('account','password IS NOT NULL AND userId'))!};
}
export async function cleanupSubmissionProbe(env:Env,id:string) {
  privateOnly(env);submissionProbeCommand.parse({probeId:id});const name=label(id);
  if(await env.DB.prepare("SELECT count(*) n FROM compute_job WHERE company_id IN (SELECT id FROM company WHERE name=?) AND state IN ('QUEUED','RUNNING','CANCELLING')").bind(name).first<number>('n'))throw new ProductError('PROBE_BUSY');
  await env.DB.batch([
    env.DB.prepare(`UPDATE access_state SET enabled=0 WHERE user_id IN (${users})`).bind(name,name),
    env.DB.prepare(`DELETE FROM session WHERE userId IN (${users})`).bind(name,name),
    env.DB.prepare(`DELETE FROM verification WHERE value IN (${users})`).bind(name,name),
    env.DB.prepare(`UPDATE account SET password=NULL WHERE userId IN (${users})`).bind(name,name),
  ]);
  return inspectSubmissionProbe(env,id);
}
export async function runSubmissionProbes(env:Env,data:z.infer<typeof submissionProbeCommand>) {
  privateOnly(env);const c=submissionProbeCommand.parse(data);
  if((await inspectSubmissionProbe(env,c.probeId)).companies.length)throw new ProductError('PROBE_ALREADY_EXISTS');
  const start=Date.now(),results:{name:string;passed:true}[]=[];
  const ensure=(ok:unknown)=>{if(!ok)throw new Error('SUBMISSION_PROBE_FAILED');};
  const record=(name:string)=>results.push({name,passed:true});
  let cleanup:Awaited<ReturnType<typeof inspectSubmissionProbe>>|null=null;
  try {
    const f=await inputFixture(env.DB,env.INPUTS,label(c.probeId)),company=f.company.companyId,app=createApp();
    const prefix=`/api/companies/${company}/inputs/teams/${f.team}`;
    const current=new Date(Date.now()+9*3600000).toISOString().slice(0,7),future='2099-10';
    const request=async(path:string,body?:object,cookie='',expected=200,bindings=env)=>{
      const r=await app.request(env.AUTH_BASE_URL+path,{method:body?'POST':'GET',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json',cookie},...(body?{body:JSON.stringify(body)}:{})},bindings);
      if(r.status!==expected||r.headers.get('cache-control')!=='no-store')throw new Error(`SUBMISSION_PROBE_HTTP:${r.status}:${expected}`);
      return {data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]??''};
    };
    const email=(await env.DB.prepare('SELECT email FROM user WHERE id=?').bind(f.staffUser).first<string>('email'))!;
    let staffCookie=(await request('/api/auth/sign-in/email',{email,password:f.staff.initialPassword})).cookie;
    await request(prefix+'/self-month/'+future,undefined,staffCookie,403);
    const newPassword='Fictional-'+crypto.randomUUID();
    await request('/api/password',{currentPassword:f.staff.initialPassword,newPassword},staffCookie);
    staffCookie=(await request('/api/auth/sign-in/email',{email,password:newPassword})).cookie;
    ensure(submissionContext.parse((await request(prefix+'/self-month/'+future,undefined,staffCookie)).data).staffId===f.staff.staffId);
    record('native_first_change_gate_and_own_only_context');
    const managerCookie=(await request('/api/auth/sign-in/email',{email:f.email,password:f.company.initialPassword})).cookie;
    const revision=async()=>(await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(company).first<number>('revision'))!;
    const command=async(month:string)=>({operationId:crypto.randomUUID(),expectedRevision:await revision(),payload:{unavailable:[{date:month+'-02',start:607,end:617}],preferences:[{date:month+'-01',kind:'work'},{date:month+'-01',kind:'pattern',patternId:'day'}]}});
    const self=async(body:Awaited<ReturnType<typeof command>>,month=future,expected=200,bindings=env)=>request(prefix+'/self-month/'+month,body,staffCookie,expected,bindings);
    const first=await command(future),before=await revision();
    const faultDB=interceptProbeBatch(env.DB,'INSERT INTO input_operation',
      statements=>[...statements,env.DB.prepare('SELECT abs(-9223372036854775808)')]);
    await self(first,future,500,{...env,DB:faultDB});ensure(await revision()===before);
    ensure(!await env.DB.prepare('SELECT 1 FROM input_operation WHERE company_id=? AND id=?').bind(company,first.operationId).first());
    record('late_real_D1_failure_rolls_back_input_revision_receipt_and_audit');
    const outcomes=await settledMaintenanceWork([self(first),self(first)]);
    ensure(outcomes.map(r=>submissionReceipt.parse(r.data).replayed).filter(Boolean).length===1&&await revision()===before+1);
    const own=submissionContext.parse((await request(prefix+'/self-month/'+future,undefined,staffCookie)).data);
    ensure(JSON.stringify(own.version?.payload)===JSON.stringify(first.payload));
    await self({...first,payload:{...first.payload,preferences:[]}},future,409);
    await self({...first,operationId:crypto.randomUUID()},future,409);
    record('same_ID_one_save_exact_minutes_separate_wishes_and_stale_conflict');
    const closed=await command(current);await self(closed,current,409);
    await request(prefix+'/submission-window/'+current,{operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000},staffCookie,403);
    ensure(!submissionContext.parse((await request(prefix+'/self-month/'+current,undefined,staffCookie)).data).accepting);
    record('unavailable_and_wishes_share_deadline_staff_cannot_reopen');
    const windowCommand={operationId:crypto.randomUUID(),expectedRevision:0,closesAt:Date.now()+60000},inputBeforeWindow=await revision();
    const windows=await settledMaintenanceWork([0,1].map(()=>request(prefix+'/submission-window/'+current,windowCommand,managerCookie)));
    ensure(windows.map(r=>submissionReceipt.parse(r.data).replayed).filter(Boolean).length===1&&await revision()===inputBeforeWindow);
    await self(closed,current);
    await request(prefix+'/submission-window/'+current,{operationId:crypto.randomUUID(),expectedRevision:1,closesAt:null},managerCookie);
    ensure(submissionReceipt.parse((await self(closed,current)).data).replayed);
    await self(await command(current),current,409);
    record('manager_window_own_revision_reopening_closure_and_late_acknowledgment');
    const parallel=await command(future);
    const pair=await settledMaintenanceWork([parallel,{...parallel,operationId:crypto.randomUUID()}].map(body=>app.request(env.AUTH_BASE_URL+prefix+'/self-month/'+future,{method:'POST',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json',cookie:staffCookie},body:JSON.stringify(body)},env)));
    ensure(pair.map(r=>r.status).sort().join(',')==='200,409');for(const r of pair)await r.body?.cancel();
    record('different_ID_same_revision_one_winner');
    await request(prefix+'/planning/'+future,undefined,staffCookie,403);
    await request(`/api/companies/${crypto.randomUUID()}/inputs/teams/${f.team}/self-month/${future}`,undefined,staffCookie,403);
    record('manager_and_foreign_scope_reads_forbidden');
    await saveInputVersion(env.DB,{company,team:f.team,staff:null,kind:'planning',entity:f.team},f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),effectiveFrom:future,payload:{demand:[],events:[],roleRequirements:[]}},env.INPUTS);
    const snapshot=await createInputSnapshot(env.DB,env.INPUTS,company,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:await revision(),month:future});
    const frozen=await readInputSnapshot(env.DB,env.INPUTS,company,f.team,f.company.userId,snapshot.snapshot!.id);
    ensure(frozen.input.staff[0].unavailable[0].start===607&&frozen.input.staff[0].preferences.length===2&&JSON.parse(snapshot.snapshot!.lineage).some((r:{kind:string})=>r.kind==='staff_month'));
    record('R2_snapshot_uses_accepted_immutable_monthly_input');
    const final=await command(future),finalRevision=await revision();
    const revokeDB=interceptProbeBatch(env.DB,'INSERT INTO input_operation',async statements=>{
      await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.staffUser).run();return statements;
    });
    await self(final,future,403,{...env,DB:revokeDB});ensure(await revision()===finalRevision);
    record('access_revocation_at_write_prevents_partial_save');
  }finally{cleanup=await cleanupSubmissionProbe(env,c.probeId);}
  ensure(cleanup&&cleanup.companies.length&&cleanup.enabled+cleanup.sessions+cleanup.passwords===0);
  return {scope:'private-fictional-staff-submission',probeId:c.probeId,results,elapsedMilliseconds:Date.now()-start,cleanup};
}
