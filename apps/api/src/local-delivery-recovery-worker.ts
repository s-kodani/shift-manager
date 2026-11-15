// Loopback-only delivery rehearsal. Production/PoC entries never import this
// subclass. Barriers change timing, not the solver, checker, stop or adoption.
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import localWorker from './local-ui-worker';
import {OptimizerContainer as RealOptimizerContainer} from './optimizer-container';
import {boundedBytes,type JobMessage} from './compute-jobs';
import {maintenanceHeaders} from './maintenance';
const owner=z.object({fixtureId:z.string().uuid(),jobId:z.string().uuid()}).strict();
const prepare=owner.extend({phase:z.enum(['before-rpc','after-stop'])}).strict();
type Probe={job_id:string;fixture_id:string;phase:string;lease_id:string|null;released:number};
export class OptimizerContainer extends RealOptimizerContainer {
 private probe:Probe|null=null;
 override async containerFetch(...args:Parameters<RealOptimizerContainer['containerFetch']>){
  const response=await super.containerFetch(...args),p=this.probe;
  if(p&&response.ok){
   const address=String(args[0]);
   if(address.endsWith('/solve')||address.endsWith('/check')){
    const data=JSON.parse(new TextDecoder().decode(await boundedBytes(response.clone().body,16*1024*1024)));
    const value=address.endsWith('/solve')?data.solverStatus:data.status;
    if(typeof value!=='string'||!/^[A-Z_]{1,40}$/.test(value))throw new Error('LOCAL_DELIVERY_STATUS_INVALID');
    const column=address.endsWith('/solve')?'solver_status':'validation_status';
    await this.env.DB.prepare(`UPDATE local_delivery_probe SET ${column}=? WHERE job_id=?`).bind(value,p.job_id).run();
   }
  }
  return response;
 }
 private async wait(probe:Probe){
  const until=Date.now()+60_000;
  while(Date.now()<until){
   if(await this.env.DB.prepare('SELECT released FROM local_delivery_probe WHERE job_id=? AND fixture_id=?').bind(probe.job_id,probe.fixture_id).first('released')===1)return;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('LOCAL_DELIVERY_BARRIER_TIMEOUT');
 }
 protected override async terminateExecution(){
  await super.terminateExecution();
  const p=this.probe;
  if(p?.phase==='after-stop'){
   await this.env.DB.prepare("UPDATE local_delivery_probe SET state='WAITING_AFTER_STOP' WHERE job_id=? AND released=0").bind(p.job_id).run();
   await this.wait(p);
  }
 }
 override async runJob(message:JobMessage,leaseId?:string){
  // A normal unarmed delivery is passed through unchanged. Match a live owned
  // fixture and its company/team before permitting any timing intervention.
  const exists=await this.env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_delivery_probe' AND type='table'").first();
  const p=exists?await this.env.DB.prepare(`SELECT p.job_id,p.fixture_id,p.phase,p.lease_id,p.released FROM local_delivery_probe p
   JOIN local_ui_fixture f ON f.id=p.fixture_id JOIN team t ON t.company_id=f.company_id
   WHERE p.job_id=? AND f.company_id=? AND t.id=? AND f.cleaned_at IS NULL AND f.expires_at>?
   AND p.state='ARMED'`).bind(message.jobId,message.companyId,message.teamId,Date.now()).first<Probe>():null;
  if(!p)return super.runJob(message,leaseId);
  if(this.env.ENVIRONMENT!=='local'||!leaseId)throw new Error('LOCAL_DELIVERY_SCOPE_REQUIRED');
  this.probe=p;
  await this.env.DB.prepare('UPDATE local_delivery_probe SET lease_id=?,state=? WHERE job_id=?').bind(leaseId,p.phase==='before-rpc'?'WAITING_BEFORE_RPC':'RUNNING',p.job_id).run();
  try{
   if(p.phase==='before-rpc')await this.wait(p);
   const result=await super.runJob(message,leaseId);
   await this.env.DB.prepare("UPDATE local_delivery_probe SET state='RETURNED',outcome=? WHERE job_id=? AND EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='OPEN')").bind(result,p.job_id).run();
   return result;
  }catch(error){
   const code=String(error).includes('MAINTENANCE_LEASE_RETIRED')?'MAINTENANCE_LEASE_RETIRED':String(error).includes('LOCAL_DELIVERY_BARRIER_TIMEOUT')?'LOCAL_DELIVERY_BARRIER_TIMEOUT':'LOCAL_DELIVERY_RPC_FAILED';
   await this.env.DB.prepare("UPDATE local_delivery_probe SET state='REJECTED',outcome=? WHERE job_id=? AND EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='OPEN')").bind(code,p.job_id).run();
   throw error;
  }finally{this.probe=null;}
 }
}
const paths=new Set(['/__local/delivery-prepare','/__local/delivery-state','/__local/delivery-release']);
export default {
 ...localWorker,
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  const url=new URL(request.url);if(!paths.has(url.pathname))return localWorker.fetch(request,env,ctx);
  const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+env.POC_TOKEN);
  if(env.ENVIRONMENT!=='local'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!env.POC_TOKEN||actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'FORBIDDEN'},{status:403,headers:maintenanceHeaders});
  if(request.method!=='POST')return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
  try{
   const input=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,4096))),c=(url.pathname==='/__local/delivery-prepare'?prepare:owner).parse(input);
   const f=await env.DB.prepare('SELECT company_id FROM local_ui_fixture WHERE id=? AND cleaned_at IS NULL AND expires_at>?').bind(c.fixtureId,Date.now()).first<{company_id:string}>();
   if(!f)return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
   if(url.pathname==='/__local/delivery-prepare'){
    if(await env.DB.prepare('SELECT mode FROM maintenance_state WHERE id=1').first('mode')!=='OPEN')return Response.json({error:'MAINTENANCE_ACTIVE'},{status:503,headers:maintenanceHeaders});
    if(await env.DB.prepare('SELECT id FROM compute_job WHERE id=?').bind(c.jobId).first())return Response.json({error:'JOB_ALREADY_EXISTS'},{status:409,headers:maintenanceHeaders});
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS local_delivery_probe(job_id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,
     phase TEXT NOT NULL,lease_id TEXT,state TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0,outcome TEXT,solver_status TEXT,validation_status TEXT,
     FOREIGN KEY(fixture_id) REFERENCES local_ui_fixture(id))`).run();
    await env.DB.prepare("INSERT INTO local_delivery_probe(job_id,fixture_id,phase,state) VALUES (?,?,?,'ARMED')").bind(c.jobId,c.fixtureId,prepare.parse(input).phase).run();
   }else{
    if(!await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE name='local_delivery_probe' AND type='table'").first())return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
    if(url.pathname==='/__local/delivery-release')await env.DB.prepare("UPDATE local_delivery_probe SET released=1 WHERE job_id=? AND fixture_id=? AND EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='OPEN')").bind(c.jobId,c.fixtureId).run();
   }
   const row=await env.DB.prepare('SELECT job_id,fixture_id,phase,lease_id,state,released,outcome,solver_status,validation_status FROM local_delivery_probe WHERE job_id=? AND fixture_id=?').bind(c.jobId,c.fixtureId).first();
   return row?Response.json(row,{headers:maintenanceHeaders}):Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
  }catch{return Response.json({error:'LOCAL_DELIVERY_CONTROL_FAILED'},{status:500,headers:maintenanceHeaders});}
 },
};
