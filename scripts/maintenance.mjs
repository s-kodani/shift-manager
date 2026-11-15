import {targetFetch} from './deployment-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
// Invocation is explicit. This command is not run by CI or scheduled backups.
import {prepareMaintenance,sendMaintenance,inspectMaintenance,currentMaintenance,listMaintenanceLeases} from './maintenance-client.mjs';
import {privateOperatorToken,boundedJson} from './operator-client.mjs';
import {resolveFinalMaintenance} from './final-maintenance-runtime.mjs';
import {operatorRequest} from './recovery-runtime.mjs';
let root='.cache/maintenance-commands';
const finalProfile=process.env.MAINTENANCE_FINAL_PROFILE;
let base=process.env.MAINTENANCE_OPERATOR_URL??deploymentTarget.operatorOrigin;
let url;
try{url=new URL(base);}catch{console.error('MAINTENANCE_OPERATOR_URL_INVALID');process.exit(1);}
if(url.origin!==base||!(base===deploymentTarget.operatorOrigin||(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))){console.error('MAINTENANCE_OPERATOR_URL_INVALID');process.exit(1);}
let token;
const tokenFile=process.env.MAINTENANCE_OPERATOR_SECRETS??deploymentTarget.operatorSecretsFile??'.cache/operator-secrets.json';
let request=async(path,body)=>{
 const r=await targetFetch(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
 return {status:r.status,body:await boundedJson(r,16_384)};
};
async function input(){let size=0;const chunks=[];for await(const c of process.stdin){size+=c.length;if(size>4096)throw new Error('MAINTENANCE_INPUT_LIMIT');chunks.push(c);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
try{
 const [action,id,...extra]=process.argv.slice(2);if(extra.length)throw new Error('MAINTENANCE_USAGE');let result;
 if(finalProfile){
  if(process.env.MAINTENANCE_OPERATOR_URL||process.env.MAINTENANCE_OPERATOR_SECRETS)throw new Error('MAINTENANCE_FINAL_OVERRIDE_REJECTED');
  const target=await resolveFinalMaintenance(finalProfile,process.env.MAINTENANCE_FINAL_SIDE,{authenticate:action!=='prepare',mutating:action==='send'});root=target.root;base=target.base;
  if(action!=='prepare'){token=target.token;request=operatorRequest(target,targetFetch,16_384);}
 }
 if(action==='prepare'&&!id)result=await prepareMaintenance(root,await input());
 else if(action==='status'&&!id){if(!finalProfile)token=await privateOperatorToken(tokenFile);result=await currentMaintenance(request);}
 else if(action==='leases'){if(!finalProfile)token=await privateOperatorToken(tokenFile);result=await listMaintenanceLeases(request,id??null);}
 else if(['send','inspect'].includes(action)&&id){if(!finalProfile)token=await privateOperatorToken(tokenFile);result=action==='send'?await sendMaintenance(root,id,request):await inspectMaintenance(root,id,request);}
 else throw new Error('MAINTENANCE_USAGE: prepare | status | leases [cursor] | send/inspect <owned-id>');
 console.log(JSON.stringify(result));
}catch(error){console.error(/^MAINTENANCE_|^OPERATOR_TOKEN_|^PRIVATE_OPERATOR_/.test(error.message)?error.message:'MAINTENANCE_COMMAND_FAILED');process.exitCode=1;}
