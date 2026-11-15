// Fictional, ephemeral archive used only for offline adapter tests.
import {cp,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {prepareFinalOwner} from '../../../scripts/final-run-control.mjs';
import {FREEZE_FILES} from '../../../scripts/final-freeze-proof.mjs';
import {frozenCohortFixture} from './final-frozen-cohort.mjs';
export const sha=b=>createHash('sha256').update(b).digest('hex');
export async function finalRecoveryFixture(work){return frozenCohortFixture(async f=>{
 const {root,artifact}=f,dir=root+'/recovery',id=f.plan.cohortId,release=f.frozen,sourceCommit=release.sourceCommit;
 const write=(file,value)=>writeFile(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value),{mode:0o600});
 const read=async file=>JSON.parse(await readFile(dir+'/'+file));
 const profile=await read('profile.json'),app=await read('app.jsonc'),operator=await read('operator.jsonc'),sourceOperator=await read('source-operator.jsonc'),binding=await read('binding.json'),rid=profile.rehearsalId;
 async function seal(){
  for(const [file,value]of [['profile.json',profile],['app.jsonc',app],['operator.jsonc',operator],['source-operator.jsonc',sourceOperator]]){await write(dir+'/'+file,file==='source-operator.jsonc'?JSON.stringify(value,null,2)+'\n':value);binding.files[file]=sha(await readFile(dir+'/'+file));}
  await write(dir+'/binding.json',binding);release.cohort.recoveryBindings.evidenceSha256=sha(await readFile(dir+'/binding.json'));
  await write(root+'/execution-release.json',release);await write(root+'/execution-binding.json',{id,base:binding.source.appOrigin,releaseSha256:sha(await readFile(root+'/execution-release.json'))});
  // Deliberate fixture re-seal lets negative tests exercise semantic validation
  // even when a caller rehashes changed settings; never used by production.
  const receipt=JSON.parse(await readFile(root+'/freeze/state.json'));receipt.releaseSha256=sha(await readFile(root+'/execution-release.json'));receipt.files=await Promise.all(FREEZE_FILES.map(async file=>({file,sha256:sha(await readFile(root+'/'+file))})));await write(root+'/freeze/state.json',receipt);
 }
 const casesBytes=await readFile('docs/mvp/cloudflare-final-cases.json'),cases=JSON.parse(casesBytes);
 await cp(root+'/local-checks',root+'/execution-local-checks',{recursive:true});await write(root+'/execution-cases.json',casesBytes);await prepareFinalOwner(root+'/acceptance',{sourceCommit,cases});const owner=JSON.parse(await readFile(root+'/acceptance/owner.json'));owner.stage='RUNNING';await write(root+'/acceptance/owner.json',owner);
 const report={id,sourceCommit,stage:'FOUR_JOBS_VERIFIED',jobs:Object.fromEntries(['J1','J2','J3','J4'].map(slot=>[slot,{validation:'VERIFIED',stopped:true,rows:slot==='J4'?3131:31}]))};await write(artifact+'/final-acceptance.json',report);await seal();
 const manifest={source:{mode:'remote',databaseId:binding.source.databaseId,bucket:binding.source.bucket,env:'poc'}};
 return work({id,rid,root,dir,artifact,sourceCommit,profile,app,operator,sourceOperator,binding,release,report,manifest,write,seal});
});}
