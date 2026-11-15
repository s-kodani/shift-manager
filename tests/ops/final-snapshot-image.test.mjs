import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {finalCohortFixture} from './fixtures/final-cohort-plan.mjs';
import {passedLocalReport} from './fixtures/final-local-report.mjs';
import {prepareFinalCohort} from '../../scripts/final-cohort-plan.mjs';
import {prepareFinalSnapshotImage,verifyFinalSnapshotImage,imageLoadArgs} from '../../scripts/final-snapshot-image.mjs';
import {finalImageReference} from '../../scripts/final-image-reference.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(work){return finalCohortFixture(async f=>{
 const plan=await prepareFinalCohort(f.root,f.options),checks=passedLocalReport();checks.sourceSha256=f.source.sourceSha256;await mkdir(f.root+'/local-checks',{mode:0o700});for(const s of checks.steps)await writeFile(f.root+'/local-checks/'+s.log,s.name,{mode:0o600});const archive='SYNTHETIC image archive';await writeFile(f.root+'/local-checks/optimizer-image.tar',archive,{mode:0o600});checks.imageArchive={file:'optimizer-image.tar',bytes:Buffer.byteLength(archive),sha256:sha(archive)};await f.write(f.root+'/local-checks/report.json',checks);return work({...f,plan,checks});
});}
 test('the exact tested archive is loaded without rebuild, coupled to the planned registry reference and refuses changed log',async()=>fixture(async f=>{
 let loads=0;const options={inspect:f.options.inspectSource,load:async(root,id)=>{loads++;assert.equal(root,f.root);assert.equal(id,f.checks.imageId);return {imageId:id,log:'SYNTHETIC load output\nLoaded image ID: '+f.checks.imageId};}};const r=await prepareFinalSnapshotImage(f.root,options);assert.equal(r.state,'LOCAL_IMAGE_MATCH');assert.equal(r.imageId,f.checks.imageId);assert.deepEqual(r.args,imageLoadArgs(f.root));assert.deepEqual(r.imageArchive,f.checks.imageArchive);assert.equal(r.registryRef,finalImageReference(f.root));await verifyFinalSnapshotImage(f.root,f.plan,f.checks);await assert.rejects(prepareFinalSnapshotImage(f.root,options));assert.equal(loads,1);await writeFile(f.root+'/cohort/snapshot-image/load.log','changed');await assert.rejects(verifyFinalSnapshotImage(f.root,f.plan,f.checks));
}));
for(const fault of ['image','load','source','archive','load-output'])test('tested image '+fault+' failure cannot authorize allocation',async()=>fixture(async f=>{
 let inspections=0,loads=0;if(fault==='archive'){const b=await readFile(f.root+'/local-checks/optimizer-image.tar');b[0]^=1;await writeFile(f.root+'/local-checks/optimizer-image.tar',b);}const options={inspect:async()=>fault==='source'&&++inspections>1?{...f.source,sourceSha256:'f'.repeat(64)}:f.source,load:async()=>{loads++;if(fault==='load')throw Error('SYNTHETIC_LOAD_FAILURE');return {imageId:fault==='image'?'sha256:'+'f'.repeat(64):f.checks.imageId,log:'SYNTHETIC load output\nLoaded image ID: '+(fault==='load-output'?'sha256:'+'f'.repeat(64):f.checks.imageId)};}};if(fault==='archive'){await assert.rejects(prepareFinalSnapshotImage(f.root,options));assert.equal(loads,0);return;}const r=await prepareFinalSnapshotImage(f.root,options);assert.equal(r.state,'FAILED_NOT_USABLE');await assert.rejects(verifyFinalSnapshotImage(f.root,f.plan,f.checks));assert.equal(JSON.parse(await readFile(f.root+'/cohort/snapshot-image/report.json')).state,'FAILED_NOT_USABLE');
}));
