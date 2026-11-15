// Preserve and promote the exact locally tested image, without a deployment rebuild.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,mkdir,lstat,realpath,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {verifyPlannedCohort} from './final-cohort-plan.mjs';
import {currentLocalCheckSource,verifyLocalCheckFiles} from './final-local-check-proof.mjs';
import {finalImageTag,finalImageReference} from './final-image-reference.mjs';
import {save} from './backup-lib.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),run=promisify(execFile);
async function bytes(file){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<16_000_000);return readFile(file);}
export const imageLoadArgs=root=>['image','load','--input',path.resolve(root,'local-checks/optimizer-image.tar')];
export function assertImageLoadOutput(log,imageId){const loaded=[...log.matchAll(/^Loaded image(?: ID)?: (.+)\r?$/gm)].map(m=>m[1].trim());assert.deepEqual(loaded,[imageId],'FINAL_LOADED_IMAGE_CHANGED');}
async function loadImage(root,imageId){const result=await run('docker',imageLoadArgs(root),{timeout:120000,maxBuffer:1_000_000});const inspected=await run('docker',['image','inspect',imageId,'--format','{{.Id}}'],{timeout:30000,maxBuffer:100000});return {imageId:inspected.stdout.trim(),log:result.stdout+result.stderr};}
export async function verifyFinalSnapshotImage(root,plan,checks){
 root=path.resolve(root);const dir=root+'/cohort/snapshot-image',r=JSON.parse(await bytes(dir+'/report.json'));assert(checks.imageArchive,'FINAL_TESTED_IMAGE_ARCHIVE_REQUIRED');
 assert.equal(r.schema,'final-snapshot-image-v1');assert.equal(r.state,'LOCAL_IMAGE_MATCH','FINAL_SNAPSHOT_IMAGE_NOT_VERIFIED');assert.equal(r.cohortId,plan.cohortId);assert.equal(r.sourceCommit,plan.candidateCommit);assert.equal(r.sourceSha256,plan.sourceSha256);assert.equal(r.planSha256,sha(await bytes(root+'/cohort/plan.json')));assert.equal(r.sourceSnapshotSha256,plan.sourceSnapshotSha256);assert.deepEqual(r.imageArchive,checks.imageArchive);
 assert.equal(r.imageId,checks.imageId,'FINAL_SNAPSHOT_IMAGE_CHANGED');assert.match(r.imageId,/^sha256:[a-f0-9]{64}$/);assert.equal(r.registryRef,finalImageReference(root));assert.equal(r.localTag,finalImageTag(root));assert.equal(r.command,'docker');assert.deepEqual(r.args,imageLoadArgs(root));assert.equal(r.log,'load.log');const log=await bytes(dir+'/load.log');assert.equal(r.logSha256,sha(log));assertImageLoadOutput(log.toString('utf8'),r.imageId);assert.equal(r.sourceUnchanged,true);assert.equal(r.cloudflareCalls+r.solverStarts+r.tokensRead,0);return r;
}
export async function prepareFinalSnapshotImage(arg,{inspect=currentLocalCheckSource,load=loadImage}={}){
 const root=path.resolve(arg),plan=await verifyPlannedCohort(root),source=await inspect();assert.equal(source.sourceCommit,plan.candidateCommit);assert.equal(source.sourceSha256,plan.sourceSha256);const checks=(await verifyLocalCheckFiles(root+'/local-checks',source.sourceCommit)).value;assert.equal(checks.sourceSha256,source.sourceSha256);assert(checks.imageArchive,'FINAL_TESTED_IMAGE_ARCHIVE_REQUIRED');
 const dir=root+'/cohort/snapshot-image';await mkdir(dir,{mode:0o700});const r={schema:'final-snapshot-image-v1',state:'LOADING',cohortId:plan.cohortId,...source,planSha256:sha(await bytes(root+'/cohort/plan.json')),sourceSnapshotSha256:plan.sourceSnapshotSha256,imageArchive:checks.imageArchive,imageId:null,registryRef:finalImageReference(root),localTag:finalImageTag(root),command:'docker',args:imageLoadArgs(root),log:'load.log',startedAt:Date.now(),sourceUnchanged:false,cloudflareCalls:0,solverStarts:0,tokensRead:0};await save(dir+'/report.json',r);let log='';
 try{const result=await load(root,checks.imageId);log=result.log;r.imageId=result.imageId;assert.equal(r.imageId,checks.imageId);assertImageLoadOutput(log,r.imageId);assert.deepEqual(await inspect(),source);await verifyPlannedCohort(root);r.sourceUnchanged=true;r.state='LOCAL_IMAGE_MATCH';}catch{r.state='FAILED_NOT_USABLE';}
 await writeFile(dir+'/load.log',log,{mode:0o600,flag:'wx'});r.logSha256=sha(log);r.finishedAt=Date.now();await save(dir+'/report.json',r);if(r.state==='LOCAL_IMAGE_MATCH')await verifyFinalSnapshotImage(root,plan,checks);return r;
}
