// PoC-only receipts around the existing synthetic storage probe, no solver.
import {z} from 'zod';
import {runD1Probes} from './poc-probes';
import {ProductError} from './product';
export const finalD1Command=z.object({operationId:z.string().uuid(),action:z.enum(['run','status'])}).strict();
async function setup(db:D1Database){await db.prepare(`CREATE TABLE IF NOT EXISTS final_d1_probe (
 id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETE','FAILED')),
 results_json TEXT,created_at INTEGER NOT NULL,finished_at INTEGER)`).run();}
export async function finalD1Probe(env:Env,input:z.infer<typeof finalD1Command>){
 if(env.ENVIRONMENT!=='poc')throw new ProductError('FORBIDDEN',403);
 const c=finalD1Command.parse(input);await setup(env.DB);
 if(c.action==='run'){
  const accepted=await env.DB.prepare("INSERT INTO final_d1_probe VALUES (?,'RUNNING',NULL,?,NULL) ON CONFLICT(id) DO NOTHING RETURNING id").bind(c.operationId,Date.now()).all<{id:string}>();
  if(accepted.results.length!==1)throw new ProductError('PROBE_ALREADY_DISPATCHED',409);
  try{
   const results=await runD1Probes(env.DB,c.operationId);
   await env.DB.prepare("UPDATE final_d1_probe SET state='COMPLETE',results_json=?,finished_at=? WHERE id=? AND state='RUNNING'").bind(JSON.stringify(results),Date.now(),c.operationId).run();
  }catch{
   await env.DB.prepare("UPDATE final_d1_probe SET state='FAILED',finished_at=? WHERE id=? AND state='RUNNING'").bind(Date.now(),c.operationId).run();
  }
 }
 const row=await env.DB.prepare('SELECT id,state,results_json,created_at,finished_at FROM final_d1_probe WHERE id=?').bind(c.operationId).first<{id:string;state:string;results_json:string|null;created_at:number;finished_at:number|null}>();
 if(!row)throw new ProductError('NOT_FOUND',404);
 const remaining=await env.DB.prepare(`SELECT
  (SELECT count(*) FROM schedule WHERE tenant_id='fictional-poc' AND team_id=?) +
  (SELECT count(*) FROM participation WHERE tenant_id='fictional-poc' AND team_id=?) +
  (SELECT count(*) FROM operation WHERE tenant_id='fictional-poc' AND team_id=?) AS n`).bind(c.operationId,c.operationId,c.operationId).first<number>('n');
 return {schema:'final-d1-probe-v1',operationId:row.id,state:row.state,results:row.results_json?JSON.parse(row.results_json):[],remainingRows:remaining,createdAt:row.created_at,finishedAt:row.finished_at};
}
