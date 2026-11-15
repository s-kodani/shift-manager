import {deploymentTarget} from './deployment-target.mjs';
// Complete local evidence -> one immutable release. No tokens, HTTP or CLI.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {verifyFinalDeploymentReadiness,inspectFinalDeployment} from './final-deployment.mjs';
import {currentLocalCheckSource} from './final-local-check-proof.mjs';
import {assertFrozenFinalRelease} from './final-release-policy.mjs';
import {assertPocDeployReady} from './poc-deploy-guard.mjs';
import {freezeBytes,freezeSha as sha,FREEZE_FILES,verifyFinalFreezeProof} from './final-freeze-proof.mjs';
import {save} from './backup-lib.mjs';
const json=async f=>JSON.parse(await freezeBytes(f));
export async function freezeFinalRelease(arg,{inspectSource=currentLocalCheckSource,now=Date.now}={}){
 const ready=await verifyFinalDeploymentReadiness(arg,{inspectSource}),{root,plan,source,values}=ready;
 const draftBytes=await freezeBytes(root+'/release.json'),draft=JSON.parse(draftBytes),reportBytes=await freezeBytes(root+'/observation/report.json'),report=JSON.parse(reportBytes),owner=await json(root+'/observation/state.json'),deployment=await inspectFinalDeployment(root);
 assert.equal(owner.schema,'final-cohort-observation-owner-v1');assert.equal(owner.cohortId,plan.cohortId);assert.equal(owner.state,'COMPLETE_NOT_FROZEN');assert.equal(owner.reportSha256,sha(reportBytes));assert(owner.requests.length>0&&owner.requests.length<=40&&owner.requests.every(r=>r.stage==='CONFIRMED'));assert(owner.registryCommands.length>0&&owner.registryCommands.length<=8&&owner.registryCommands.every(r=>r.stage==='CONFIRMED'));
 assert.equal(report.schema,'final-cohort-observation-v1');assert.equal(report.state,'BINDINGS_IMAGES_SOURCE_ASSETS_VERIFIED_NOT_FROZEN');assert.equal(report.cohortId,plan.cohortId);assert.equal(report.sourceCommit,source.sourceCommit);assert.equal(report.sourceSha256,source.sourceSha256);assert.equal(report.releaseSha256,ready.releaseSha256);assert.equal(sha(draftBytes),ready.releaseSha256);assert.equal(report.materializationSha256,ready.materializationSha256);assert.equal(report.deploymentSha256,sha(await freezeBytes(root+'/deployment/state.json')));
 assert(Number.isSafeInteger(report.observedAt)&&report.observedAt<=now()&&now()-report.observedAt<=300_000,'FINAL_FREEZE_OBSERVATION_EXPIRED');assertPocDeployReady(report.preflight);assert.equal(report.solverStarts,0);
 assert.equal(deployment.state,'WORKER_VERSIONS_OBSERVED_IMAGE_PENDING_NOT_FROZEN');assert(deployment.phases.length>0&&deployment.phases.every(p=>p.stage==='CONFIRMED'));assert.equal(deployment.releaseSha256,ready.releaseSha256);
 assert.deepEqual(report.workers.map(w=>w.role),['source','sourceOperator','target','targetOperator']);assert.deepEqual(report.workers.map(w=>w.worker),plan.resources.workers.names);
 for(const w of report.workers){const d=deployment.workerVersions.find(v=>v.worker===w.worker);assert(d);assert.equal(w.versionId,d.versionId);assert.equal(w.tag,'final-'+plan.cohortId);assert.equal(w.databaseId,values[w.role].d1_databases[0].database_id);assert.match(w.namespaceId,/^[a-f0-9]{32}$/);}
 assert.equal(report.workers[0].namespaceId,report.workers[1].namespaceId);assert.equal(report.workers[2].namespaceId,report.workers[3].namespaceId);assert.notEqual(report.workers[0].namespaceId,report.workers[2].namespaceId);
 const checks=await json(root+'/local-checks/report.json');assert.deepEqual(report.images.map(i=>i.role),['source','target']);
 for(const i of report.images){assert.equal(i.imageId,checks.imageId);assert.equal(i.namespaceId,report.workers.find(w=>w.role===i.role).namespaceId);assert.equal(i.instanceType,'standard-2');assert.equal(i.maxInstances,1);assert.equal(i.os,'linux');assert.equal(i.architecture,'amd64');for(const k of ['registryDigest','platformManifestDigest'])assert.match(i[k],/^sha256:[a-f0-9]{64}$/);}
 assert.deepEqual(report.queues,['source','target'].map(role=>({name:values[role].queues.producers[0].queue,worker:values[role].name})));
 assert.deepEqual(report.sourceAssets,(await json(root+'/cohort/asset-manifest.json')).files);assert.equal(report.targetAssets,'DEFERRED_UNTIL_RESTORED_AUTHORIZED_READ');
 const binding={schema:'final-recovery-binding-v1',state:'FROZEN',cohortId:plan.cohortId,sourceCommit:source.sourceCommit,source:{databaseId:values.source.d1_databases[0].database_id,bucket:values.source.r2_buckets[0].bucket_name,appOrigin:values.source.vars.AUTH_BASE_URL,operatorOrigin:'https://'+values.sourceOperator.name+'.'+deploymentTarget.workersDomain},target:(await json(root+'/recovery/materialization.json')).target,files:{}};
 for(const f of ['profile.json','app.jsonc','operator.jsonc','source-operator.jsonc'])binding.files[f]=sha(await freezeBytes(root+'/recovery/'+f));
 const bindingBytes=JSON.stringify(binding,null,2)+'\n';
 const release={...draft,state:'FROZEN',sourceCommit:source.sourceCommit,cohort:{...draft.cohort,state:'FROZEN',sourceCommit:source.sourceCommit,sourceSha256:plan.sourceSha256,sourceSnapshotSha256:plan.sourceSnapshotSha256,assetsSha256:plan.assetsSha256,workers:report.workers,images:report.images,observation:{state:'VERIFIED',evidenceSha256:sha(reportBytes)},recoveryBindings:{state:'FROZEN',evidenceSha256:sha(bindingBytes)}}};
 assertFrozenFinalRelease(release,{sourceCommit:source.sourceCommit,casesSha256:plan.casesSha256,configSha256:plan.configSha256,sourceInputSha256:plan.sourceInputSha256});
 // Claim once after all read-only validation. An incomplete owner cannot retry.
 const dir=root+'/freeze';await mkdir(dir,{mode:0o700});const state={schema:'final-release-freeze-v1',state:'PREPARING_NOT_USABLE',cohortId:plan.cohortId,sourceCommit:source.sourceCommit,startedAt:now()};await save(dir+'/state.json',state);
 try{
  await writeFile(dir+'/draft-release.json',draftBytes,{mode:0o600,flag:'wx'});await writeFile(root+'/recovery/binding.json',bindingBytes,{mode:0o600,flag:'wx'});
  const files=[];for(const file of FREEZE_FILES)files.push({file,sha256:sha(await freezeBytes(root+'/'+file))});
  assert.deepEqual(await inspectSource(),source,'FINAL_FREEZE_SOURCE_CHANGED');assert.equal(sha(await readFile(root+'/release.json')),ready.releaseSha256);
  assert.equal(sha(await freezeBytes(root+'/observation/report.json')),sha(reportBytes));
  // Re-run original gates before changing DRAFT, and compare the complete seal.
  await verifyFinalDeploymentReadiness(root,{inspectSource});for(const f of files)assert.equal(f.sha256,sha(await freezeBytes(root+'/'+f.file)),'FINAL_FREEZE_EVIDENCE_CHANGED');
  assert(now()-report.observedAt<=300_000,'FINAL_FREEZE_OBSERVATION_EXPIRED');assertPocDeployReady(report.preflight);
  const raw=JSON.stringify(release,null,2)+'\n';await save(root+'/release.json',release);
  Object.assign(state,{state:'COMPLETE',releaseSha256:sha(raw),files,finishedAt:now(),cloudflareCalls:0,tokensRead:0,solverStarts:0});await save(dir+'/state.json',state);await verifyFinalFreezeProof(root,Buffer.from(raw));return release;
 }catch{state.state='FAILED_NOT_USABLE';await save(dir+'/state.json',state);throw Error('FINAL_FREEZE_STOPPED_INSPECT_SAME_OWNER');}
}
