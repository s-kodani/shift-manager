// Read-only inventory of every team object plus the dedicated synthetic object.
// This is a PoC deployment precondition, not a maintenance/admission lock.
import {z} from 'zod';

const counts=z.object({activeJobs:z.number().int().nonnegative(),activeRevalidations:z.number().int().nonnegative()});
const team=z.object({company_id:z.string(),id:z.string()});
const execution=z.object({activeRpc:z.boolean(),persistedFence:z.boolean(),persistedCheckFence:z.boolean(),processRunning:z.boolean()});
export async function pocDeployPreflight(env:Pick<Env,'DB'|'ENVIRONMENT'>,inspect:(name:string)=>Promise<unknown>){
 if(env.ENVIRONMENT!=='poc')throw new Error('PREFLIGHT_FORBIDDEN');
 const inventory=async()=>{
  const [c,t]=await env.DB.batch([
   env.DB.prepare(`SELECT (SELECT count(*) FROM compute_job WHERE state IN ('QUEUED','RUNNING','CANCELLING')) AS activeJobs,
    (SELECT count(*) FROM publication_revalidation_request WHERE state IN ('PENDING','RUNNING')) AS activeRevalidations`),
   env.DB.prepare('SELECT company_id,id FROM team ORDER BY company_id,id LIMIT 1025'),
  ]);
  return {counts:counts.parse(c.results[0]),teams:z.array(team).parse(t.results)};
 };
 const before=await inventory();
 const report={schema:'poc-deploy-preflight-v1',observedAt:new Date().toISOString(),ready:false,...before.counts,
  checkedObjects:0,busyObjects:0,inventoryStable:false};
 if(before.counts.activeJobs||before.counts.activeRevalidations||before.teams.length>1024)return report;
 const names=['synthetic-poc',...before.teams.map(t=>`company:${t.company_id}:team:${t.id}`)];
 // Bound RPC concurrency; executionState never starts or destroys a process.
 for(let i=0;i<names.length;i+=4){
  const states=await Promise.all(names.slice(i,i+4).map(inspect));
  for(const state of states){const s=execution.parse(state);report.checkedObjects++;if(s.activeRpc||s.persistedFence||s.persistedCheckFence||s.processRunning)report.busyObjects++;}
 }
 const after=await inventory();
 report.activeJobs=after.counts.activeJobs;report.activeRevalidations=after.counts.activeRevalidations;
 report.inventoryStable=JSON.stringify(before.teams)===JSON.stringify(after.teams);
 report.ready=report.inventoryStable&&!report.busyObjects&&!report.activeJobs&&!report.activeRevalidations;
 report.observedAt=new Date().toISOString();return report;
}
