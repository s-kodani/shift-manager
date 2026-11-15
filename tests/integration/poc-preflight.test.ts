import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import {inputFixture} from '../../apps/api/src/input-probes';
import {pocDeployPreflight} from '../../apps/api/src/poc-preflight';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,cancelJob} from '../../apps/api/src/compute-jobs';
import worker from '../../apps/api/src/poc-worker';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const idle={activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false};
const settings=()=>({DB:env.DB,ENVIRONMENT:'poc'});
it('preflight is token protected and forbidden in local/production environments',async()=>{
 const request=(token:string)=>new Request('https://poc.invalid/__poc/deploy-preflight',{method:'POST',headers:{authorization:`Bearer ${token}`}});
 expect((await worker.fetch(request('wrong'),env)).status).toBe(403);
 for(const environment of ['local','production'])expect((await worker.fetch(request(env.POC_TOKEN),{...env,ENVIRONMENT:environment})).status).toBe(403);
});
it('every registered team and synthetic object are inspected, without leaking names, IDs or boot data',async()=>{
 const f=await inputFixture(env.DB),seen:string[]=[];
 const report=await pocDeployPreflight(settings(),async name=>{seen.push(name);return {...idle,bootId:'private-boot'};});
 const teams=(await env.DB.prepare('SELECT company_id,id FROM team').all<{company_id:string;id:string}>()).results;
 expect(new Set(seen)).toEqual(new Set(['synthetic-poc',...teams.map(t=>`company:${t.company_id}:team:${t.id}`)]));
 expect(report).toMatchObject({ready:true,checkedObjects:teams.length+1,busyObjects:0,activeJobs:0,activeRevalidations:0,inventoryStable:true});
 expect(JSON.stringify(report)).not.toContain(f.company.companyId);expect(JSON.stringify(report)).not.toContain('private-boot');
});
it.each(['activeRpc','persistedFence','persistedCheckFence','processRunning'] as const)('a %s in a team without an active D1 job blocks deployment',async field=>{
 const f=await inputFixture(env.DB),target=`company:${f.company.companyId}:team:${f.team}`;
 const report=await pocDeployPreflight(settings(),async name=>name===target?{...idle,[field]:true}:idle);
 expect(report.ready).toBe(false);expect(report.busyObjects).toBe(1);
});
it('queued jobs block before reading process state, even if no process has started',async()=>{
 const f=await inputFixture(env.DB),snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 const id=crypto.randomUUID();await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});
 const report=await pocDeployPreflight(settings(),async()=>{throw Error('must not inspect');});
 expect(report).toMatchObject({ready:false,activeJobs:1,checkedObjects:0});
 await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:0});
});
it('RPC failure or malformed state does not produce ready evidence',async()=>{
 await expect(pocDeployPreflight(settings(),async()=>{throw Error('RPC failed');})).rejects.toThrow('RPC failed');
 await expect(pocDeployPreflight(settings(),async()=>({activeRpc:false}))).rejects.toThrow();
});
it('an inventory change during inspection is detected before returning ready',async()=>{
 await inputFixture(env.DB);let changed=false;
 const report=await pocDeployPreflight(settings(),async()=>{if(!changed){changed=true;await inputFixture(env.DB);}return idle;});
 expect(report).toMatchObject({ready:false,inventoryStable:false});
});
it('a new job in an existing team during inspection is rejected by the final D1 read',async()=>{
 const f=await inputFixture(env.DB),snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
 let changed=false;const id=crypto.randomUUID();
 const report=await pocDeployPreflight(settings(),async()=>{
  if(!changed){changed=true;await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:id,snapshotId,expectedRevision:f.revision});}
  return idle;
 });
 expect(report).toMatchObject({ready:false,activeJobs:1,inventoryStable:true});
 await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:0});
});
