// Fictional final-check credentials only. Stored before password dispatch.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {save} from './backup-lib.mjs';
import {privateRecoveryFile} from './recovery-security-client.mjs';
export async function prepareFinalRecoveryCredential(root,key,email){
 assert(['singleAdmin','singleStaff','largeAdmin','largeStaff'].includes(key));assert(typeof email==='string'&&email.endsWith('@example.invalid'));
 const file=root+'/recovery-credentials.json',saved=await privateRecoveryFile(file).catch(e=>{if(e.code==='ENOENT')return {};throw e;});assert(!Object.hasOwn(saved,key),'FINAL_RECOVERY_CREDENTIAL_ALREADY_PREPARED');
 const password=randomUUID()+randomUUID();saved[key]={email,password};await save(file,saved);return password;
}
