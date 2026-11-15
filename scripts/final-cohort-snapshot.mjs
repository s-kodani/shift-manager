// Immutable offline package shared by planning and archived recovery. No tokens/network.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function privateBytes(file,limit=16_000_000){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<limit);return readFile(file);}
async function readSourceBytes(root,record){
 const base=root+'/cohort/source',file=base+'/'+record.file;
 // Legacy sealed packages keep their original private-mode verification.
 if(record.mode===undefined)return privateBytes(file,128_000_000);
 assert([0o644,0o755].includes(record.mode));assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&s.size<128_000_000);assert.equal(s.mode&0o777,record.mode,'FINAL_COHORT_SOURCE_MODE_CHANGED');
 for(let dir=path.dirname(file);;dir=path.dirname(dir)){assert(dir===base||dir.startsWith(base+'/'));const st=await lstat(dir);assert(st.isDirectory()&&!st.isSymbolicLink());assert.equal(st.mode&0o777,0o755,'FINAL_COHORT_SOURCE_MODE_CHANGED');if(dir===base)break;}
 return readFile(file);
}
export async function verifyFinalCohortSnapshot(root,expected){
 root=path.resolve(root);assert.equal(await realpath(root),root);assert.equal((await lstat(root)).mode&0o077,0);
 const plan=JSON.parse(await privateBytes(root+'/cohort/plan.json'));assert.equal(root,path.resolve('.cache/final-cloudflare',plan.cohortId));assert.equal(plan.schema,'final-cohort-plan-v1');assert.equal(plan.state,'PLANNED');
 for(const [key,value]of Object.entries(expected)){assert.equal(typeof value,'string','FINAL_COHORT_RELEASE_SNAPSHOT_REQUIRED');assert.match(value,/^[a-f0-9]{40}$|^[a-f0-9]{64}$/);assert.equal(plan[key],value,'FINAL_COHORT_RELEASE_SNAPSHOT_CHANGED');}
 const sourceBytes=await privateBytes(root+'/cohort/source-manifest.json'),assetBytes=await privateBytes(root+'/cohort/asset-manifest.json');assert.equal(sha(sourceBytes),plan.sourceSnapshotSha256,'FINAL_COHORT_SNAPSHOT_CHANGED');assert.equal(sha(assetBytes),plan.assetsSha256,'FINAL_COHORT_ASSETS_CHANGED');
 const source=JSON.parse(sourceBytes),assets=JSON.parse(assetBytes);assert.equal(source.sourceCommit,plan.candidateCommit);assert.equal(source.sourceSha256,plan.sourceSha256);assert.equal(assets.sourceCommit,plan.candidateCommit);
 assert.equal(sha(JSON.stringify(source.files.map(r=>[r.file,r.sha256]))),plan.sourceSha256,'FINAL_COHORT_SOURCE_RECORDS_CHANGED');
 for(const [folder,manifest]of [['source',source],['assets',assets]])for(const r of manifest.files){assert(!path.isAbsolute(r.file)&&!r.file.split('/').includes('..'));const bytes=folder==='source'?await readSourceBytes(root,r):await privateBytes(root+'/cohort/'+folder+'/'+r.file,128_000_000);assert.equal(bytes.length,r.bytes,'FINAL_COHORT_FILE_CHANGED');assert.equal(sha(bytes),r.sha256,'FINAL_COHORT_FILE_CHANGED');}
 for(const r of plan.configs){assert(!path.isAbsolute(r.file)&&!r.file.split('/').includes('..'));assert.equal(sha(await privateBytes(root+'/'+r.file)),r.sha256,'FINAL_COHORT_CONFIG_CHANGED');}
 return plan;
}
