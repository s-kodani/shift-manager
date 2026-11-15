// Controlled late/duplicate envelopes use the real consumer; this does not
// claim to measure the Cloudflare Queue broker's delivery timing.
import assert from 'node:assert/strict';
import {boundedJson} from './operator-client.mjs';
export function verifyFinalDeliveryReceipt(v,{ownerId,operationId,jobIds}){
 assert.equal(v?.schema,'final-delivery-probe-v1');assert.equal(v.ownerId,ownerId);assert.equal(v.operationId,operationId);
 assert.equal(v.state,'COMPLETE');assert.equal(v.transport,'CONTROLLED_ENVELOPES_REAL_CONSUMER');assert.deepEqual(v.jobIds,jobIds);
 assert.equal(v.deliveries,jobIds.length*2);assert.equal(v.acknowledged,v.deliveries);assert.equal(v.retries,0);assert.equal(v.idle,true);
 assert.match(v.beforeSha256,/^[a-f0-9]{64}$/);assert.equal(v.beforeSha256,v.afterSha256);
 assert.equal(v.resultObjects?.length,jobIds.length);
 for(const [i,r]of v.resultObjects.entries()){assert.equal(r.jobId,jobIds[i]);assert.match(r.sha256,/^[a-f0-9]{64}$/);assert(Number.isSafeInteger(r.bytes)&&r.bytes>0&&r.bytes<=8_000_000);}
 return v;
}
export async function verifyFinalDelivery({ownerId,operationId,jobIds,request,record}){
 const body={ownerId,operationId,action:'run'};
 await record({ownerId,operationId,jobIds,stage:'RUN_DISPATCHED'});
 try{
  const response=await request('/__poc/final-delivery',body);if(response.status!==200){await response.body?.cancel();throw Error('UNCONFIRMED');}
  const receipt=verifyFinalDeliveryReceipt(await boundedJson(response,16384),{ownerId,operationId,jobIds});
  const observed=await request('/__poc/final-delivery',{ownerId,operationId,action:'status'});if(observed.status!==200){await observed.body?.cancel();throw Error('UNCONFIRMED');}
  const value=verifyFinalDeliveryReceipt(await boundedJson(observed,16384),{ownerId,operationId,jobIds});assert.deepEqual(value,receipt);
  const result={ownerId,operationId,jobIds,stage:'VERIFIED',runPosts:1,receipt:value};await record(result);return result;
 }catch{await record({ownerId,operationId,jobIds,stage:'UNCERTAIN',runPosts:1});throw Error('FINAL_DELIVERY_UNCONFIRMED_INSPECT_SAME_OPERATION');}
}
