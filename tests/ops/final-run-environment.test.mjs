import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm,unlink,cp} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {assertFrozenFinalRelease,loadCloudFinalEnvironment,FINAL_CLOUD_BASE} from '../../scripts/final-run-environment.mjs';
import {passedLocalReport} from './fixtures/final-local-report.mjs';
import {finalRecoveryFixture} from './fixtures/final-recovery-binding.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex'),commit='1'.repeat(40),digest='2'.repeat(64);
const casesBytes=await readFile('docs/mvp/cloudflare-final-cases.json'),cases=JSON.parse(casesBytes);
const identity={sourceCommit:commit,casesSha256:hash(casesBytes),configSha256:digest,sourceInputSha256:digest};
const accepted=()=>({schema:'cloudflare-final-release-v1',state:'FROZEN',...identity,independentReview:{state:'APPROVED',sourceCommit:commit,evidenceSha256:digest},ci:{sourceCommit:commit,functional:'success',security:'success'},localRehearsal:{state:'VERIFIED',sourceCommit:commit,evidenceSha256:digest},cohort:{state:'FROZEN',sourceCommit:commit,recoveryBindings:{state:'FROZEN'}},limits:structuredClone(cases.limits)});
async function fixture(work){
 const id=randomUUID(),root=path.resolve('.cache/final-cloudflare',id),artifact=path.resolve('artifacts/final-cloudflare',id);await mkdir(root,{recursive:true,mode:0o700});await mkdir(artifact,{recursive:true,mode:0o700});
 const write=(file,v)=>writeFile(file,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v),{mode:0o600});
 const info={id,root,artifact,mode:'cloudflare',base:FINAL_CLOUD_BASE};await write(root+'/runtime.json',info);
 try{return await work({id,root,artifact,info,write});}finally{await rm(root,{recursive:true});await rm(artifact,{recursive:true});}
}
test('cloud release rejects unreviewed, failed CI, changed source/config/input, missing recovery and altered cost limits',()=>{
 assert.doesNotThrow(()=>assertFrozenFinalRelease(accepted(),identity));
 for(const change of [r=>r.state='DRAFT',r=>r.independentReview.state='PENDING',r=>r.ci.functional='failure',r=>r.ci.security='failure',r=>r.cohort.recoveryBindings.state='PENDING',r=>r.localRehearsal.state='PENDING',r=>r.sourceCommit='3'.repeat(40),r=>r.configSha256='3'.repeat(64),r=>r.sourceInputSha256='3'.repeat(64),r=>r.casesSha256='3'.repeat(64),r=>r.limits.normalJobs=5,r=>r.limits.maximumSolverAttempts=13,r=>r.limits.independentChecks=17,r=>r.limits.functionalSessionMinutes=31,r=>r.limits.additional500PersonPerformanceRuns=1,r=>r.limits.mail=1,r=>r.limits.ai=1,r=>r.limits.scheduledBackup=1]){const r=accepted();change(r);assert.throws(()=>assertFrozenFinalRelease(r,identity));}
});
test('held CI requires the complete approved local alternative and retains the other quality gates',()=>{
 const report=passedLocalReport(),release={...accepted(),ci:{sourceCommit:commit,functional:'HELD_NOT_SUCCESS',security:'HELD_NOT_SUCCESS'},localChecks:{provider:'local',decision:'ADR0111',state:'PASSED',sourceCommit:commit,evidenceSha256:hash(JSON.stringify(report))}};
 assert.doesNotThrow(()=>assertFrozenFinalRelease(release,identity));
 for(const edit of [r=>delete r.localChecks,r=>r.localChecks.state='PENDING',r=>r.localChecks.decision='other',r=>r.localChecks.sourceCommit='3'.repeat(40),r=>r.ci.functional='success',r=>r.independentReview.state='PENDING',r=>r.cohort.recoveryBindings.state='PENDING',r=>r.localRehearsal.state='PENDING',r=>r.limits.maximumSolverAttempts=13]){const r=structuredClone(release);edit(r);assert.throws(()=>assertFrozenFinalRelease(r,identity));}
});
test('DRAFT cloud preparation refuses before token access or any HTTP',async()=>fixture(async({root,write})=>{
 await write(root+'/release.json',{...accepted(),state:'DRAFT'});let calls=0;const before=globalThis.fetch;globalThis.fetch=()=>{calls++;throw Error('UNEXPECTED_HTTP');};
 try{await assert.rejects(loadCloudFinalEnvironment('prepare',root),/FINAL_RELEASE_NOT_FROZEN/);assert.equal(calls,0);}finally{globalThis.fetch=before;}
}));
test('wrong cloud origin or unsupported repair mode cannot enter the workflow',async()=>fixture(async({root,info,write})=>{
 await write(root+'/runtime.json',{...info,base:'https://example.invalid'});await assert.rejects(loadCloudFinalEnvironment('prepare',root));await assert.rejects(loadCloudFinalEnvironment('resume-reallocation',root),/FINAL_CLOUD_USAGE/);
}));
test('status and cleanup retain the sealed execution after the current release changes; archive tampering is refused',async()=>finalRecoveryFixture(async f=>{
 await f.write(f.root+'/release.json',{...f.release,state:'DRAFT'});
 for(const action of ['status','cleanup']){const env=await loadCloudFinalEnvironment(action,f.root);assert.equal(env.sourceCommit,f.sourceCommit);assert.equal(env.release.ci.functional,'HELD_NOT_SUCCESS');}
 await f.write(f.root+'/execution-release.json',{...f.release,sourceInputSha256:'4'.repeat(64)});await assert.rejects(loadCloudFinalEnvironment('cleanup',f.root));
}));
test('archived held-CI logs and freeze completion are required before token access',async()=>finalRecoveryFixture(async f=>{
 await writeFile(f.root+'/execution-local-checks/worker.log','changed',{mode:0o600});
 await assert.rejects(loadCloudFinalEnvironment('status',f.root),/FINAL_LOCAL_CHECKS_LOG_CHANGED/);
 await cp(f.root+'/local-checks',f.root+'/execution-local-checks',{recursive:true,force:true});
 const receipt=JSON.parse(await readFile(f.root+'/freeze/state.json'));await f.write(f.root+'/freeze/state.json',{...receipt,state:'PREPARING_NOT_USABLE'});await unlink(f.root+'/.dev.vars');
 await assert.rejects(loadCloudFinalEnvironment('status',f.root),/FINAL_FREEZE_INCOMPLETE/);
}));
