// Local-only Docker admission for an isolated real SDK run. Product Workers
// never import this module. No solver/checker payload passes through this gate.
import http from 'node:http';
import {spawn} from 'node:child_process';
import {chmod,writeFile,readFile,unlink,lstat} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {assertNativeSources,cgroupObservationCode} from './native-resource-profile.mjs';

const LIMIT=128*1024, MEMORY=6*1024**3;
export const SDK_PROXY_IMAGE='cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';
function ownedName(owner,name){
 assert(/^shift-planner-(?:bounded-sdk|restore)-[a-f0-9]{12}$/.test(owner),'INVALID_LOCAL_OWNER');
 const prefix='workerd-'+owner+'-OptimizerContainer-';
 assert(typeof name==='string'&&name.startsWith(prefix),'FOREIGN_CONTAINER');
 const suffix=name.slice(prefix.length);
 assert(/^[a-f0-9]{64}(-proxy)?$/.test(suffix),'INVALID_CONTAINER_NAME');
 return suffix.endsWith('-proxy');
}
export function quotaCreate(owner,name,body){
 const proxy=ownedName(owner,name);
 assert(typeof body.Image==='string','MISSING_IMAGE');
 if(proxy)assert.equal(body.Image,SDK_PROXY_IMAGE,'UNEXPECTED_PROXY_IMAGE');
 else assert(/^cloudflare-dev\/optimizercontainer:[a-f0-9]+$/.test(body.Image),'UNEXPECTED_OPTIMIZER_IMAGE');
 return {proxy,body:proxy?body:{...body,HostConfig:{...body.HostConfig,NanoCpus:1_000_000_000,Memory:MEMORY,MemorySwap:MEMORY}}};
}
export function recordOwnedDeletion(record,event){
 assert(['DELETE'].includes(event.method));
 record.deletionEvents??=[];record.deletionEvents.push(event);
 // SDK startup/shutdown can DELETE a known name again after removal. A later
 // 404 is an idempotent absence observation, not the original removal time.
 if([204,404].includes(event.status)){
  record.deletedAt??=event.responseAt;
  record.firstDeletionStatus??=event.status;
 }
}
async function bytes(stream){
 let size=0;const chunks=[];
 for await(const chunk of stream){size+=chunk.length;assert(size<=LIMIT,'DOCKER_METADATA_LIMIT');chunks.push(chunk);}
 return Buffer.concat(chunks);
}
function command(upstreamSocket,args){
 return new Promise((resolve,reject)=>{
  const p=spawn('docker',['--host','unix://'+upstreamSocket,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';
  const timer=setTimeout(()=>p.kill('SIGTERM'),15000);
  p.stdout.on('data',c=>{out+=c;if(out.length>LIMIT)p.kill('SIGTERM');});
  p.stderr.on('data',c=>{err+=c;if(err.length>LIMIT)p.kill('SIGTERM');});
  p.on('error',e=>{clearTimeout(timer);reject(e);});
  p.on('exit',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error('DOCKER_OBSERVATION_FAILED'));});
 });
}
export function assertOptimizerCreateAllowed(proxy,readOnly){assert(!readOnly||proxy,'OPTIMIZER_CREATION_DISABLED');}
export async function startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId,proxyImageId,evidenceFile,stopFaultFile,readOnly=false}){
 assert.notEqual(socketPath,upstreamSocket);assert(/^sha256:[a-f0-9]{64}$/.test(optimizerImageId));
 assert(/^sha256:[a-f0-9]{64}$/.test(proxyImageId));
 // A private fresh socket is required; never unlink another run's socket.
 await assert.rejects(lstat(socketPath),{code:'ENOENT'});
 const records=[],errors=[],faults=[],absentDeletes=[],ids=new Map(),connections=new Set();let closed=false,writing=Promise.resolve();
 const persist=()=>{const data=JSON.stringify({owner,optimizerImageId,proxyImageId,readOnly,records,errors,faults,absentDeletes,closed},(key,value)=>['timer','observing'].includes(key)?undefined:value,2)+'\n';writing=writing.then(()=>writeFile(evidenceFile,data,{mode:0o600}));return writing;};
 async function rejectOwnedStop(){
  if(!stopFaultFile)return false;
  let stat;try{stat=await lstat(stopFaultFile);}catch(e){if(e.code==='ENOENT')return false;throw e;}
  assert(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.size<1024,'INVALID_LOCAL_STOP_FAULT');
  const control=JSON.parse(await readFile(stopFaultFile,'utf8'));
  assert.equal(control.owner,owner,'FOREIGN_LOCAL_STOP_FAULT');
  assert.equal(control.mode,'reject-owned-stop','INVALID_LOCAL_STOP_FAULT');
  return true;
 }
 function upstream(method,path,headers,body){
  return new Promise((resolve,reject)=>{
   const request=http.request({socketPath:upstreamSocket,method,path,headers},resolve);
   request.on('error',reject);if(body)request.end(body);else request.end();
  });
 }
 async function inspect(id){const response=await upstream('GET','/containers/'+encodeURIComponent(id)+'/json',{});assert.equal(response.statusCode,200,'OWNED_CONTAINER_INSPECTION_FAILED');return JSON.parse(await bytes(response));}
 async function observe(record){
  try{const counters=JSON.parse(await command(upstreamSocket,['exec',record.id,'python','-c',cgroupObservationCode]));
   assert.equal(counters.memoryMax,String(MEMORY));assert.equal(counters.cpuMax,'100000 100000');
   record.observations.push({at:new Date().toISOString(),...counters});
  }catch{errors.push({at:new Date().toISOString(),kind:'RESOURCE_OBSERVATION_FAILED',id:record.id});}
 }
 async function stopMonitor(record){
  clearInterval(record.timer);record.timer=null;await record.observing;
  if(record.deletedAt)return;
  const actual=await inspect(record.id);record.beforeStop={...actual.State};
  if(!record.proxy&&actual.State.Running)await observe(record);
 }
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://docker.local'),api=url.pathname.replace(/^\/v[0-9]+\.[0-9]+/,'');
   let body=null,record=null;const receivedAt=new Date().toISOString();
   if(req.method==='POST'&&api==='/containers/create'){
    const original=JSON.parse(await bytes(req)),name=url.searchParams.get('name');
    const prepared=quotaCreate(owner,name,original);
    assertOptimizerCreateAllowed(prepared.proxy,readOnly);
    const image=await upstream('GET','/images/'+encodeURIComponent(original.Image)+'/json',{});
    assert.equal(image.statusCode,200,'IMAGE_INSPECTION_FAILED');
    const info=JSON.parse(await bytes(image));assert(info.Id===(prepared.proxy?proxyImageId:optimizerImageId),'IMAGE_ID_MISMATCH');
    body=Buffer.from(JSON.stringify(prepared.body));record={name,proxy:prepared.proxy,imageId:info.Id,at:new Date().toISOString(),observations:[]};
   }else if(!['GET','HEAD'].includes(req.method)){
    const target=api.match(/^\/containers\/([^/]+)\/(start|stop|kill|wait)$/)?.[1]??api.match(/^\/containers\/([^/]+)$/)?.[1];
    const decoded=decodeURIComponent(target??'');record=ids.get(decoded);
    if(!record&&req.method==='DELETE'){
     // workerd removes its prospective names before first creation. Reconcile
     // an absent owned name without authorizing deletion of an unknown object.
     ownedName(owner,decoded);
     const actual=await upstream('GET','/containers/'+encodeURIComponent(decoded)+'/json',{});
     await bytes(actual);assert.equal(actual.statusCode,404,'UNOWNED_EXISTING_CONTAINER');
     absentDeletes.push({name:decoded,at:new Date().toISOString()});
     res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({message:'No such owned container'}));return;
    }
    assert(record,'FOREIGN_DOCKER_MUTATION');
    assert(req.method==='DELETE'||(req.method==='POST'&&/\/(start|stop|kill|wait)$/.test(api)),'UNSUPPORTED_DOCKER_MUTATION');
    if(/\/(stop|kill)$/.test(api)||req.method==='DELETE'){
     // Explicit local diagnostic: reject only a created owned optimizer's stop.
     // Never forward a faulted mutation or stop its resource observations.
     if(!record.proxy&&await rejectOwnedStop()){
      const actual=await inspect(record.id);
      faults.push({at:new Date().toISOString(),kind:'OWNED_STOP_REJECTED',id:record.id,method:req.method,path:api,running:actual.State.Running});
      res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({message:'CONTROLLED_LOCAL_STOP_FAILURE'}));return;
     }
     await stopMonitor(record);
    }
    if(/\/start$/.test(api)&&!record.proxy){
     const actual=await inspect(record.id);assert.equal(actual.Image,optimizerImageId);
     for(const [k,v] of Object.entries({NanoCpus:1_000_000_000,Memory:MEMORY,MemorySwap:MEMORY}))assert.equal(actual.HostConfig[k],v,'QUOTA_NOT_APPLIED_BEFORE_START');
     record.beforeStart={running:actual.State.Running,limits:{NanoCpus:actual.HostConfig.NanoCpus,Memory:actual.HostConfig.Memory,MemorySwap:actual.HostConfig.MemorySwap}};
     assert.equal(actual.State.Running,false,'UNEXPECTED_ALREADY_RUNNING');
    }
   }
   const headers={...req.headers};delete headers.host;
   if(body){headers['content-length']=String(body.length);delete headers['transfer-encoding'];}
   const forwardedAt=new Date().toISOString();
   const forwarded=body?await upstream(req.method,req.url,headers,body):await new Promise((resolve,reject)=>{
    const request=http.request({socketPath:upstreamSocket,method:req.method,path:req.url,headers},resolve);request.on('error',reject);req.pipe(request);
   });
   if(record&&req.method==='POST'&&api==='/containers/create'){
    const data=await bytes(forwarded);if(forwarded.statusCode===201){
     record.id=JSON.parse(data).Id;assert(/^[a-f0-9]{64}$/.test(record.id));records.push(record);ids.set(record.id,record);ids.set(record.name,record);
    }
    res.writeHead(forwarded.statusCode,forwarded.headers);res.end(data);
   }else if(record&&/\/start$/.test(api)&&forwarded.statusCode===204){
    await bytes(forwarded);record.startedAt=new Date().toISOString();
    if(!record.proxy){
     let health;for(let n=0;n<30;n++){
      try{health=JSON.parse(await command(upstreamSocket,['exec',record.id,'python','-c',"import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=1).read().decode())"]));break;}
      catch{await new Promise(r=>setTimeout(r,200));}
     }
     record.sourceHashes=await assertNativeSources(health);await observe(record);
     record.observing=Promise.resolve();record.timer=setInterval(()=>{record.observing=record.observing.then(()=>observe(record));},2000);
     record.timer.unref();
    }
    res.writeHead(204,forwarded.headers);res.end();
   }else{
    // Retain the owned identity for SDK wait requests which arrive after
    // deletion. Forward Docker's normal 404; do not reclassify it as foreign.
    if(record&&req.method==='DELETE')recordOwnedDeletion(record,{method:'DELETE',receivedAt,forwardedAt,responseAt:new Date().toISOString(),status:forwarded.statusCode});
    res.writeHead(forwarded.statusCode,forwarded.headers);forwarded.pipe(res);
   }
  }catch(error){
   errors.push({at:new Date().toISOString(),kind:'DOCKER_GATE_REQUEST_REJECTED',code:/^[A-Z_]+$/.test(error.message)?error.message:'ADMISSION_FAILED',method:req.method,path:new URL(req.url,'http://docker.local').pathname});
   if(!res.headersSent){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({message:'LOCAL_DOCKER_ADMISSION_REJECTED'}));}else res.destroy();
  }finally{await persist();}
 });
 server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});
 // Docker's attach protocol upgrades the HTTP connection to a duplex stream.
 // Only read/attach on a container created through this gate can be upgraded.
 server.on('upgrade',(req,socket,head)=>{
  const api=new URL(req.url,'http://docker.local').pathname.replace(/^\/v[0-9]+\.[0-9]+/,'');
  const id=api.match(/^\/containers\/([^/]+)\/attach$/)?.[1];
  if(!ids.has(id)){socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');return;}
  const request=http.request({socketPath:upstreamSocket,method:req.method,path:req.url,headers:req.headers});
  request.on('upgrade',(response,remote,remoteHead)=>{
   socket.write('HTTP/1.1 '+response.statusCode+' '+response.statusMessage+'\r\n'+Object.entries(response.headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
   if(remoteHead.length)socket.write(remoteHead);if(head.length)remote.write(head);socket.pipe(remote);remote.pipe(socket);
   socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  });request.on('error',()=>socket.destroy());request.end();
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});await chmod(socketPath,0o600);
 return {records,errors,faults,async close(){
  closed=true;for(const record of records){clearInterval(record.timer);await record.observing;delete record.timer;delete record.observing;}
  for(const socket of connections)socket.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await unlink(socketPath).catch(e=>{if(e.code!=='ENOENT')throw e;});await persist();
 }};
}
