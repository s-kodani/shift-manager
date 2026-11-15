import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {allocateFinalResources,verifyFinalAllocationReadiness,inspectFinalResourceAllocation} from '../../scripts/final-resource-allocation.mjs';
import {materializeFinalResourceBindings} from '../../scripts/final-resource-bindings.mjs';
import {resourceAllocationFixture as fixture} from './fixtures/final-resource-allocation.mjs';
test('one allocation records dispatch before three POSTs, then real-response shapes feed the offline materializer without freezing',async()=>fixture(async f=>{
 const r=await allocateFinalResources(f.root,{...f.options,request:f.request});assert.equal(r.state,'ALLOCATED_OBSERVED_NOT_DEPLOYED_NOT_FROZEN');assert.equal(f.calls.length,11);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
 const materialized=await materializeFinalResourceBindings(f.root,{inspectSource:f.options.inspectSource});assert.equal(materialized.databaseId,f.db);assert.equal(materialized.queueId,f.queue);assert.equal(materialized.state,'MATERIALIZED_NOT_DEPLOYED_NOT_FROZEN');assert.equal(JSON.parse(await readFile(f.root+'/release.json')).state,'DRAFT');
 assert(!(await readFile(f.root+'/resources/allocation.json','utf8')).includes('fictional-ephemeral-token-for-test'));
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request:f.request}));assert.equal(f.calls.length,11);
}));
for(const fault of ['missing-count','bound-consumer','bound-producer'])test('Queue GET still rejects '+fault+' after the identity-only create receipt',async()=>fixture(async f=>{
 const request=async(url,init)=>{
  const response=await f.request(url,init);
  if(init.method==='GET'&&url.endsWith('/queues/'+f.queue)){
   const v=await response.json();
   if(fault==='missing-count')delete v.result.consumers_total_count;
   if(fault==='bound-consumer')v.result.consumers_total_count=1;
   if(fault==='bound-producer')v.result.producers_total_count=1;
   return Response.json(v);
  }return response;
 };
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));
 const state=await inspectFinalResourceAllocation(f.root);assert.equal(state.state,'UNCERTAIN_NOT_USABLE');assert.equal(state.created.queue.id,f.queue);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);await assert.rejects(access(f.root+'/resources/index.json'),e=>e.code==='ENOENT');
 const count=f.calls.length;await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(f.calls.length,count);
}));
test('unverified packaged image is refused before token or HTTP',async()=>fixture(async f=>{
 const p=f.root+'/cohort/snapshot-image/report.json',r=JSON.parse(await readFile(p));r.imageId='sha256:'+'e'.repeat(64);await f.write(p,r);let tokens=0,requests=0;await assert.rejects(allocateFinalResources(f.root,{...f.options,getToken:async()=>{tokens++;throw Error('UNEXPECTED_TOKEN');},request:async()=>{requests++;throw Error('UNEXPECTED_HTTP');}}));assert.equal(tokens+requests,0);await assert.rejects(access(f.root+'/resources'),e=>e.code==='ENOENT');
}));
test('pending review, changed review/log/plan, held-as-success CI and wrong source refuse before token or HTTP',async()=>fixture(async f=>{
 const original=structuredClone(f.release);let tokens=0,requests=0;
 const options={...f.options,getToken:async()=>{tokens++;throw Error('UNEXPECTED_TOKEN');},request:async()=>{requests++;throw Error('UNEXPECTED_HTTP');}};
 for(const edit of [r=>r.independentReview.state='PENDING',r=>r.independentReview.evidenceSha256='3'.repeat(64),r=>r.ci.security='success',r=>r.cohort.planSha256='4'.repeat(64)]){const r=structuredClone(original);edit(r);await f.write(f.root+'/release.json',r);await assert.rejects(allocateFinalResources(f.root,options));}
 await f.write(f.root+'/release.json',original);await writeFile(f.root+'/local-checks/worker.log','changed');await assert.rejects(allocateFinalResources(f.root,options));
 await writeFile(f.root+'/local-checks/worker.log','worker');await assert.rejects(allocateFinalResources(f.root,{...options,inspectSource:async()=>({...f.source,sourceCommit:'5'.repeat(40)})}));
 assert.equal(tokens,0);assert.equal(requests,0);await assert.rejects(access(f.root+'/resources'),e=>e.code==='ENOENT');
}));
test('lost first create reply leaves an inspectable uncertain owner and never retries or creates subsequent resources',async()=>fixture(async f=>{
 let posts=0;const request=async(url,init)=>{if(init.method==='POST'){posts++;throw Error('LOST_CREATE_RESPONSE');}return f.request(url,init);};
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}),/INSPECT_SAME_OWNER/);const state=await inspectFinalResourceAllocation(f.root);assert.equal(state.state,'UNCERTAIN_NOT_USABLE');assert.equal(state.requests.at(-1).stage,'DISPATCHED');assert.equal(posts,1);
 const before=await readFile(f.root+'/resources/allocation.json','utf8');await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(await readFile(f.root+'/resources/allocation.json','utf8'),before);assert.equal(posts,1);await assert.rejects(access(f.root+'/resources/index.json'),e=>e.code==='ENOENT');
}));
test('an existing bucket is rejected before creation instead of adopted',async()=>fixture(async f=>{
 const request=async(url,init)=>init.method==='GET'&&url.includes('/r2/buckets/')?Response.json({success:true,result:{name:f.plan.resources.bucket.name}}):f.request(url,init);
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(f.calls.filter(c=>c.method==='POST').length,0);assert.equal((await inspectFinalResourceAllocation(f.root)).state,'UNCERTAIN_NOT_USABLE');
}));
test('a foreign created identity or response-observation mismatch stops before later creation',async()=>fixture(async f=>{
 let posts=0;const request=async(url,init)=>{if(init.method==='POST')posts++;if(init.method==='GET'&&url.endsWith('/d1/database/'+f.db))return Response.json({success:true,result:{uuid:f.db,name:'foreign-database'}});return f.request(url,init);};
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(posts,1);assert.equal((await inspectFinalResourceAllocation(f.root)).created.database.id,f.db);
}));
test('changed proof during API work stops before creating resources',async()=>fixture(async f=>{
 let calls=0;const request=async(url,init)=>{const result=await f.request(url,init);if(++calls===1)await writeFile(f.root+'/independent-review.md','changed during allocation');return result;};
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(calls,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
}));
test('complete paginated inventory is checked before a single creation; duplicates in inventory cannot prove absence',async()=>fixture(async f=>{
 const rows=Array.from({length:101},(_,i)=>({uuid:randomUUID(),name:'fictional-existing-'+i}));
 const request=async(url,init)=>{
  const response=await f.request(url,init),u=new URL(url);
  if(u.pathname.endsWith('/d1/database')&&init.method==='GET'){
   const page=Number(u.searchParams.get('page')),result=rows.slice((page-1)*100,page*100);
   return Response.json({success:true,result,result_info:{page,per_page:100,count:result.length,total_count:101}});
  }return response;
 };
 const result=await allocateFinalResources(f.root,{...f.options,request});assert.equal(result.state,'ALLOCATED_OBSERVED_NOT_DEPLOYED_NOT_FROZEN');assert.equal(f.calls.length,12);assert.equal(f.calls.filter(c=>c.method==='POST').length,3);
}));
test('incomplete or duplicated inventory cannot authorize allocation',async()=>fixture(async f=>{
 const id=randomUUID();const request=async(url,init)=>{await f.request(url,init);return Response.json({success:true,result:[{uuid:id,name:'other'},{uuid:id,name:'other'}],result_info:{page:1,per_page:100,count:2,total_count:2}});};
 await assert.rejects(allocateFinalResources(f.root,{...f.options,request}));assert.equal(f.calls.length,1);assert.equal(f.calls.filter(c=>c.method==='POST').length,0);
}));
