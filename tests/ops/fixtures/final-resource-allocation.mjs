import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {finalCohortFixture} from './final-cohort-plan.mjs';
import {passedLocalReport} from './final-local-report.mjs';
import {prepareFinalCohort} from '../../../scripts/final-cohort-plan.mjs';
import {inspectFinalResourceAllocation} from '../../../scripts/final-resource-allocation.mjs';
import {imageLoadArgs} from '../../../scripts/final-snapshot-image.mjs';
import {finalImageTag,finalImageReference} from '../../../scripts/final-image-reference.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),ACCOUNT='11111111111111111111111111111111',PREFIX='/client/v4/accounts/'+ACCOUNT;
export async function resourceAllocationFixture(work){return finalCohortFixture(async f=>{
 const plan=await prepareFinalCohort(f.root,f.options),report=passedLocalReport();report.sourceSha256=f.source.sourceSha256;
 await mkdir(f.root+'/local-checks',{mode:0o700});for(const step of report.steps)await writeFile(f.root+'/local-checks/'+step.log,step.name,{mode:0o600});
 const archive='SYNTHETIC IMAGE ARCHIVE; NO ACTUAL IMAGE';await writeFile(f.root+'/local-checks/optimizer-image.tar',archive,{mode:0o600});report.imageArchive={file:'optimizer-image.tar',bytes:Buffer.byteLength(archive),sha256:sha(archive)};
 const raw=JSON.stringify(report);await writeFile(f.root+'/local-checks/report.json',raw,{mode:0o600});
 const imageDir=f.root+'/cohort/snapshot-image',log='SYNTHETIC fixture: no actual image load\nLoaded image ID: '+report.imageId;await mkdir(imageDir,{mode:0o700});await writeFile(imageDir+'/load.log',log,{mode:0o600});await f.write(imageDir+'/report.json',{schema:'final-snapshot-image-v1',state:'LOCAL_IMAGE_MATCH',cohortId:plan.cohortId,...f.source,planSha256:sha(await readFile(f.root+'/cohort/plan.json')),sourceSnapshotSha256:plan.sourceSnapshotSha256,imageArchive:report.imageArchive,imageId:report.imageId,registryRef:finalImageReference(f.root),localTag:finalImageTag(f.root),command:'docker',args:imageLoadArgs(f.root),log:'load.log',logSha256:sha(log),sourceUnchanged:true,cloudflareCalls:0,solverStarts:0,tokensRead:0});
 // Explicitly synthetic review and command receipts: never real approval.
 const review='SYNTHETIC TEST FIXTURE: no actual independent review or gate approval';await writeFile(f.root+'/independent-review.md',review,{mode:0o600});
 const release={...f.release,schema:'cloudflare-final-release-v1',independentReview:{state:'APPROVED',sourceCommit:f.source.sourceCommit,evidenceSha256:sha(review)},ci:{sourceCommit:f.source.sourceCommit,functional:'HELD_NOT_SUCCESS',security:'HELD_NOT_SUCCESS'},localChecks:{provider:'local',decision:'ADR0111',state:'PASSED',sourceCommit:f.source.sourceCommit,evidenceSha256:sha(raw)},cohort:{planSha256:sha(await readFile(f.root+'/cohort/plan.json'))}};
 await f.write(f.root+'/release.json',release);const options={inspectSource:f.options.inspectSource,getToken:async()=> 'fictional-ephemeral-token-for-test'};
 const db=randomUUID(),queue='7'.repeat(32),calls=[];
 const request=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.cloudflare.com');assert(u.pathname.startsWith(PREFIX+'/'));assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer fictional-ephemeral-token-for-test');
  const call={method:init.method,path:u.pathname,query:u.search,body:init.body?JSON.parse(init.body):null};calls.push(call);
  // The durable dispatch is visible before even a controlled response.
  const state=await inspectFinalResourceAllocation(f.root);assert.equal(state.requests.at(-1).stage,'DISPATCHED');assert.equal(state.requests.at(-1).path,u.pathname+u.search);
  const name=plan.resources.database.name,dbResult={uuid:db,name},q={queue_id:queue,queue_name:name+'-compute',consumers_total_count:0,producers_total_count:0,consumers:[],producers:[]};
  if(init.method==='GET'&&u.search)return Response.json({success:true,result:[],result_info:{page:1,per_page:20,count:0,total_count:0}});
  if(init.method==='GET'&&(u.pathname.includes('/workers/scripts/')||(u.pathname===PREFIX+'/r2/buckets/'+name&&!calls.some(c=>c.method==='POST'&&c.path===PREFIX+'/r2/buckets'))))return Response.json({success:false,errors:[{code:10006,message:'fictional not found'}]},{status:404});
  // Creation returns identity/settings; binding counts belong to the GET.
  const queueResult=init.method==='POST'?{queue_id:q.queue_id,queue_name:q.queue_name,settings:{delivery_delay:0,message_retention_period:345600}}:q;
  return Response.json({success:true,errors:[],result:u.pathname.includes('/d1/database')?dbResult:u.pathname.includes('/queues')?queueResult:{name}});
 };
 return work({...f,plan,release,options,request,calls,db,queue});
});}
