// Explicit self-hosting only. No default target, automatic provisioning or retry.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
const execute=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
let directory;
try{
 const args=process.argv.slice(2),i=args.indexOf('--target');assert(i>=0&&args[i+1],'REMOTE_TARGET_REQUIRED');
 const targetFile=path.resolve(args[i+1]);args.splice(i,2);assert(args.length>=1&&args.length<=2,'REMOTE_ARGUMENTS_INVALID');
 const [action,flag]=args,initial=flag==='--initial';assert(!flag||initial,'REMOTE_ARGUMENTS_INVALID');
 assert(['render','dry-run','deploy','deploy-operator','migrate','status'].includes(action),'REMOTE_ACTION_INVALID');assert(!initial||['deploy','migrate','deploy-operator'].includes(action),'INITIAL_ACTION_INVALID');
 process.env.SHIFT_MANAGER_TARGET=targetFile;
 const {requireDeploymentTarget,privateBytes,targetFetch}=await import('./deployment-target.mjs');
 const {renderTargetConfigs,projectRoot}=await import('./render-target.mjs');
 const {boundedPreflight,assertPocDeployReady}=await import('./poc-deploy-guard.mjs');
 const t=requireDeploymentTarget(),targetHash=sha(privateBytes(targetFile));
 process.chdir(projectRoot);directory=path.join(projectRoot,'.cache/deployments',randomUUID());await mkdir(directory,{recursive:true,mode:0o700});
 const save=(name,value)=>writeFile(directory+'/'+name+'.json',JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
 const files=await renderTargetConfigs(directory);
 async function run(name,argv,exe=process.execPath){
  await save(name+'-dispatch',{at:new Date().toISOString(),state:'DISPATCHED',command:exe,args:argv});
  try{const r=await execute(exe,argv,{cwd:projectRoot,timeout:360000,maxBuffer:16000000,env:{...process.env,CLOUDFLARE_ACCOUNT_ID:t.accountId,CLOUDFLARE_API_BASE_URL:'https://api.cloudflare.com/client/v4',CF_API_BASE_URL:'https://api.cloudflare.com/client/v4',WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:directory+'/wrangler.log'}});await writeFile(directory+'/'+name+'.private.log',r.stdout+r.stderr,{mode:0o600});await save(name+'-result',{state:'CONFIRMED',at:new Date().toISOString()});return r.stdout;}
  catch(e){await writeFile(directory+'/'+name+'.private.log',(e.stdout??'')+(e.stderr??''),{mode:0o600});await save(name+'-result',{state:'UNCONFIRMED_INSPECT_SAME_OWNER',at:new Date().toISOString()});throw Error('COMMAND_UNCONFIRMED_INSPECT_SAME_OWNER');}
 }
 function secretFile(kind){const file=kind==='operator'?t.operatorSecretsFile:t.appSecretsFile;assert(file,'PRIVATE_SECRETS_FILE_REQUIRED');const bytes=privateBytes(file),values=JSON.parse(bytes);const required=kind==='operator'?['OPERATOR_TOKEN']:['BETTER_AUTH_SECRET','POC_TOKEN','BROWSER_BASIC_USER','BROWSER_BASIC_PASSWORD'];for(const k of required)assert(typeof values[k]==='string'&&values[k].length>=(k==='BROWSER_BASIC_USER'?1:32),'SECRET_VALUE_REQUIRED');if(kind!=='operator')assert(!values.BROWSER_BASIC_USER.includes(':')&&values.BROWSER_BASIC_USER.length<=128&&values.BROWSER_BASIC_PASSWORD.length<=512,'BASIC_AUTH_VALUE_INVALID');return {file,values,hash:sha(bytes)};}
 async function preflight(name){const {values}=secretFile('app');const r=await targetFetch(t.appOrigin+'/__poc/deploy-preflight',{method:'POST',headers:{authorization:'Bearer '+values.POC_TOKEN},signal:AbortSignal.timeout(60000),redirect:'error'});const value=await boundedPreflight(r);await save(name,value);assertPocDeployReady(value);return value;}
 let apiToken;
 async function api(suffix,method='GET',body){
  if(!apiToken){const r=await execute(process.execPath,['node_modules/wrangler/bin/wrangler.js','auth','token','--json'],{timeout:30000,maxBuffer:65536,env:{...process.env,WRANGLER_SEND_METRICS:'false',WRANGLER_LOG_PATH:directory+'/wrangler.log'}});const d=JSON.parse(r.stdout);assert(['oauth','api_token'].includes(d.type)&&typeof d.token==='string'&&d.token.length>=20,'WRANGLER_AUTH_INVALID');apiToken=d.token;}
  return targetFetch('https://api.cloudflare.com/client/v4/accounts/'+t.accountId+suffix,{method,headers:{authorization:'Bearer '+apiToken,...body?{'content-type':'application/json'}:{}},body:body?JSON.stringify(body):undefined,redirect:'error'});
 }
 async function absent(worker,name){const r=await api('/workers/scripts/'+worker);await r.body?.cancel();assert.equal(r.status,404,'INITIAL_WORKER_MUST_NOT_EXIST');await save(name,{worker,absent:true,observedAt:new Date().toISOString()});}
 async function source(){const call=async a=>(await execute('git',a,{cwd:projectRoot,maxBuffer:2000000})).stdout.trim();assert.equal(await call(['rev-parse','--show-toplevel']),projectRoot,'SOURCE_REPOSITORY_REQUIRED');assert.equal(await call(['status','--porcelain']),'','CLEAN_SOURCE_REQUIRED');const commit=await call(['rev-parse','HEAD']),list=(await execute('git',['ls-files','-z'],{cwd:projectRoot,maxBuffer:2000000})).stdout.split('\0').filter(Boolean).sort(),hashes=[];for(const f of list)hashes.push([f,sha(await readFile(projectRoot+'/'+f))]);return {repository:'https://github.com/s-kodani/shift-manager',commit,sourceSha256:sha(JSON.stringify(hashes))};}
 if(action==='render'){console.log(JSON.stringify({action,files,directory}));}
 else if(action==='status'){console.log(JSON.stringify({directory,preflight:await preflight('status')}));}
 else{
  const before=await source();await save('source',before);
  const kind=action==='deploy-operator'?'operator':'app',worker=kind==='operator'?t.operatorWorkerName:t.workerName;
  if(initial)await absent(worker,'initial-before');else if(action!=='dry-run')await preflight('before-build');
  if(action==='migrate'){
   if(initial){const r=await api('/d1/database/'+t.databaseId+'/query','POST',{sql:"SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '_d1_*'"});assert(r.ok,'INITIAL_DATABASE_INSPECTION_FAILED');const d=await r.json();assert(d.success&&d.result?.[0]?.results?.length===0,'INITIAL_DATABASE_MUST_BE_EMPTY');}
   assert.equal(sha(privateBytes(targetFile)),targetHash,'TARGET_CHANGED');await run('migrate',['node_modules/wrangler/bin/wrangler.js','d1','migrations','apply','DB','--remote','--config',files.app]);
  }else{
   await run('build-app',['run','build:app'],'npm');assert.deepEqual(await source(),before,'SOURCE_CHANGED');assert.equal(sha(privateBytes(targetFile)),targetHash,'TARGET_CHANGED');
   if(action==='dry-run')await run('dry-run',['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config',files.app,'--outdir',directory+'/bundle']);
   else{
    const secrets=secretFile(kind);if(initial)await absent(worker,'initial-before-deploy');else await preflight('before-deploy');
    assert.equal(sha(privateBytes(secrets.file)),secrets.hash,'SECRETS_CHANGED');assert.equal(sha(privateBytes(targetFile)),targetHash,'TARGET_CHANGED');assert.deepEqual(await source(),before,'SOURCE_CHANGED');
    await run('deploy',['node_modules/wrangler/bin/wrangler.js','deploy','--config',files[kind],'--containers-rollout=immediate','--secrets-file',secrets.file,'--tag','source-'+before.commit.slice(0,12),'--message','Public source '+before.commit]);
    const r=await api('/workers/scripts/'+worker+'/deployments');assert(r.ok,'DEPLOYMENT_OBSERVATION_FAILED');const d=await r.json();assert(d.success&&d.result?.deployments?.[0]?.versions?.length===1&&d.result.deployments[0].versions[0].percentage===100,'DEPLOYMENT_NOT_CONFIRMED');await save('deployment',d.result);
   }
  }
  console.log(JSON.stringify({action,directory,source:before,completed:true,containerReadiness:action.startsWith('deploy')?'inspect rollout and perform the documented bounded smoke test':'not started'}));
 }
}catch{
 console.error(JSON.stringify({error:'REMOTE_ACTION_STOPPED',directory:directory??null,instruction:'Check target configuration and the same private dispatch receipt; do not automatically retry.'}));process.exitCode=1;
}
