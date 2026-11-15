// One owned run plus receipt reads. Unknown replies never cause a second run.
import {boundedJson} from './operator-client.mjs';
export const FINAL_D1_CASES=['zero-row-success-and-later-write','guarded-stale-versions','atomic-cancel-and-idempotency','parallel-publish-cancel-one-winner','late-sql-failure-rollback'];
export function verifyD1Receipt(value,operationId){
 if(value?.schema!=='final-d1-probe-v1'||value.operationId!==operationId||value.state!=='COMPLETE'||value.remainingRows!==0||!Array.isArray(value.results)||value.results.length!==5||value.results.some(r=>r.passed!==true)||JSON.stringify(value.results.map(r=>r.case).sort())!==JSON.stringify([...FINAL_D1_CASES].sort()))throw Error('FINAL_D1_RECEIPT_NOT_VERIFIED');
 return value;
}
export async function inspectFinalD1(operationId,request){
 const r=await request('/__poc/final-d1',{operationId,action:'status'});if(r.status!==200){await r.body?.cancel();throw Error('FINAL_D1_STATUS_UNCONFIRMED');}
 const v=await boundedJson(r,16384);if(v?.schema!=='final-d1-probe-v1'||v.operationId!==operationId||!['RUNNING','COMPLETE','FAILED'].includes(v.state)||!Number.isSafeInteger(v.remainingRows)||v.remainingRows<0||!Array.isArray(v.results)||v.results.length>5||!Number.isSafeInteger(v.createdAt)||(v.state!=='RUNNING'&&!Number.isSafeInteger(v.finishedAt)))throw Error('FINAL_D1_STATUS_UNCONFIRMED');return v;
}
export async function verifyFinalD1({operationId,request,record}){
 await record({operationId,stage:'DENIAL_DISPATCHED'});
 const denied=await request('/__poc/final-d1',{operationId,action:'run'},{withoutToken:true});if(denied.status!==403){await denied.body?.cancel();throw Error('FINAL_D1_TOKEN_NOT_DENIED');}await denied.body?.cancel();
 await record({operationId,stage:'RUN_DISPATCHED',missingTokenStatus:403});
 try{
  const r=await request('/__poc/final-d1',{operationId,action:'run'});if(r.status!==200){await r.body?.cancel();throw Error('UNCONFIRMED');}
  const receipt=verifyD1Receipt(await boundedJson(r,16384),operationId),observed=verifyD1Receipt(await inspectFinalD1(operationId,request),operationId);
  if(JSON.stringify(receipt)!==JSON.stringify(observed))throw Error('FINAL_D1_RECEIPT_CHANGED');
  const result={operationId,stage:'VERIFIED',missingTokenStatus:403,runPosts:1,receiptInspected:true,receipt:observed};await record(result);return result;
 }catch{await record({operationId,stage:'UNCERTAIN',missingTokenStatus:403,runPosts:1});throw Error('FINAL_D1_UNCONFIRMED_INSPECT_SAME_OPERATION');}
}
