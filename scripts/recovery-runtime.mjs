import {targetFetch} from './deployment-target.mjs';
// Resolve one existing local owner or the archived final Cloudflare owner.
import assert from 'node:assert/strict';
import path from 'node:path';
import {privateRecoveryFile} from './recovery-security-client.mjs';
import {privateOperatorToken,boundedJson} from './operator-client.mjs';
import {validateLocalRestoreProfile} from './local-restore-profile.mjs';
import {validateFinalRecoveryProfile,readFinalRecoveryBinding,FINAL_RECOVERY_KIND,assertFinalRecoveryCurrentSource} from './final-recovery-profile.mjs';
export async function resolveRecoveryProfile(manifest,file,p){
 if(p.kind===FINAL_RECOVERY_KIND)return validateFinalRecoveryProfile(manifest,file,p);
 return validateLocalRestoreProfile(manifest,file,p);
}
export async function recoveryOperator(p,{source=false}={}){
 if(p.kind===FINAL_RECOVERY_KIND){
  const c=await readFinalRecoveryBinding(p.cohortRoot);const {flags,targetIdentity,...profile}=p;assert.deepEqual(profile,c.p);
  return {base:source?c.sourceOperatorBase:c.operatorBase,tokenFile:c.dir+(source?'/source-secrets.json':'/secrets.json'),cfg:source?c.sourceOperator:c.operator,cohortRoot:c.root,bindingSha256:c.bindingSha256};
 }
 assert(!source,'RECOVERY_LOCAL_SOURCE_RESOLVED_SEPARATELY');
 const cfg=await privateRecoveryFile(path.join(path.dirname(p.configFile),'operator.jsonc'));
 assert.equal(cfg.vars.RECOVERY_SECURITY_ID,p.rehearsalId);assert.equal(cfg.vars.RECOVERY_DATABASE_ID,p.databaseId);assert.equal(cfg.d1_databases[0].database_id,p.databaseId);
 return {base:cfg.vars.LOCAL_FINAL_RECOVERY?'http://localhost:8790':'http://localhost:8788',tokenFile:path.join(path.dirname(p.configFile),'secrets.json'),cfg};
}
export async function authenticatedRecoveryOperator(p,options){
 const context=await recoveryOperator(p,options);
 if(options?.mutating&&p.kind===FINAL_RECOVERY_KIND){const c=await readFinalRecoveryBinding(p.cohortRoot);assertFinalRecoveryCurrentSource({...c.p,targetIdentity:{sourceCommit:c.release.sourceCommit}});}
 return {...context,token:await privateOperatorToken(context.tokenFile)};
}
export function operatorRequest({base,token},fetchImpl=targetFetch,max=1_000_000){
 const allowed=new Set(['/maintenance/status','/maintenance/command','/maintenance/inspect','/maintenance/leases','/recovery/security/checkpoint','/recovery/security/reconcile','/recovery/security/inspect','/recovery/security/reissue','/recovery/security/reissue/inspect']);
 return async(route,body)=>{assert(allowed.has(route),'RECOVERY_OPERATOR_ROUTE_REJECTED');const r=await fetchImpl(base+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});return {status:r.status,body:await boundedJson(r,max)};};
}
