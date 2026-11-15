import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
import {FINAL_D1_CASES,verifyFinalD1,verifyD1Receipt} from '../../scripts/final-d1-check.mjs';
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const bound={...env,ENVIRONMENT:'poc',SOLVER:{getByName:()=>{throw Error('UNEXPECTED_SOLVER');}}} as unknown as Cloudflare.PocEnv;
const call=(body:object,token=true)=>worker.fetch(new Request('https://poc.invalid/__poc/final-d1',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+env.POC_TOKEN}:{})},body:JSON.stringify(body)}),bound);
it('owned final D1 performs five actual workerd cases once, retains receipt and cleans only its synthetic rows',async()=>{
 const id=crypto.randomUUID(),events:Record<string,unknown>[]=[],calls:object[]=[];
 const result=await verifyFinalD1({operationId:id,record:async v=>{events.push(v);},request:async(route,body,options={})=>{
  expect(route).toBe('/__poc/final-d1');if(!options.withoutToken&&(body as {action:string}).action==='run')expect(events.at(-1)?.stage).toBe('RUN_DISPATCHED');calls.push(body);return call(body,!options.withoutToken);
 }});
 expect(result.stage).toBe('VERIFIED');expect(result.runPosts).toBe(1);
 const inspected=await call({operationId:id,action:'status'});expect(inspected.status).toBe(200);const receipt=verifyD1Receipt(await inspected.json(),id);expect(receipt.results.map(r=>r.case)).toEqual(FINAL_D1_CASES);
 expect((await call({operationId:id,action:'run'})).status).toBe(409);expect(await (await call({operationId:id,action:'status'})).json()).toEqual(receipt);
 expect(await env.DB.prepare("SELECT count(*) n FROM schedule WHERE tenant_id='fictional-poc' AND team_id=?").bind(id).first<number>('n')).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) n FROM compute_job').first<number>('n')).toBe(0);expect(calls.length).toBe(3);
});
it('duplicate concurrent run has one producer, other owners coexist, missing receipts and invalid/foreign environment are denied',async()=>{
 const a=crypto.randomUUID(),b=crypto.randomUUID(),pair=await Promise.all([call({operationId:a,action:'run'}),call({operationId:a,action:'run'})]);expect(pair.map(r=>r.status).sort()).toEqual([200,409]);
 expect((await call({operationId:b,action:'run'})).status).toBe(200);for(const id of [a,b])expect(verifyD1Receipt(await (await call({operationId:id,action:'status'})).json(),id).remainingRows).toBe(0);
 expect((await call({operationId:crypto.randomUUID(),action:'status'})).status).toBe(404);expect((await call({operationId:a,action:'run'},false)).status).toBe(403);
 const request=new Request('https://poc.invalid/__poc/final-d1',{method:'POST',headers:{authorization:'Bearer '+env.POC_TOKEN},body:JSON.stringify({operationId:a,action:'status'})});expect((await worker.fetch(request,{...bound,ENVIRONMENT:'production'})).status).toBe(403);
 expect((await call({operationId:'bad',action:'run'})).status).toBe(400);
});
it('lost run response records uncertainty and never dispatches another producer; empty/duplicate success cases are rejected',async()=>{
 const id=crypto.randomUUID(),events:Record<string,unknown>[]=[];let accepted=0;
 await expect(verifyFinalD1({operationId:id,record:async v=>{events.push(v);},request:async(_route,body,options)=>{
  const r=await call(body,!options?.withoutToken);if(!options?.withoutToken&&(body as {action:string}).action==='run'){accepted++;await r.body?.cancel();throw Error('RESPONSE_LOST');}return r;
 }})).rejects.toThrow('FINAL_D1_UNCONFIRMED_INSPECT_SAME_OPERATION');expect(accepted).toBe(1);expect(events.at(-1)?.stage).toBe('UNCERTAIN');
 const receipt=verifyD1Receipt(await (await call({operationId:id,action:'status'})).json(),id);expect(()=>verifyD1Receipt({...receipt,results:[]},id)).toThrow();expect(()=>verifyD1Receipt({...receipt,results:Array(5).fill(receipt.results[0])},id)).toThrow();
});
