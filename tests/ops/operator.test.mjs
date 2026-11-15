import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm,chmod,symlink,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
import {prepareProvision,sendProvision,inspectProvisionOwner,resumeProvision,readProvision,boundedJson} from '../../scripts/operator-client.mjs';
const details={companyName:'架空運営者企業',adminName:'架空初期管理者',adminEmail:'fictional-operator@example.invalid'};
async function area(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'shift-operator-test-')));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function receipt(owner){return {found:true,operationId:owner.id,companyId:owner.id,userId:owner.payload.userId,initialRevision:0,createdAt:Date.now(),fingerprint:owner.fingerprint,replayed:false};}
test('handoff is private and durable before dispatch; lost response reconciles same ID without another issuance',async t=>{
 const root=await area(t),prepared=await prepareProvision(root,details),{owner}=await readProvision(root,prepared.id),handoff=await readFile(prepared.handoffPath,'utf8');
 assert.equal((await stat(prepared.handoffPath)).mode&0o077,0);assert.equal((await stat(path.dirname(prepared.handoffPath))).mode&0o077,0);assert(!JSON.stringify(prepared).includes(JSON.parse(handoff).initialPassword));
 let posted=0,committed;
 const request=async(route,p)=>{if(route==='/provision'){posted++;assert.equal((await readProvision(root,prepared.id)).owner.stage,'DISPATCHED');assert.deepEqual(p,owner.payload);committed=receipt(owner);throw Error('private token and email must not escape');}return {status:200,body:committed};};
 await assert.rejects(sendProvision(root,prepared.id,request),/^Error: OPERATOR_OUTCOME_UNKNOWN$/);assert.equal((await readProvision(root,prepared.id)).owner.stage,'UNCERTAIN');
 const reconciled=await resumeProvision(root,prepared.id,request);assert.equal(reconciled.id,prepared.id);assert.equal(reconciled.stage,'COMMITTED');assert.equal(posted,1);assert.equal(await readFile(prepared.handoffPath,'utf8'),handoff);
 await assert.rejects(sendProvision(root,prepared.id,request),/INSPECT_EXISTING_OPERATOR_OPERATION/);
});
test('absent receipt after unknown delivery never starts another request or new ID; known rejection may retry frozen input',async t=>{
 const root=await area(t),p=await prepareProvision(root,details);let posted=0;
 const lost=async route=>{if(route==='/provision'){posted++;throw Error('unknown');}return {status:200,body:{found:false}};};
 await assert.rejects(sendProvision(root,p.id,lost),/OPERATOR_OUTCOME_UNKNOWN/);await assert.rejects(resumeProvision(root,p.id,lost),/OPERATOR_OUTCOME_UNKNOWN/);assert.equal(posted,1);
 const q=await prepareProvision(root,details),original=(await readProvision(root,q.id)).owner.payload;await assert.rejects(sendProvision(root,q.id,async()=>({status:403,body:{error:'FORBIDDEN'}})),/OPERATOR_REQUEST_REJECTED/);
 const done=await resumeProvision(root,q.id,async(route,body)=>route==='/inspect'?{status:200,body:{found:false}}:(assert.deepEqual(body,original),{status:200,body:receipt((await readProvision(root,q.id)).owner)}));assert.equal(done.stage,'COMMITTED');
});
test('mismatched receipt, weak file modes and symlink directories stop without accepting new identity',async t=>{
 const root=await area(t),p=await prepareProvision(root,details);await assert.rejects(inspectProvisionOwner(root,p.id,async()=>({status:200,body:{...receipt((await readProvision(root,p.id)).owner),companyId:'00000000-0000-4000-8000-000000000000'}})),/OPERATOR_RECEIPT_MISMATCH/);
 await chmod(p.handoffPath,0o644);await assert.rejects(sendProvision(root,p.id,async()=>{throw Error('must not send');}),/PRIVATE_OPERATOR_FILE_REQUIRED/);
 const link=path.join(root,'linked');await symlink(root,link);await assert.rejects(prepareProvision(link,details),/PRIVATE_OPERATOR_DIRECTORY_REQUIRED/);
});
test('response parser bounds actual chunks and rejects invalid UTF-8/JSON without provider text',async()=>{
 await assert.rejects(boundedJson(new Response('private'.repeat(1000))),/INVALID_OPERATOR_RESPONSE/);await assert.rejects(boundedJson(new Response(new Uint8Array([255]))),/INVALID_OPERATOR_RESPONSE/);assert.deepEqual(await boundedJson(Response.json({found:false})),{found:false});
});
