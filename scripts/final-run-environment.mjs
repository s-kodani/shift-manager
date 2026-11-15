import {deploymentTarget} from './deployment-target.mjs';
// Validate transport ownership before any HTTP. No deployment or fetch here.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {assertLocalDirectConfig} from './local-direct-config.mjs';
import {readFinalOwner} from './final-run-control.mjs';
import {verifyLocalCheckFiles} from './final-local-checks.mjs';
import {assertFrozenFinalRelease} from './final-release-policy.mjs';
import {verifyFinalFreezeProof} from './final-freeze-proof.mjs';
export {assertFrozenFinalRelease};
export const FINAL_CLOUD_BASE=deploymentTarget.appOrigin;
export const FINAL_ACTIONS=['prepare','run','csv-only','d1-only','d1-status','resume-reallocation','status','cleanup'];
const hash=b=>createHash('sha256').update(b).digest('hex');
async function privateRoot(root,kind){
 assert.match(path.basename(root),/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
 assert.equal(root,path.resolve('.cache',kind,path.basename(root)));assert.equal(await realpath(root),root);assert.equal((await lstat(root)).mode&0o077,0);
}
async function privateJson(file){assert.equal(await realpath(file),file);const s=await lstat(file);assert(s.isFile()&&(s.mode&0o077)===0&&s.size<2_000_000);return JSON.parse(await readFile(file));}
async function token(root){
 const file=root+'/.dev.vars';assert.equal(await realpath(file),file);assert.equal((await lstat(file)).mode&0o077,0);
 const lines=(await readFile(file,'utf8')).trim().split('\n'),values=Object.fromEntries(lines.map(l=>{const i=l.indexOf('=');assert(i>0);return [l.slice(0,i),l.slice(i+1)];}));assert(values.POC_TOKEN&&values.POC_TOKEN.length>=32);return values.POC_TOKEN;
}
export async function loadLocalFinalEnvironment(action,arg){
 assert(FINAL_ACTIONS.includes(action),'FINAL_LOCAL_USAGE');const root=path.resolve(arg??'');await privateRoot(root,'bounded-sdk');
 const info=await privateJson(root+'/runtime.json');
 assert.equal(info.root,root);assert.equal(info.id,path.basename(root));assert.equal(info.config,root+'/app.jsonc');assert.equal(info.artifact,path.resolve('artifacts/bounded-sdk',info.id));assert.equal(info.mode,'local');assert.equal(info.finalAcceptance,true);assert.equal(info.staffCount,101);
 const cfg=await privateJson(info.config);assertLocalDirectConfig(cfg,{config:info.config,port:8787,bounded:true,finalAcceptance:true});
 return {action,root,info,base:'http://localhost:8787',pocToken:await token(root),cases:JSON.parse(await readFile('docs/mvp/cloudflare-final-cases.json'))};
}
export async function loadCloudFinalEnvironment(action,arg){
 assert(['prepare','run','status','d1-status','cleanup'].includes(action),'FINAL_CLOUD_USAGE');const root=path.resolve(arg??'');await privateRoot(root,'final-cloudflare');
 const info=await privateJson(root+'/runtime.json');assert.equal(info.id,path.basename(root));assert.equal(info.root,root);assert.equal(info.mode,'cloudflare');assert.equal(info.base,FINAL_CLOUD_BASE);assert.equal(info.artifact,path.resolve('artifacts/final-cloudflare',info.id));
 assert.equal(await realpath(info.artifact),info.artifact);assert.equal((await lstat(info.artifact)).mode&0o077,0);
 const file=root+'/execution-release.json',observing=['status','d1-status','cleanup'].includes(action);
 const casesFile=observing?root+'/execution-cases.json':path.resolve('docs/mvp/cloudflare-final-cases.json'),cases=JSON.parse(await readFile(casesFile));
 const release=await privateJson(observing?file:root+'/release.json');assert.equal(release.state,'FROZEN','FINAL_RELEASE_NOT_FROZEN');
 if(observing){
  assertFrozenFinalRelease(release,{sourceCommit:release.sourceCommit,casesSha256:release.casesSha256,configSha256:release.configSha256,sourceInputSha256:release.sourceInputSha256});
  const owner=await readFinalOwner(root+'/acceptance');assert.equal(owner.sourceCommit,release.sourceCommit);assert.equal(hash(await readFile(casesFile)),release.casesSha256);assert.equal(owner.casesSha256,hash(JSON.stringify(cases)));
  const bound=await privateJson(root+'/execution-binding.json');assert.equal(bound.releaseSha256,hash(await readFile(file)));assert.equal(bound.base,info.base);assert.equal(bound.id,info.id);
 }else{
  const result=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'});assert.equal(result.status,0);
  const dirty=spawnSync('git',['status','--porcelain'],{encoding:'utf8'});assert.equal(dirty.status,0);assert.equal(dirty.stdout,'','FINAL_WORKTREE_NOT_CLEAN');
  assertFrozenFinalRelease(release,{sourceCommit:result.stdout.trim(),casesSha256:hash(await readFile('docs/mvp/cloudflare-final-cases.json')),configSha256:hash(await readFile('infra/wrangler.jsonc')),sourceInputSha256:hash(await readFile(info.artifact+'/source.json'))});
  if(action==='run'){assert.equal(hash(await readFile(file)),hash(await readFile(root+'/release.json')),'FINAL_EXECUTION_RELEASE_CHANGED');}
 }
 if(release.localChecks)await verifyLocalCheckFiles(root+(observing?'/execution-local-checks':'/local-checks'),release.sourceCommit,{current:!observing,expectedSha256:release.localChecks.evidenceSha256});
 await verifyFinalFreezeProof(root,await readFile(observing?file:root+'/release.json'));
 return {action,root,info,base:info.base,pocToken:await token(root),cases,sourceCommit:release.sourceCommit,release};
}
