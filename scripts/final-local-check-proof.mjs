// Read-only proof shared by final execution and restore validation.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {spawnSync} from 'node:child_process';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function hashLocalImageArchive(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
export function localCheckPlan(image){
 assert.match(image,/^shift-planner-final-gates-[a-f0-9]{12}$/);
 return [
 ['worker','npm',['run','check']],['optimizer','npm',['run','test:optimizer']],
 ['web','npm',['run','build:web']],['web-tests','npm',['run','test:web']],
 ['poc-build','npm',['run','build:poc']],['backup-build','npm',['run','build:backup']],
 ['security-rules','uv',['run','--project','tools/security','--frozen','semgrep','--test','security/rules']],
 ['image-build','docker',['build','--platform','linux/amd64','-f','services/optimizer/Dockerfile','-t',image,'.']],
 ['native-boundaries','npm',['run','test:cancellation-native']],
 ['container-http','node',['scripts/probe-container.mjs']],['security','npm',['run','security:check']],
 ].map(([name,command,args])=>({name,command,args}));
}
export function assertLocalCheckReport(v,sourceCommit){
 assert.equal(v.schema,'final-local-checks-v1');assert.equal(v.state,'PASSED','FINAL_LOCAL_CHECKS_NOT_PASSED');
 assert.match(sourceCommit,/^[a-f0-9]{40}$/);assert.equal(v.sourceCommit,sourceCommit,'FINAL_LOCAL_CHECKS_SOURCE_CHANGED');
 assert.equal(v.decision,'ADR0111');assert.equal(v.provider,'local');assert.equal(v.ci,'HELD_NOT_SUCCESS');
 assert.match(v.sourceSha256,/^[a-f0-9]{64}$/);assert.match(v.imageId,/^sha256:[a-f0-9]{64}$/);
 const plan=localCheckPlan(v.image);
 assert.equal(v.steps.length,plan.length,'FINAL_LOCAL_CHECKS_INCOMPLETE');
 v.steps.forEach((s,i)=>{assert.equal(s.name,plan[i].name);assert.equal(s.command,plan[i].command);assert.deepEqual(s.args,plan[i].args);assert.equal(s.exitCode,0);assert.equal(s.signal,null);assert.equal(s.interrupted,false);assert.match(s.logSha256,/^[a-f0-9]{64}$/);assert.equal(s.log,s.name+'.log');});
 assert.equal(v.sourceUnchanged,true);assert.equal(v.ownedImageTagRemoved,true);assert.equal(v.cloudflareDeployments,0);assert.equal(v.cloudflareCalculations,0);
 assert.deepEqual(v.security.map(s=>s.name),['workflow','secret-rules','secrets-history','secrets-worktree','sast','dependencies-and-container-config','sbom','container-image','container-sbom']);assert(v.security.every(s=>s.exitCode===0));assert.equal(v.securityImage,v.imageId);
 if(v.imageArchive){assert.equal(v.imageArchive.file,'optimizer-image.tar');assert.match(v.imageArchive.sha256,/^[a-f0-9]{64}$/);assert(Number.isSafeInteger(v.imageArchive.bytes)&&v.imageArchive.bytes>0&&v.imageArchive.bytes<=2_000_000_000);}
 return v;
}
function git(args){const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:8_000_000});assert.equal(r.status,0,'FINAL_LOCAL_GIT_UNAVAILABLE');return r.stdout;}
export async function currentLocalCheckSource(){
 assert.equal(git(['status','--porcelain']),'','FINAL_LOCAL_CHECKS_DIRTY_SOURCE');
 const sourceCommit=git(['rev-parse','HEAD']).trim(),files=git(['ls-files','-z']).split('\0').filter(Boolean).sort(),records=[];
 for(const file of files)records.push([file,sha(await readFile(file))]);
 return {sourceCommit,sourceSha256:sha(JSON.stringify(records))};
}
export async function verifyLocalCheckFiles(root,sourceCommit,{current=false,expectedSha256}={}){
 const dir=path.resolve(root);assert.equal(await realpath(dir),dir);assert.equal((await lstat(dir)).mode&0o077,0);
 const file=dir+'/report.json',s=await lstat(file);assert(s.isFile()&&s.size<100_000&&(s.mode&0o077)===0);assert.equal(await realpath(file),file);
 const bytes=await readFile(file);if(expectedSha256)assert.equal(sha(bytes),expectedSha256,'FINAL_LOCAL_CHECKS_REPORT_CHANGED');
 const value=assertLocalCheckReport(JSON.parse(bytes),sourceCommit);
 for(const step of value.steps){const p=dir+'/'+step.log;assert.equal(await realpath(p),p);assert.equal(sha(await readFile(p)),step.logSha256,'FINAL_LOCAL_CHECKS_LOG_CHANGED');}
 if(value.imageArchive){const p=dir+'/'+value.imageArchive.file;assert.equal(await realpath(p),p);const st=await lstat(p);assert(st.isFile()&&st.nlink===1&&(st.mode&0o077)===0);assert.equal(st.size,value.imageArchive.bytes);assert.equal(await hashLocalImageArchive(p),value.imageArchive.sha256,'FINAL_LOCAL_IMAGE_ARCHIVE_CHANGED');}
 if(current){const now=await currentLocalCheckSource();assert.equal(now.sourceCommit,sourceCommit);assert.equal(now.sourceSha256,value.sourceSha256,'FINAL_LOCAL_CHECKS_CONTENT_CHANGED');}
 return {value,evidenceSha256:sha(bytes)};
}
