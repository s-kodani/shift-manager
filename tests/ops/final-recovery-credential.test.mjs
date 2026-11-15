import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,rm,readFile,lstat,chmod} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareFinalRecoveryCredential} from '../../scripts/final-recovery-credential.mjs';
test('fictional password is durable/private before dispatch and cannot be silently replaced on a second attempt',async()=>{
 const root=path.resolve('.cache/final-recovery-credential-tests',randomUUID());await mkdir(root,{recursive:true,mode:0o700});const file=root+'/recovery-credentials.json';
 try{await assert.rejects(prepareFinalRecoveryCredential(root,'singleAdmin','real@example.com'));await assert.rejects(readFile(file),e=>e.code==='ENOENT');const password=await prepareFinalRecoveryCredential(root,'singleAdmin','fictional-admin@example.invalid'),saved=JSON.parse(await readFile(file));assert.equal(saved.singleAdmin.password,password);assert.equal((await lstat(file)).mode&0o077,0);assert(password.length>=64);const before=await readFile(file,'utf8');await assert.rejects(prepareFinalRecoveryCredential(root,'singleAdmin','fictional-admin@example.invalid'),/ALREADY_PREPARED/);assert.equal(await readFile(file,'utf8'),before);await chmod(file,0o644);await assert.rejects(prepareFinalRecoveryCredential(root,'singleStaff','fictional-staff@example.invalid'),/PRIVATE_FILE_REQUIRED/);assert.equal(await readFile(file,'utf8'),before);}finally{await rm(root,{recursive:true});}
});
