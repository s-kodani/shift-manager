// Fixed local quality checks. No CI claims, deployment or cloud solve.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,mkdir,realpath,lstat,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {save as saveAtomic} from './backup-lib.mjs';
import {localCheckPlan,assertLocalCheckReport,currentLocalCheckSource,verifyLocalCheckFiles,hashLocalImageArchive} from './final-local-check-proof.mjs';
export {localCheckPlan,assertLocalCheckReport,currentLocalCheckSource,verifyLocalCheckFiles};
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function executeLocalCheck(command,args,{log,env}){
 return new Promise((resolve,reject)=>{
  let ended=false,interrupted=false,timer,killTimer;const chunks=[];let bytes=0;
  const child=spawn(command,args,{env,stdio:['ignore','pipe','pipe'],detached:true});
  const stop=()=>{if(interrupted)return;interrupted=true;try{process.kill(-child.pid,'SIGTERM');}catch{};killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},5000);};
  timer=setTimeout(stop,600_000);
  for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{bytes+=c.length;if(bytes<=32_000_000)chunks.push(c);else stop();});
  const finish=async(exitCode,signal)=>{if(ended)return;ended=true;clearTimeout(timer);clearTimeout(killTimer);await writeFile(log,Buffer.concat(chunks),{mode:0o600,flag:'wx'});resolve({exitCode,signal,interrupted});};
  child.on('error',()=>{void finish(null,'SPAWN_ERROR').catch(reject);});child.on('close',(code,signal)=>{void finish(code,signal).catch(reject);});
 });
}
export async function runLocalChecks(root,{inspect=currentLocalCheckSource,execute=executeLocalCheck,environment=process.env}={}){
 const dir=path.resolve(root),id=path.basename(dir);assert.match(id,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);assert.equal(dir,path.resolve('.cache/final-local-checks',id));
 await mkdir(path.dirname(dir),{recursive:true,mode:0o700});await mkdir(dir,{mode:0o700});assert.equal(await realpath(dir),dir);
 const source=await inspect(),image='shift-planner-final-gates-'+id.replaceAll('-','').slice(0,12);
 const v={schema:'final-local-checks-v1',id,provider:'local',decision:'ADR0111',ci:'HELD_NOT_SUCCESS',state:'RUNNING',...source,image,imageId:null,startedAt:Date.now(),steps:[],security:[],cloudflareDeployments:0,cloudflareCalculations:0};
 const save=()=>saveAtomic(dir+'/report.json',v);await save();
 const env={...environment,SEMGREP_SEND_METRICS:'off',SEMGREP_ENABLE_VERSION_CHECK:'0'};
 for(const key of Object.keys(env))if(key.startsWith('NATIVE_'))delete env[key];delete env.SECURITY_IMAGE;
 try{
  for(const step of localCheckPlan(image)){
   v.running=step.name;await save();const log=step.name+'.log';
   const r=await execute(step.command,step.args,{log:dir+'/'+log,env:{...env,...(v.imageId?{SECURITY_IMAGE:v.imageId}:{})}});
   v.steps.push({...step,...r,log,logSha256:sha(await readFile(dir+'/'+log))});delete v.running;await save();
   assert.equal(r.exitCode,0,'FINAL_LOCAL_CHECK_FAILED');assert.equal(r.signal,null,'FINAL_LOCAL_CHECK_FAILED');assert.equal(r.interrupted,false,'FINAL_LOCAL_CHECK_FAILED');
   if(step.name==='image-build'){
    const r=spawnSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'});assert.equal(r.status,0);v.imageId=r.stdout.trim();assert.match(v.imageId,/^sha256:[a-f0-9]{64}$/);await save();
   }
  }
  const sec=JSON.parse(await readFile('artifacts/security/summary.json'));v.security=sec.statuses;v.securityImage=sec.image;
  const final=await inspect();assert.deepEqual(final,source,'FINAL_LOCAL_CHECKS_SOURCE_CHANGED');v.sourceUnchanged=true;
  // Preserve the exact tested image before removing this run's tag. Promoting
  // this artifact avoids a deployment rebuild with different filesystem metadata.
  const archive=dir+'/optimizer-image.tar',saved=spawnSync('docker',['image','save','--output',archive,v.imageId],{encoding:'utf8',timeout:120000});assert.equal(saved.status,0,'FINAL_LOCAL_IMAGE_ARCHIVE_FAILED');await chmod(archive,0o600);v.imageArchive={file:'optimizer-image.tar',bytes:(await lstat(archive)).size,sha256:await hashLocalImageArchive(archive)};
  v.state='CHECKS_FINISHED';
 }catch{v.state='FAILED';}
 // Remove only this owned tag; never delete shared image IDs or other tags.
 if(v.imageId){const r=spawnSync('docker',['image','rm',image],{encoding:'utf8'});v.ownedImageTagRemoved=r.status===0;}
 if(v.state==='CHECKS_FINISHED'&&v.ownedImageTagRemoved)v.state='PASSED';else v.state='FAILED';
 v.finishedAt=Date.now();if(v.state==='PASSED'){try{assertLocalCheckReport(v,source.sourceCommit);}catch{v.state='FAILED';}}await save();return v;
}
