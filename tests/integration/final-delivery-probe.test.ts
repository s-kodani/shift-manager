import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,it,expect,vi} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
import {prepareFinalFixture,probeFinalDelivery} from '../../apps/api/src/final-fixture-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob} from '../../apps/api/src/compute-jobs';
import {executeJob} from '../../apps/api/src/compute-execution';
import {verifyFinalDelivery} from '../../scripts/final-delivery-check.mjs';

// Actual workerd D1/R2/DO and consumer; controlled SDK never starts a process.
const transportCalls=vi.hoisted(()=>({count:0}));
vi.mock('@cloudflare/containers',async()=>{
 const {DurableObject}=await import('cloudflare:workers');
 return {Container:class extends DurableObject<Env>{
  constructor(state:DurableObjectState,bindings:Env){super(state,bindings);Object.defineProperty(state,'container',{value:{running:false,async destroy(){}}});}
  async containerFetch():Promise<Response>{transportCalls.count++;throw Error('UNEXPECTED_SOLVER_START');}
  renewActivityTimeout(){}
 }};
});
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const bindings=()=>({...env,ENVIRONMENT:'poc',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled'});
const post=(body:unknown,token=true)=>new Request(env.AUTH_BASE_URL+'/__poc/final-delivery',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+env.POC_TOKEN}:{})},body:JSON.stringify(body)});
async function fixture(complete=true){
 const c={ownerId:crypto.randomUUID(),profile:'single' as const,jobIds:Array.from({length:3},()=>crypto.randomUUID())},f=await prepareFinalFixture(bindings(),c);
 const actor=(await env.DB.prepare('SELECT admin_user_id FROM cancellation_probe WHERE id=?').bind(c.ownerId).first<string>('admin_user_id'))!;
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(actor).run();
 const snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,f.companyId,f.teamId,actor,{operationId:snapshotId,expectedRevision:9,month:f.month});
 for(const jobId of c.jobIds){
  await createJob(env.DB,env.INPUTS,f.companyId,f.teamId,actor,{operationId:jobId,snapshotId,expectedRevision:9});
  if(complete)expect(await executeJob({DB:env.DB,INPUTS:env.INPUTS},{version:1,companyId:f.companyId,teamId:f.teamId,jobId},async(_route,input)=>Response.json({...input,solverStatus:'UNKNOWN',assignments:null}),async()=>{})).toBe('DONE');
  else break;
 }
 return {...f,command:{ownerId:c.ownerId,operationId:crypto.randomUUID(),action:'run' as const}};
}
it('two late envelopes per terminal job use the real consumer, preserve results/history and dispatch only once',async()=>{
 const f=await fixture(),records:unknown[]=[];
 const request=async(_route:string,body:unknown)=>worker.fetch(post(body),bindings());
 const result=await verifyFinalDelivery({ownerId:f.ownerId,operationId:f.command.operationId,jobIds:f.jobIds,request,record:async v=>{records.push(v);}});
 expect(result).toMatchObject({stage:'VERIFIED',runPosts:1,receipt:{deliveries:6,acknowledged:6,retries:0,idle:true}});
 expect(transportCalls.count).toBe(0);expect(records).toHaveLength(2);
 const original=await probeFinalDelivery(bindings(),{...f.command,action:'status'});
 expect((await worker.fetch(post(f.command),bindings())).status).toBe(409);
 expect(await probeFinalDelivery(bindings(),{...f.command,action:'status'})).toEqual(original);
 expect(await env.DB.prepare('SELECT count(*) n FROM compute_attempt WHERE company_id=?').bind(f.companyId).first('n')).toBe(3);
 expect(await env.DB.prepare('SELECT count(*) n FROM maintenance_lease WHERE completed_at IS NULL').first('n')).toBe(0);
});
it('missing token, foreign owner, unfinished jobs and an expired owner cannot deliver',async()=>{
 const f=await fixture(false);
 expect((await worker.fetch(post(f.command,false),bindings())).status).toBe(403);
 expect((await worker.fetch(post(f.command),{...bindings(),ENVIRONMENT:'production'})).status).toBe(403);
 expect((await worker.fetch(post({...f.command,jobIds:f.jobIds}),bindings())).status).toBe(400);
 expect((await worker.fetch(post({...f.command,ownerId:crypto.randomUUID()}),bindings())).status).toBe(404);
 expect((await worker.fetch(post(f.command),bindings())).status).toBe(409);
 await env.DB.prepare('UPDATE cancellation_probe SET expires_at=0 WHERE id=?').bind(f.ownerId).run();
 expect((await worker.fetch(post(f.command),bindings())).status).toBe(409);
 expect(transportCalls.count).toBe(0);
 expect(await env.DB.prepare('SELECT json_extract(metadata,\'$.commands.delivery\') v FROM cancellation_probe WHERE id=?').bind(f.ownerId).first('v')).toBeNull();
});
it('result corruption retains a failed receipt, clears its lease and refuses replay',async()=>{
 const f=await fixture(),key=(await env.DB.prepare('SELECT result_key FROM compute_job WHERE company_id=? AND id=?').bind(f.companyId,f.jobIds[0]).first<string>('result_key'))!;
 await env.INPUTS.put(key,'corrupted fictional result');
 expect((await worker.fetch(post(f.command),bindings())).status).toBe(500);
 expect(await probeFinalDelivery(bindings(),{...f.command,action:'status'})).toMatchObject({state:'FAILED',operationId:f.command.operationId});
 expect(await env.DB.prepare('SELECT lease FROM cancellation_probe WHERE id=?').bind(f.ownerId).first('lease')).toBeNull();
 expect((await worker.fetch(post(f.command),bindings())).status).toBe(409);expect(transportCalls.count).toBe(0);
});
it('an acknowledged delivery that changes audit data is failed rather than accepted',async()=>{
 const f=await fixture();let writes=0;
 const solver=new Proxy(env.SOLVER,{get(target,key){
  if(key==='getByName')return (name:string)=>new Proxy(target.getByName(name),{get(stub,field){
   if(field==='runJob')return async()=>{
    if(writes++===0)await env.DB.prepare("INSERT INTO product_audit(company_id,id,kind,revision,recorded_at) VALUES (?,?,'fictional:unexpected-delivery',9,?)").bind(f.companyId,crypto.randomUUID(),Date.now()).run();
    return 'DONE';
   };
   const value=Reflect.get(stub,field,stub);return typeof value==='function'?(...args:unknown[])=>Reflect.apply(value,stub,args):value;
  }});
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(probeFinalDelivery({...bindings(),SOLVER:solver},f.command)).rejects.toThrow('FINAL_DELIVERY_FAILED_INSPECT_SAME_OPERATION');
 expect(await probeFinalDelivery(bindings(),{...f.command,action:'status'})).toMatchObject({state:'FAILED'});
 expect(writes).toBe(6);expect(transportCalls.count).toBe(0);
});
