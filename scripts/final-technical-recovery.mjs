// Serial recovery after the four verified jobs. Unknown outcomes never replay.
import assert from 'node:assert/strict';
import {readFile,open,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {save} from './backup-lib.mjs';
export const RECOVERY_PHASES=['SOURCE_DOCUMENTS','SOURCE_FREEZE','CHECKPOINT','BACKUP','RESTORE','RESTORE_CONTENTS','TARGET_GUARD','SCHEMA_PREPARE','SCHEMA_APPLY','AUTH_PREPARE','AUTH_APPLY','TARGET_RESUME','TARGET_LOGIN','RESTORED_DOCUMENTS','TARGET_RETIRE','SOURCE_RESUME','PRIVATE_RETIRE'];
export async function runFinalTechnicalRecovery({root,id,sourceCommit,startedAt},handlers,{now=()=>Date.now()}={}){
 const file=root+'/recovery/workflow.json',lock=await open(root+'/acceptance/driver.lock','wx',0o600);
 let state,owned=false;
 try{
  try{state=JSON.parse(await readFile(file));}catch(e){if(e.code!=='ENOENT')throw e;}
  assert.equal(state,undefined,'FINAL_RECOVERY_ALREADY_STARTED_INSPECT_EXISTING_OWNER');
  assert(Number.isSafeInteger(startedAt)&&startedAt>0);assert.match(sourceCommit,/^[a-f0-9]{40}$/);
  state={schema:'final-technical-recovery-v1',cohortId:id,sourceCommit,startedAt,deadline:startedAt+1800000,state:'RUNNING',backupId:randomUUID(),phases:[],children:{}};await save(file,state);owned=true;
  if(typeof handlers==='function')handlers=await handlers();
  assert(RECOVERY_PHASES.every(name=>typeof handlers[name]==='function'),'FINAL_RECOVERY_ADAPTERS_INCOMPLETE');
  const remember=async(key,value)=>{assert(!Object.hasOwn(state.children,key),'FINAL_RECOVERY_CHILD_ALREADY_BOUND');state.children[key]=value;await save(file,state);};
  for(const name of RECOVERY_PHASES){
   assert.equal(typeof handlers[name],'function');assert(now()>=startedAt&&now()<state.deadline,'FINAL_RECOVERY_TIME_BUDGET');
   const phase={name,stage:'DISPATCHED',at:now()};state.phases.push(phase);await save(file,state);
   const result=await handlers[name](state,{remember});assert(result&&typeof result==='object','FINAL_RECOVERY_RESULT_UNCONFIRMED');
   phase.result=result;phase.stage='CONFIRMED';phase.finishedAt=now();await save(file,state);
   assert(phase.finishedAt<state.deadline,'FINAL_RECOVERY_TIME_BUDGET');
  }
  state.state='COMPLETE';state.finishedAt=now();await save(file,state);return {cohortId:id,state:state.state,phases:state.phases.length,backupId:state.backupId};
 }catch{
  if(owned&&state?.state==='RUNNING'){state.state='UNCERTAIN';state.failureAt=now();await save(file,state);}
  throw Error('FINAL_RECOVERY_STOPPED_INSPECT_SAME_OWNER');
 }finally{await lock.close();await unlink(root+'/acceptance/driver.lock');}
}
