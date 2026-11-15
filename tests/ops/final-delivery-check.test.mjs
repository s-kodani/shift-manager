import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {verifyFinalDelivery,verifyFinalDeliveryReceipt} from '../../scripts/final-delivery-check.mjs';
const fixture=()=>{const expected={ownerId:randomUUID(),operationId:randomUUID(),jobIds:[randomUUID()]};return {expected,receipt:{schema:'final-delivery-probe-v1',...expected,state:'COMPLETE',transport:'CONTROLLED_ENVELOPES_REAL_CONSUMER',deliveries:2,acknowledged:2,retries:0,idle:true,beforeSha256:'1'.repeat(64),afterSha256:'1'.repeat(64),resultObjects:[{jobId:expected.jobIds[0],sha256:'2'.repeat(64),bytes:100}]}};};
test('receipt rejects changed result, owner, job set, delivery counts, retry and non-idle states',()=>{
 const {expected,receipt}=fixture();assert.equal(verifyFinalDeliveryReceipt(receipt,expected),receipt);
 for(const change of [{ownerId:randomUUID()},{jobIds:[randomUUID()]},{acknowledged:1},{retries:1},{idle:false},{afterSha256:'3'.repeat(64)},{resultObjects:[]},{state:'RUNNING'}])assert.throws(()=>verifyFinalDeliveryReceipt({...receipt,...change},expected));
});
test('a lost run response records uncertainty and does not send a replacement',async()=>{
 const {expected}=fixture(),records=[],calls=[];
 await assert.rejects(verifyFinalDelivery({...expected,record:async v=>records.push(v),request:async(_route,body)=>{calls.push(body);throw Error('LOST_RESPONSE');}}),/INSPECT_SAME_OPERATION/);
 assert.equal(calls.length,1);assert.deepEqual(records.map(r=>r.stage),['RUN_DISPATCHED','UNCERTAIN']);
});
test('a changed receipt read stops the workflow without replay',async()=>{
 const {expected,receipt}=fixture(),records=[],calls=[];
 await assert.rejects(verifyFinalDelivery({...expected,record:async v=>records.push(v),request:async(_route,body)=>{calls.push(body.action);return Response.json({...receipt,...body.action==='status'?{beforeSha256:'4'.repeat(64),afterSha256:'4'.repeat(64)}:{}});}}),/INSPECT_SAME_OPERATION/);
 assert.deepEqual(calls,['run','status']);assert.equal(records.at(-1).stage,'UNCERTAIN');
});
