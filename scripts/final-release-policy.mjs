// Shared immutable release requirements, no files, tokens or network.
import assert from 'node:assert/strict';
export function assertFinalQualityEvidence(release,sourceCommit){
 assert.match(sourceCommit,/^[a-f0-9]{40}$/);
 assert.equal(release.independentReview?.state,'APPROVED','FINAL_INDEPENDENT_REVIEW_PENDING');
 assert.equal(release.independentReview?.sourceCommit,sourceCommit);assert.match(release.independentReview?.evidenceSha256??'',/^[a-f0-9]{64}$/);
 assert.equal(release.ci?.sourceCommit,sourceCommit);
 if(release.localChecks){
  assert.equal(release.ci.functional,'HELD_NOT_SUCCESS');assert.equal(release.ci.security,'HELD_NOT_SUCCESS');
  assert.equal(release.localChecks.provider,'local');assert.equal(release.localChecks.decision,'ADR0111');assert.equal(release.localChecks.state,'PASSED','FINAL_LOCAL_CHECKS_NOT_PASSED');
  assert.equal(release.localChecks.sourceCommit,sourceCommit);assert.match(release.localChecks.evidenceSha256??'',/^[a-f0-9]{64}$/);
 }else{assert.equal(release.ci.functional,'success','FINAL_CI_NOT_SUCCESS');assert.equal(release.ci.security,'success','FINAL_CI_NOT_SUCCESS');}
}
export function assertFrozenFinalRelease(release,{sourceCommit,casesSha256,configSha256,sourceInputSha256}){
 assert.equal(release.schema,'cloudflare-final-release-v1');assert.equal(release.state,'FROZEN','FINAL_RELEASE_NOT_FROZEN');
 assert.match(sourceCommit,/^[a-f0-9]{40}$/);for(const v of [casesSha256,configSha256,sourceInputSha256])assert.match(v,/^[a-f0-9]{64}$/);
 assert.equal(release.sourceCommit,sourceCommit,'FINAL_SOURCE_COMMIT_CHANGED');
 for(const [key,value] of Object.entries({casesSha256,configSha256,sourceInputSha256}))assert.equal(release[key],value,'FINAL_RELEASE_CONTENT_CHANGED');
 assertFinalQualityEvidence(release,sourceCommit);
 assert.equal(release.cohort?.state,'FROZEN','FINAL_BINDINGS_NOT_FROZEN');assert.equal(release.cohort?.sourceCommit,sourceCommit);assert.equal(release.cohort?.recoveryBindings?.state,'FROZEN','FINAL_RECOVERY_BINDINGS_PENDING');
 assert.equal(release.localRehearsal?.state,'VERIFIED','FINAL_LOCAL_REHEARSAL_PENDING');assert.equal(release.localRehearsal?.sourceCommit,sourceCommit);
 assert.match(release.localRehearsal?.evidenceSha256??'',/^[a-f0-9]{64}$/);
 assert.equal(release.limits?.normalJobs,4);assert.equal(release.limits?.maximumSolverAttempts,12);assert.equal(release.limits?.independentChecks,16);assert.equal(release.limits?.intentionalContainerFaults,1);
 assert.equal(release.limits?.functionalSessionMinutes,30);assert.equal(release.limits?.cleanupMinutes,5);assert.equal(release.limits?.additional500PersonPerformanceRuns,0);assert.equal(release.limits?.mail,0);assert.equal(release.limits?.ai,0);assert.equal(release.limits?.scheduledBackup,0);
}
