import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedPreflight,guardedPocDeploy} from '../../scripts/poc-deploy-guard.mjs';

const idle=()=>({schema:'poc-deploy-preflight-v1',observedAt:new Date().toISOString(),ready:true,
 activeJobs:0,activeRevalidations:0,checkedObjects:2,busyObjects:0,inventoryStable:true});
test('an uncertain first read never builds or deploys; a failed second read never deploys',async()=>{
 for(const failure of [1,2]){
  let reads=0,builds=0,deployed=0;
  await assert.rejects(guardedPocDeploy({inspect:async()=>{if(++reads===failure)throw Error('private token');return idle();},
   build:async()=>{builds++;},record:async()=>{},deploy:async()=>{deployed++;}}),/^Error: PREFLIGHT_UNCONFIRMED$/);
  assert.equal(deployed,0);assert.equal(builds,failure-1);
 }
});
test('busy, partial, unstable, inconsistent and stale evidence cannot authorize a deployment',async()=>{
 for(const change of [{ready:false},{activeJobs:1},{activeRevalidations:1},{busyObjects:1},{inventoryStable:false},{checkedObjects:0},
  {observedAt:new Date(Date.now()-60_000).toISOString()},{observedAt:new Date(Date.now()+60_000).toISOString()}]){
  let deployed=false;
  await assert.rejects(guardedPocDeploy({inspect:async()=>({...idle(),...change}),build:async()=>{},record:async()=>{},deploy:async()=>{deployed=true;}}),/PREFLIGHT_/);
  assert.equal(deployed,false);
 }
});
test('the last read follows the build; failed build or evidence persistence does not deploy',async()=>{
 const order=[];
 await guardedPocDeploy({inspect:async()=>{order.push('read');return idle();},build:async()=>{order.push('build');},record:async phase=>{order.push(phase);},deploy:async()=>{order.push('deploy');}});
 assert.deepEqual(order,['read','before-build','build','read','before-deploy','deploy']);
 for(const phase of ['build','record']){
  let deployed=false;const settings={inspect:async()=>idle(),build:async()=>{},record:async()=>{},deploy:async()=>{deployed=true;}};
  settings[phase]=async()=>{throw Error('uncertain');};await assert.rejects(guardedPocDeploy(settings));assert.equal(deployed,false);
 }
});
test('bounded parser rejects HTTP errors, oversized/malformed and extra secret fields without disclosing response text',async()=>{
 for(const response of [new Response('private token',{status:503}),new Response('x'.repeat(16_385)),new Response(new Uint8Array([255])),Response.json({...idle(),token:'private'}),Response.json({ready:true})])
  await assert.rejects(boundedPreflight(response),/^Error: PREFLIGHT_/);
 const expected=idle();assert.deepEqual(await boundedPreflight(Response.json(expected)),expected);
});
