// Offline freeze receipt. Status/cleanup validate the archived release, not HEAD.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {verifyFinalCohortSnapshot} from './final-cohort-snapshot.mjs';
export const freezeSha=b=>createHash('sha256').update(b).digest('hex');
export const FREEZE_FILES=['freeze/draft-release.json','cohort/plan.json','independent-review.md','local-rehearsal.json','resources/allocation.json','resources/index.json','recovery/materialization.json','deployment/state.json','observation/state.json','observation/report.json','recovery/binding.json','recovery/profile.json','recovery/app.jsonc','recovery/operator.jsonc','recovery/source-operator.jsonc'];
export async function freezeBytes(file){
 assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&s.nlink===1&&(s.mode&0o077)===0&&s.size<2_000_000,'FINAL_FREEZE_PRIVATE_FILE_REQUIRED');return readFile(file);
}
export async function verifyFinalFreezeProof(root,releaseBytes){
 root=path.resolve(root);assert.equal(await realpath(root),root);
 const release=JSON.parse(releaseBytes),receipt=JSON.parse(await freezeBytes(root+'/freeze/state.json'));
 assert.equal(receipt.schema,'final-release-freeze-v1');assert.equal(receipt.state,'COMPLETE','FINAL_FREEZE_INCOMPLETE');assert.equal(receipt.cohortId,path.basename(root));assert.equal(receipt.sourceCommit,release.sourceCommit);assert.equal(receipt.releaseSha256,freezeSha(releaseBytes),'FINAL_FROZEN_RELEASE_CHANGED');
 assert.deepEqual(receipt.files.map(f=>f.file),FREEZE_FILES);
 for(const f of receipt.files)assert.equal(f.sha256,freezeSha(await freezeBytes(root+'/'+f.file)),'FINAL_FREEZE_EVIDENCE_CHANGED');
 const digest=file=>receipt.files.find(f=>f.file===file).sha256;
 assert.equal(release.independentReview.evidenceSha256,digest('independent-review.md'));assert.equal(release.localRehearsal.evidenceSha256,digest('local-rehearsal.json'));
 const rehearsal=JSON.parse(await freezeBytes(root+'/local-rehearsal.json'));
 for(const log of rehearsal.logs){assert(log.file.startsWith('artifacts/quality-audit/')&&!log.file.split('/').includes('..'));const file=path.resolve(log.file);assert.equal(await realpath(file),file);assert.equal(freezeSha(await readFile(file)),log.sha256,'FINAL_FREEZE_REHEARSAL_LOG_CHANGED');}
 assert.equal(release.cohort.planSha256,digest('cohort/plan.json'));assert.equal(release.cohort.recoveryBindings.evidenceSha256,digest('recovery/binding.json'));assert.equal(release.cohort.observation.evidenceSha256,digest('observation/report.json'));
 const report=JSON.parse(await freezeBytes(root+'/observation/report.json')),owner=JSON.parse(await freezeBytes(root+'/observation/state.json'));
 assert.equal(owner.state,'COMPLETE_NOT_FROZEN');assert.equal(owner.reportSha256,digest('observation/report.json'));
 assert.equal(report.state,'BINDINGS_IMAGES_SOURCE_ASSETS_VERIFIED_NOT_FROZEN');assert.equal(report.cohortId,receipt.cohortId);assert.equal(report.sourceCommit,release.sourceCommit);assert.equal(report.sourceSha256,release.cohort.sourceSha256);
 for(const [key,file]of Object.entries({releaseSha256:'freeze/draft-release.json',deploymentSha256:'deployment/state.json',materializationSha256:'recovery/materialization.json'}))assert.equal(report[key],digest(file));
 const plan=await verifyFinalCohortSnapshot(root,{candidateCommit:release.sourceCommit,sourceSha256:release.cohort.sourceSha256,sourceSnapshotSha256:release.cohort.sourceSnapshotSha256,assetsSha256:release.cohort.assetsSha256,casesSha256:release.casesSha256,configSha256:release.configSha256,sourceInputSha256:release.sourceInputSha256});
 assert.deepEqual(release.cohort.workers,report.workers);assert.deepEqual(release.cohort.images,report.images);assert.deepEqual(release.limits,plan.limits);
 return receipt;
}
