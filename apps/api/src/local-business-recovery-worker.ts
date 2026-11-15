// Dedicated loopback entry only. Product, PoC and restored production entries
// never import this controlled admission barrier. Candidate payloads stay in
// request memory; the control table stores identifiers and checker status only.
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import localWorker from './local-ui-worker';
import {boundedBytes} from './compute-jobs';
import {candidateCommand,candidateResult} from './draft-contract';
import {MaintenanceError,maintenanceHeaders} from './maintenance';
import {withMaintenanceBusiness} from './maintenance-business';
export {OptimizerContainer} from './optimizer-container';
const owner=z.object({fixtureId:z.string().uuid(),probeId:z.string().uuid()}).strict();
const submission=owner.extend({candidate:candidateCommand,
 phase:z.enum(['direct','before-rpc','after-rpc']),
}).strict();
const paths=new Set(['/__local/business-check','/__local/business-check-state','/__local/business-check-release']);
async function fixture(db:D1Database,id:string){
 return db.prepare('SELECT company_id FROM local_ui_fixture WHERE id=? AND cleaned_at IS NULL AND expires_at>?').bind(id,Date.now()).first<{company_id:string}>();
}
export default {
 ...localWorker,
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  const url=new URL(request.url);
  if(!paths.has(url.pathname))return localWorker.fetch(request,env,ctx);
  const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+env.POC_TOKEN);
  if(env.ENVIRONMENT!=='local'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)
   ||!env.POC_TOKEN||actual.length!==expected.length||!timingSafeEqual(actual,expected))
   return Response.json({error:'FORBIDDEN'},{status:403,headers:maintenanceHeaders});
  if(request.method!=='POST')return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
  try{
   const input=JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,16*1024*1024)));
   const c=(url.pathname==='/__local/business-check'?submission:owner).parse(input);
   const f=await fixture(env.DB,c.fixtureId);if(!f)return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
   if(url.pathname!=='/__local/business-check'){
    // Observation must not initialize a table while a source is frozen.
    if(!await env.DB.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='local_business_check_probe'").first())
     return Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
    if(url.pathname==='/__local/business-check-release'){
     // The barrier controller cannot mutate even its own metadata while the
     // source is frozen. Resume explicitly before releasing a delayed callback.
     await env.DB.prepare(`UPDATE local_business_check_probe SET released=1 WHERE id=? AND fixture_id=?
      AND EXISTS(SELECT 1 FROM maintenance_state WHERE id=1 AND mode='OPEN')`).bind(c.probeId,c.fixtureId).run();
    }
    const row=await env.DB.prepare('SELECT id,lease_id,phase,validation_status,released FROM local_business_check_probe WHERE id=? AND fixture_id=?').bind(c.probeId,c.fixtureId).first();
    return row?Response.json(row,{headers:maintenanceHeaders}):Response.json({error:'NOT_FOUND'},{status:404,headers:maintenanceHeaders});
   }
   const command=submission.parse(input);
   if(command.candidate.companyId!==f.company_id)return Response.json({error:'FORBIDDEN'},{status:403,headers:maintenanceHeaders});
   const result=await withMaintenanceBusiness(env,async(scoped,leaseId)=>{
    const belongs=await scoped.DB.prepare(`SELECT 1 FROM input_snapshot s JOIN company_admin a ON a.company_id=s.company_id
     WHERE s.company_id=? AND s.team_id=? AND s.id=? AND a.user_id=?`).bind(f.company_id,command.candidate.teamId,command.candidate.snapshotId,command.candidate.userId).first();
    if(!belongs)throw new Error('LOCAL_CHECK_SCOPE');
    await scoped.DB.prepare(`CREATE TABLE IF NOT EXISTS local_business_check_probe(
     id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,lease_id TEXT NOT NULL,
     phase TEXT NOT NULL,validation_status TEXT,released INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY(fixture_id) REFERENCES local_ui_fixture(id))`).run();
    await scoped.DB.prepare('INSERT INTO local_business_check_probe(id,fixture_id,lease_id,phase) VALUES (?,?,?,?)').bind(command.probeId,command.fixtureId,leaseId,command.phase==='before-rpc'?'WAITING_BEFORE_RPC':'CHECKING').run();
    const wait=async()=>{
     const until=Date.now()+60000;
     while(Date.now()<until){
      // Read-only test-controller polling, outside the retired product scope.
      const released=await env.DB.prepare('SELECT released FROM local_business_check_probe WHERE id=? AND fixture_id=?').bind(command.probeId,command.fixtureId).first('released');
      if(released===1)return;
      await new Promise(resolve=>setTimeout(resolve,100));
     }
     throw new Error('LOCAL_CHECK_BARRIER_TIMEOUT');
    };
    if(command.phase==='before-rpc')await wait();
    try{
     const checked=candidateResult.parse(await scoped.SOLVER.getByName(`company:${command.candidate.companyId}:team:${command.candidate.teamId}`).checkDraft(command.candidate));
     await scoped.DB.prepare('UPDATE local_business_check_probe SET phase=?,validation_status=? WHERE id=? AND fixture_id=?')
      .bind(command.phase==='after-rpc'?'WAITING_AFTER_RPC':'CHECKED',checked.validation.status,command.probeId,command.fixtureId).run();
     if(command.phase==='after-rpc')await wait();
     return checked;
    }catch(error){
     // RPC errors cross an isolate boundary. Re-read the SQL authority rather
     // than trusting a remote Error constructor to retain its subclass.
     await scoped.DB.prepare('SELECT 1').first();throw error;
    }
   });
   return Response.json({result,scope:'local SDK checker only; no draft adoption'},{headers:maintenanceHeaders});
  }catch(error){
   if(error instanceof MaintenanceError)return Response.json({error:error.code},{status:503,headers:maintenanceHeaders});
   return Response.json({error:'LOCAL_BUSINESS_CHECK_FAILED'},{status:500,headers:maintenanceHeaders});
  }
 },
};
