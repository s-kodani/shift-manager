// A separate command namespace for each frozen cohort and source/target side.
import assert from 'node:assert/strict';
import path from 'node:path';
import {privateRecoveryFile} from './recovery-security-client.mjs';
import {readFinalRecoveryBinding,FINAL_RECOVERY_KIND} from './final-recovery-profile.mjs';
import {authenticatedRecoveryOperator} from './recovery-runtime.mjs';
export async function resolveFinalMaintenance(profileFile,side,{authenticate=true,mutating=false}={}){
 assert(['source','target'].includes(side),'FINAL_MAINTENANCE_SIDE_REQUIRED');
 const profile=await privateRecoveryFile(profileFile);assert.equal(profile.kind,FINAL_RECOVERY_KIND);
 const context=await readFinalRecoveryBinding(profile.cohortRoot);assert.equal(path.resolve(profileFile),context.profileFile);assert.deepEqual(profile,context.p);
 const root=path.resolve('.cache/final-maintenance-commands',path.basename(context.root),side,context.bindingSha256);
 if(!authenticate)return {root,context,base:side==='source'?context.sourceOperatorBase:context.operatorBase};
 const transport=await authenticatedRecoveryOperator(profile,{source:side==='source',mutating});return {root,context,...transport};
}
