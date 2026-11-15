import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,lstat,unlink} from 'node:fs/promises';
import {observationFixture} from './fixtures/final-cohort-observation.mjs';
import {frozenCohortFixture} from './fixtures/final-frozen-cohort.mjs';
import {observeFinalCohort} from '../../scripts/final-cohort-observation.mjs';
import {freezeFinalRelease} from '../../scripts/final-release-freeze.mjs';
import {verifyFinalFreezeProof,freezeSha as sha} from '../../scripts/final-freeze-proof.mjs';
const write=(f,v)=>writeFile(f,JSON.stringify(v,null,2)+'\n',{mode:0o600});
test('complete controlled provenance freezes exact resources and image; archive reads do not require current HEAD or tokens',async()=>frozenCohortFixture(async f=>{
 const bytes=await readFile(f.root+'/release.json'),release=JSON.parse(bytes),binding=JSON.parse(await readFile(f.root+'/recovery/binding.json'));
 assert.equal(release.state,'FROZEN');assert.equal(release.ci.functional,'HELD_NOT_SUCCESS');assert.equal(binding.target.databaseId,f.configs.target.d1_databases[0].database_id);assert.equal(release.cohort.images.length,2);
 await unlink(f.root+'/.dev.vars');assert.equal((await verifyFinalFreezeProof(f.root,bytes)).state,'COMPLETE');
 await assert.rejects(freezeFinalRelease(f.root,{inspectSource:f.options.inspectSource}));
}));
test('stale observation, mismatched image and pending review cannot claim a freeze owner',async()=>observationFixture(async f=>{
 await observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry});
 const file=f.root+'/observation/report.json',ownerFile=f.root+'/observation/state.json',original=JSON.parse(await readFile(file)),owner=JSON.parse(await readFile(ownerFile));
 for(const edit of [r=>r.observedAt-=300_001,r=>r.images[0].imageId='sha256:'+'9'.repeat(64),r=>r.workers[2].databaseId=r.workers[0].databaseId]){
  const r=structuredClone(original);edit(r);await write(file,r);await write(ownerFile,{...owner,reportSha256:sha(await readFile(file))});
  await assert.rejects(freezeFinalRelease(f.root,{inspectSource:f.options.inspectSource}));await assert.rejects(lstat(f.root+'/freeze'),{code:'ENOENT'});
 }
 await write(file,original);await write(ownerFile,{...owner,reportSha256:sha(await readFile(file))});const release=JSON.parse(await readFile(f.root+'/release.json'));release.independentReview.state='PENDING';await write(f.root+'/release.json',release);
 await assert.rejects(freezeFinalRelease(f.root,{inspectSource:f.options.inspectSource}),/FINAL_INDEPENDENT_REVIEW_PENDING/);await assert.rejects(lstat(f.root+'/freeze'),{code:'ENOENT'});
}));
test('a source change after ownership leaves a failed receipt and cannot be replayed',async()=>observationFixture(async f=>{
 await observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry});let n=0;
 await assert.rejects(freezeFinalRelease(f.root,{inspectSource:async()=>++n===1?f.source:{...f.source,sourceCommit:'9'.repeat(40)}}),/FINAL_FREEZE_STOPPED/);
 assert.equal(JSON.parse(await readFile(f.root+'/freeze/state.json')).state,'FAILED_NOT_USABLE');assert.equal(JSON.parse(await readFile(f.root+'/release.json')).state,'DRAFT');
 await assert.rejects(freezeFinalRelease(f.root,{inspectSource:f.options.inspectSource}));
}));
test('partial completion and substituted archived evidence are refused even after a new HEAD',async()=>frozenCohortFixture(async f=>{
 const bytes=await readFile(f.root+'/release.json'),stateFile=f.root+'/freeze/state.json',state=JSON.parse(await readFile(stateFile));
 await write(stateFile,{...state,state:'PREPARING_NOT_USABLE'});await assert.rejects(verifyFinalFreezeProof(f.root,bytes),/FINAL_FREEZE_INCOMPLETE/);await write(stateFile,state);
 for(const file of ['observation/report.json','deployment/state.json','recovery/binding.json','independent-review.md']){
  const p=f.root+'/'+file,b=await readFile(p);await writeFile(p,'changed',{mode:0o600});await assert.rejects(verifyFinalFreezeProof(f.root,bytes),/FINAL_FREEZE_EVIDENCE_CHANGED/);await writeFile(p,b,{mode:0o600});
 }
 const r=JSON.parse(bytes);r.cohort.images[0].imageId='sha256:'+'9'.repeat(64);const modified=Buffer.from(JSON.stringify(r));await assert.rejects(verifyFinalFreezeProof(f.root,modified),/FINAL_FROZEN_RELEASE_CHANGED/);
}));
