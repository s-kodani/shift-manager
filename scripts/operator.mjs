import {targetFetch} from './deployment-target.mjs';
import {deploymentTarget} from './deployment-target.mjs';
// Dedicated private PoC only. Never print credentials, input, tokens or bodies.
import {prepareProvision,sendProvision,inspectProvisionOwner,resumeProvision,boundedJson,privateOperatorToken} from './operator-client.mjs';
const root='.cache/operator-provisions',base=deploymentTarget.operatorOrigin;
let token;
async function input(){let size=0;const chunks=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>4096)throw new Error('INPUT_TOO_LARGE');chunks.push(chunk);}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
async function request(path,body){
 const response=await targetFetch(base+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
 return {status:response.status,body:await boundedJson(response)};
}
try{
 const [command,id,...extra]=process.argv.slice(2);if(extra.length)throw new Error('INVALID_COMMAND');let result;
 if(command==='prepare'&&!id)result=await prepareProvision(root,await input());
 else if(['send','inspect','resume'].includes(command)&&id){
  token=await privateOperatorToken(deploymentTarget.operatorSecretsFile??'.cache/operator-secrets.json');
  result=command==='send'?await sendProvision(root,id,request):command==='inspect'?await inspectProvisionOwner(root,id,request):await resumeProvision(root,id,request);
 }
 else throw new Error('USAGE: operator prepare | send/inspect/resume <owned-id>');
 console.log(JSON.stringify(result));
}catch(error){const allowed=/^(?:PRIVATE_OPERATOR_|INVALID_OPERATION_ID|INVALID_OPERATOR_RECEIPT|INSPECT_EXISTING_OPERATOR_OPERATION|OPERATOR_|INPUT_TOO_LARGE|INVALID_COMMAND|USAGE:)/;console.error(allowed.test(error.message)?error.message:'OPERATOR_COMMAND_FAILED');process.exitCode=1;}
