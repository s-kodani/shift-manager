import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,unlink,symlink} from 'node:fs/promises';
import {finalRecoveryFixture,sha} from './fixtures/final-recovery-binding.mjs';
import {passedLocalReport} from './fixtures/final-local-report.mjs';
import {validateFinalRecoveryProfile,readFinalRecoveryBinding} from '../../scripts/final-recovery-profile.mjs';
import {recoveryOperator,authenticatedRecoveryOperator,operatorRequest} from '../../scripts/recovery-runtime.mjs';
import {resolveFinalMaintenance} from '../../scripts/final-maintenance-runtime.mjs';

test('frozen four-job archive selects an isolated exact target; maintenance namespaces cannot cross source/target',async()=>finalRecoveryFixture(async f=>{
 const p=await validateFinalRecoveryProfile(f.manifest,f.dir+'/profile.json',f.profile);assert.deepEqual(p.flags,['--remote','--config',f.profile.configFile]);assert.equal(p.targetIdentity.mode,'remote');assert.equal(p.targetIdentity.cohortId,f.id);
 const target=await recoveryOperator(p),source=await recoveryOperator(p,{source:true});assert.equal(target.base,f.binding.target.operatorOrigin);assert.equal(source.base,f.binding.source.operatorOrigin);assert.notEqual(target.tokenFile,source.tokenFile);
 const a=await resolveFinalMaintenance(f.dir+'/profile.json','source',{authenticate:false}),b=await resolveFinalMaintenance(f.dir+'/profile.json','target',{authenticate:false});assert.notEqual(a.root,b.root);await assert.rejects(resolveFinalMaintenance(f.dir+'/profile.json','other'));
 assert.equal(await readFile(f.dir+'/profile.json','utf8'),JSON.stringify(f.profile));
}));
test('unfrozen/review-pending/incomplete/active result and altered binding are rejected before a missing token is accessed',async()=>finalRecoveryFixture(async f=>{
 const original=structuredClone(f.release);
 for(const edit of [r=>r.state='DRAFT',r=>r.independentReview.state='PENDING',r=>r.cohort.recoveryBindings.state='PENDING',r=>r.localRehearsal.state='PENDING',r=>r.limits.maximumSolverAttempts=13]){Object.assign(f.release,structuredClone(original));edit(f.release);await f.seal();await assert.rejects(authenticatedRecoveryOperator(f.profile),e=>e.code!=='ENOENT');}
 Object.assign(f.release,original);await f.seal();f.report.jobs.J2.stopped=false;await f.write(f.artifact+'/final-acceptance.json',f.report);await assert.rejects(authenticatedRecoveryOperator(f.profile),e=>e.code!=='ENOENT');f.report.jobs.J2.stopped=true;f.report.stage='J2_DISPATCHED';await f.write(f.artifact+'/final-acceptance.json',f.report);await assert.rejects(readFinalRecoveryBinding(f.root),/FINAL_RECOVERY_FOUR_JOBS_REQUIRED/);
 f.report.stage='FOUR_JOBS_VERIFIED';await f.write(f.artifact+'/final-acceptance.json',f.report);await f.write(f.dir+'/binding.json',{...f.binding,target:{...f.binding.target,operatorOrigin:'https://foreign.invalid'}});await assert.rejects(readFinalRecoveryBinding(f.root),/FINAL_RECOVERY_BINDING_CHANGED/);
}));
test('canonical isolation rules reject a rehashed source DB, foreign URL/account, extra binding, unlocked gate, other DO/Queue or increased resources',async()=>finalRecoveryFixture(async f=>{
 const originals=[structuredClone(f.profile),structuredClone(f.app),structuredClone(f.operator),structuredClone(f.binding)];
 for(const edit of [f=>f.profile.databaseId=f.binding.source.databaseId,f=>f.binding.target.operatorOrigin='https://foreign.invalid',f=>f.app.account_id='foreign',f=>f.app.d1_databases.push(f.app.d1_databases[0]),f=>f.app.vars.RECOVERY_SECURITY_ID='',f=>f.app.durable_objects.bindings[0].script_name='shift-manager-example',f=>f.app.queues.producers[0].queue='source-queue',f=>f.app.containers[0].max_instances=2,f=>f.app.containers[0].image='registry.cloudflare.com/foreign/image:tag',f=>f.app.containers[0].name='foreign-application',f=>f.app.services=[{binding:'foreign'}],f=>f.operator.durable_objects.bindings[0].script_name='shift-manager-example']){
  for(const [i,key]of ['profile','app','operator','binding'].entries()){for(const k of Object.keys(f[key]))delete f[key][k];Object.assign(f[key],structuredClone(originals[i]));}edit(f);await f.seal();await assert.rejects(readFinalRecoveryBinding(f.root));
 }
}));
test('legacy held-CI archive requires bound logs and its original Dockerfile settings; config and symlinks cannot redirect a profile',async()=>finalRecoveryFixture(async f=>{
 f.app.containers=[{class_name:'OptimizerContainer',image:f.root+'/cohort/source/services/optimizer/Dockerfile',image_build_context:f.root+'/cohort/source',instance_type:'standard-2',max_instances:1}];
 const local=passedLocalReport();local.sourceCommit=f.sourceCommit;local.sourceSha256=f.release.cohort.sourceSha256;const dir=f.root+'/execution-local-checks';await mkdir(dir,{mode:0o700,recursive:true});for(const s of local.steps)await writeFile(dir+'/'+s.log,s.name,{mode:0o600});await writeFile(dir+'/report.json',JSON.stringify(local),{mode:0o600});
 f.release.ci={sourceCommit:f.sourceCommit,functional:'HELD_NOT_SUCCESS',security:'HELD_NOT_SUCCESS'};f.release.localChecks={provider:'local',decision:'ADR0111',state:'PASSED',sourceCommit:f.sourceCommit,evidenceSha256:sha(JSON.stringify(local))};await f.seal();await readFinalRecoveryBinding(f.root);
 await writeFile(dir+'/worker.log','changed');await assert.rejects(readFinalRecoveryBinding(f.root),/FINAL_LOCAL_CHECKS_LOG_CHANGED/);await writeFile(dir+'/worker.log','worker');
 const checkedSource=local.sourceSha256;local.sourceSha256='2'.repeat(64);await writeFile(dir+'/report.json',JSON.stringify(local),{mode:0o600});f.release.localChecks.evidenceSha256=sha(JSON.stringify(local));await f.seal();await assert.rejects(authenticatedRecoveryOperator(f.profile),/FINAL_RECOVERY_CHECKED_SOURCE_CHANGED/);local.sourceSha256=checkedSource;await writeFile(dir+'/report.json',JSON.stringify(local),{mode:0o600});f.release.localChecks.evidenceSha256=sha(JSON.stringify(local));await f.seal();
 await f.write(f.dir+'/app.jsonc',{...f.app,name:'changed'});await assert.rejects(readFinalRecoveryBinding(f.root),/FINAL_RECOVERY_CONFIG_CHANGED/);await f.seal();await unlink(f.dir+'/profile.json');await symlink(f.dir+'/app.jsonc',f.dir+'/profile.json');await assert.rejects(readFinalRecoveryBinding(f.root),/FINAL_RECOVERY_SYMLINK/);
}));
test('operator transport fixes origin/method, rejects redirects and unknown paths before auth can be sent',async()=>{
 const calls=[],token='fictional-token',base='https://fixed.example.invalid';const request=operatorRequest({base,token},async(url,options)=>{calls.push({url,...options});return Response.json({found:false});});
 await request('/maintenance/status',{});assert.equal(calls[0].url,base+'/maintenance/status');assert.equal(calls[0].method,'POST');assert.equal(calls[0].redirect,'error');assert.equal(calls[0].headers.authorization,'Bearer '+token);
 for(const route of ['https://foreign.invalid','//foreign.invalid','/maintenance/status?redirect=foreign','/unknown'])await assert.rejects(request(route,{}),/RECOVERY_OPERATOR_ROUTE_REJECTED/);assert.equal(calls.length,1);
});
test('a frozen archive remains readable after a code change, but mutation refuses different or dirty source before token access',async()=>finalRecoveryFixture(async f=>{
 await recoveryOperator(f.profile);await assert.rejects(authenticatedRecoveryOperator(f.profile,{mutating:true}),/FINAL_RECOVERY_(DIRTY_SOURCE|SOURCE_CHANGED)/);
}));
test('recovery requires the bound copied source/assets, not mutable workspace paths or a missing snapshot',async()=>finalRecoveryFixture(async f=>{
 const file=f.root+'/cohort/source/apps/api/src/poc-worker.ts',original=await readFile(file);
 await writeFile(file,'changed',{mode:0o600});await assert.rejects(authenticatedRecoveryOperator(f.profile),/FINAL_COHORT_FILE_CHANGED/);await writeFile(file,original,{mode:0o600});
 const asset=f.root+'/cohort/assets/assets/app.js',assetBytes=await readFile(asset);await writeFile(asset,'changed',{mode:0o600});await assert.rejects(authenticatedRecoveryOperator(f.profile),/FINAL_COHORT_FILE_CHANGED/);await writeFile(asset,assetBytes,{mode:0o600});
 const main=f.app.main;f.app.main=process.cwd()+'/apps/api/src/poc-worker.ts';await f.seal();await assert.rejects(authenticatedRecoveryOperator(f.profile),e=>e.code!=='ENOENT');f.app.main=main;
 const directory=f.app.assets.directory;f.app.assets.directory=process.cwd()+'/dist/app';await f.seal();await assert.rejects(authenticatedRecoveryOperator(f.profile),/FINAL_RECOVERY_ASSET_PATH_CHANGED/);f.app.assets.directory=directory;
 delete f.release.cohort.sourceSnapshotSha256;await f.seal();await assert.rejects(authenticatedRecoveryOperator(f.profile),/FINAL_COHORT_RELEASE_SNAPSHOT_REQUIRED/);
}));
