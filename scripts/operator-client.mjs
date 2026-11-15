import {mkdir,chmod,readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hashPassword,verifyPassword} from 'better-auth/crypto';
import {operatorDetails,operatorProvision,operatorReceipt,provisionFingerprint} from './operator-contract.mjs';
import {save} from './backup-lib.mjs';
const UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
async function privateFile(file){
 if(await realpath(file)!==file||(await stat(file)).size>8000||((await stat(file)).mode&0o077)!==0)throw new Error('PRIVATE_OPERATOR_FILE_REQUIRED');
 return JSON.parse(await readFile(file,'utf8'));
}
async function location(root,id){
 if(!UUID.test(id))throw new Error('INVALID_OPERATION_ID');const dir=path.resolve(root,id);
 if(await realpath(dir)!==dir||((await stat(dir)).mode&0o077)!==0)throw new Error('PRIVATE_OPERATOR_DIRECTORY_REQUIRED');
 return dir;
}
export async function prepareProvision(root,details){
 const input=operatorDetails.parse(details),id=randomUUID(),password=`Initial-${randomUUID()}-${randomUUID()}`;
 const p=operatorProvision.parse({...input,operationId:id,userId:randomUUID(),accountId:randomUUID(),passwordHash:await hashPassword(password)});
 await mkdir(root,{recursive:true,mode:0o700});if(await realpath(path.resolve(root))!==path.resolve(root))throw new Error('PRIVATE_OPERATOR_DIRECTORY_REQUIRED');await chmod(root,0o700);const dir=path.resolve(root,id);await mkdir(dir,{mode:0o700});
 // Persist the handoff before any remote dispatch. Password is never printed.
 await save(path.join(dir,'handoff.json'),{companyId:id,userId:p.userId,email:p.adminEmail,initialPassword:password});
 const owner={version:'operator-provision-v1',id,payload:p,fingerprint:await provisionFingerprint(p),stage:'PREPARED',createdAt:Date.now()};
 await save(path.join(dir,'operation.json'),owner);return {id,stage:owner.stage,handoffPath:path.join(dir,'handoff.json')};
}
export async function readProvision(root,id){
 const dir=await location(root,id),owner=await privateFile(path.join(dir,'operation.json'));
 if(owner.version!=='operator-provision-v1'||owner.id!==id||owner.payload.operationId!==id||owner.fingerprint!==await provisionFingerprint(owner.payload)||!['PREPARED','DISPATCHED','UNCERTAIN','REJECTED','COMMITTED'].includes(owner.stage))throw new Error('INVALID_OPERATOR_RECEIPT');
 owner.payload=operatorProvision.parse(owner.payload);return {dir,owner};
}
function checkReceipt(owner,value){
 const r=operatorReceipt.parse(value);
 if(r.operationId!==owner.id||r.companyId!==owner.id||r.userId!==owner.payload.userId||r.fingerprint!==owner.fingerprint)throw new Error('OPERATOR_RECEIPT_MISMATCH');return r;
}
async function recordCommit(dir,owner,value){
 owner.receipt=checkReceipt(owner,value);owner.stage='COMMITTED';owner.confirmedAt=Date.now();await save(path.join(dir,'operation.json'),owner);return {id:owner.id,stage:owner.stage,replayed:owner.receipt.replayed??true,handoffPath:path.join(dir,'handoff.json')};
}
export async function inspectProvisionOwner(root,id,request){
 const {dir,owner}=await readProvision(root,id),r=await request('/inspect',{operationId:id});
 if(r.status!==200)throw new Error('OPERATOR_INSPECTION_UNAVAILABLE');
 if(r.body?.found===false&&Object.keys(r.body).length===1){owner.lastInspection={at:Date.now(),found:false};await save(path.join(dir,'operation.json'),owner);return {id,stage:owner.stage,found:false};}
 return {...await recordCommit(dir,owner,r.body),found:true};
}
export async function sendProvision(root,id,request){
 const {dir,owner}=await readProvision(root,id);
 if(owner.stage!=='PREPARED'&&owner.stage!=='REJECTED')throw new Error('INSPECT_EXISTING_OPERATOR_OPERATION');
 const handoff=await privateFile(path.join(dir,'handoff.json'));
 if(handoff.companyId!==id||handoff.userId!==owner.payload.userId||handoff.email!==owner.payload.adminEmail||!await verifyPassword({hash:owner.payload.passwordHash,password:handoff.initialPassword}))throw new Error('OPERATOR_HANDOFF_MISMATCH');
 owner.stage='DISPATCHED';owner.dispatchedAt=Date.now();delete owner.responseStatus;await save(path.join(dir,'operation.json'),owner);
 try{
  const r=await request('/provision',owner.payload);owner.producerSettledAt=Date.now();owner.responseStatus=r.status;
  if(r.status===200)return await recordCommit(dir,owner,r.body);
  owner.stage=[400,403,409,413,415].includes(r.status)?'REJECTED':'UNCERTAIN';await save(path.join(dir,'operation.json'),owner);
  throw new Error(owner.stage==='REJECTED'?'OPERATOR_REQUEST_REJECTED':'OPERATOR_OUTCOME_UNKNOWN');
 }catch(error){
  if(owner.stage==='DISPATCHED'){owner.stage='UNCERTAIN';owner.producerSettledAt=Date.now();await save(path.join(dir,'operation.json'),owner);}
  // No provider message, credential, raw body or token in terminal errors.
  throw new Error(owner.stage==='REJECTED'?'OPERATOR_REQUEST_REJECTED':'OPERATOR_OUTCOME_UNKNOWN');
 }
}
export async function resumeProvision(root,id,request){
 const observed=await inspectProvisionOwner(root,id,request);if(observed.found)return observed;
 const {owner}=await readProvision(root,id);
 // An absent receipt does not prove an unknown server request has stopped.
 if(owner.stage!=='PREPARED'&&owner.stage!=='REJECTED')throw new Error('OPERATOR_OUTCOME_UNKNOWN');
 return sendProvision(root,id,request);
}
export async function boundedJson(response,max=4096){
 const reader=response.body?.getReader();if(!reader)throw new Error('INVALID_OPERATOR_RESPONSE');let size=0;const chunks=[];
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new Error('INVALID_OPERATOR_RESPONSE');}chunks.push(value);}
 const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('INVALID_OPERATOR_RESPONSE');}
}
export async function privateOperatorToken(file){const value=await privateFile(path.resolve(file));if(typeof value.OPERATOR_TOKEN!=='string'||value.OPERATOR_TOKEN.length<32||value.OPERATOR_TOKEN.length>256)throw new Error('OPERATOR_TOKEN_NOT_CONFIGURED');return value.OPERATOR_TOKEN;}
