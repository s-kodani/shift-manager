import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaCreate,SDK_PROXY_IMAGE,recordOwnedDeletion} from '../../scripts/bounded-docker-gate.mjs';
const owner='shift-planner-bounded-sdk-123456abcdef',name='workerd-'+owner+'-OptimizerContainer-'+'a'.repeat(64);
test('SDK creation receives limits before startup while original networking and command survive',()=>{
 const body={Image:'cloudflare-dev/optimizercontainer:abcd1234',Cmd:['python','-m','optimizer.server'],HostConfig:{NetworkMode:'container:owned-proxy',Memory:0,NanoCpus:0}};
 const result=quotaCreate(owner,name,body);
 assert.deepEqual(result.body.Cmd,body.Cmd);assert.equal(result.body.HostConfig.NetworkMode,body.HostConfig.NetworkMode);
 assert.equal(result.body.HostConfig.Memory,6*1024**3);assert.equal(result.body.HostConfig.MemorySwap,6*1024**3);assert.equal(result.body.HostConfig.NanoCpus,1e9);
 assert.equal(body.HostConfig.Memory,0);
});
test('foreign owner, malformed name and wrong image cannot create a resource acceptance container',()=>{
 for(const [o,n,b] of [[owner,name.replace(owner,'another-run'),{Image:'cloudflare-dev/optimizercontainer:abcd'}],
  [owner,name+'-other',{Image:'cloudflare-dev/optimizercontainer:abcd'}],[owner,name,{Image:'other-image'}],
  ['invalid',name,{Image:'cloudflare-dev/optimizercontainer:abcd'}]])assert.throws(()=>quotaCreate(o,n,b));
});
test('owned SDK egress proxy keeps its own limits and is never counted as the optimizer',()=>{
 const body={Image:SDK_PROXY_IMAGE,HostConfig:{Memory:0}};
 const result=quotaCreate(owner,name+'-proxy',body);assert.equal(result.proxy,true);assert.equal(result.body,body);
 assert.throws(()=>quotaCreate(owner,name+'-proxy',{Image:'cloudflare-dev/optimizercontainer:abcd'}));
});
test('restored SDK uses the same quota and still refuses another source or restore identity',()=>{
 const restored='shift-planner-restore-123456abcdef',n='workerd-'+restored+'-OptimizerContainer-'+'a'.repeat(64),body={Image:'cloudflare-dev/optimizercontainer:abcd'};
 assert.equal(quotaCreate(restored,n,body).body.HostConfig.Memory,6*1024**3);
 assert.throws(()=>quotaCreate(restored,name,body));assert.throws(()=>quotaCreate(owner,n,body));assert.throws(()=>quotaCreate(restored,n.replace('123456abcdef','fedcba654321'),body));
});
test('replayed absent DELETE retains the first confirmed removal time and both statuses',()=>{
 const r={},first={method:'DELETE',receivedAt:'2026-10-13T08:00:00.000Z',forwardedAt:'2026-10-13T08:00:00.010Z',responseAt:'2026-10-13T08:00:00.020Z',status:204},later={...first,responseAt:'2026-10-13T08:02:00.000Z',status:404};
 recordOwnedDeletion(r,first);recordOwnedDeletion(r,later);assert.equal(r.deletedAt,first.responseAt);assert.equal(r.firstDeletionStatus,204);assert.deepEqual(r.deletionEvents,[first,later]);
 const failed={};recordOwnedDeletion(failed,{...first,status:500});assert.equal(failed.deletedAt,undefined);recordOwnedDeletion(failed,later);assert.equal(failed.firstDeletionStatus,404);assert.equal(failed.deletedAt,later.responseAt);
});

import http from 'node:http';
import {mkdtemp,rm,writeFile,readFile,unlink,symlink} from 'node:fs/promises';
import {startBoundedDockerGate} from '../../scripts/bounded-docker-gate.mjs';
test('SDK pre-create DELETE reconciles only verified absent owned names and never deletes unknown containers',async()=>{
 const dir=await mkdtemp('/tmp/shift-gate-test-'),upstreamSocket=dir+'/up.sock',socketPath=dir+'/gate.sock',seen=[];
 const upstream=http.createServer((req,res)=>{seen.push({method:req.method,path:req.url});res.writeHead(req.url.includes('b'.repeat(64))?200:404,{'content-type':'application/json'});res.end('{}');});
 await new Promise(r=>upstream.listen(upstreamSocket,r));
 const gate=await startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId:'sha256:'+'c'.repeat(64),proxyImageId:'sha256:'+'d'.repeat(64),evidenceFile:dir+'/evidence.json'});
 const remove=n=>new Promise((resolve,reject)=>{const req=http.request({socketPath,method:'DELETE',path:'/containers/'+n},async res=>{for await(const chunk of res){}resolve(res.statusCode);});req.on('error',reject);req.end();});
 try{
  assert.equal(await remove(name),404);
  assert.equal(await remove(name+'-proxy'),404);
  assert.equal(await remove(name.replace('a'.repeat(64),'b'.repeat(64))),403);
  assert.equal(await remove(name.replace(owner,'foreign-run')),403);
  assert.equal(seen.filter(r=>r.method==='DELETE').length,0);
 }finally{await gate.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true});}
});

test('late SDK wait on a deleted created identity preserves Docker semantics without opening foreign writes',async()=>{
 const dir=await mkdtemp('/tmp/shift-gate-test-'),upstreamSocket=dir+'/up.sock',socketPath=dir+'/gate.sock',seen=[],id='f'.repeat(64);
 let removed=false;
 const upstream=http.createServer(async(req,res)=>{
  for await(const chunk of req){}seen.push({method:req.method,path:req.url});
  if(req.url.startsWith('/images/')){res.writeHead(200);res.end(JSON.stringify({Id:'sha256:'+'d'.repeat(64)}));}
  else if(req.url.startsWith('/containers/create')){res.writeHead(201);res.end(JSON.stringify({Id:id}));}
  else if(req.method==='GET'){res.writeHead(removed?404:200);res.end(JSON.stringify({State:{Running:false}}));}
  else{res.writeHead(req.method==='DELETE'&&!removed?204:404);if(req.method==='DELETE')removed=true;res.end();}
 });await new Promise(r=>upstream.listen(upstreamSocket,r));
 const gate=await startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId:'sha256:'+'c'.repeat(64),proxyImageId:'sha256:'+'d'.repeat(64),evidenceFile:dir+'/evidence.json'});
 const request=(method,url,body)=>new Promise((resolve,reject)=>{const r=http.request({socketPath,method,path:url},async res=>{for await(const chunk of res){}resolve(res.statusCode);});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
 try{
  assert.equal(await request('POST','/containers/create?name='+name+'-proxy',{Image:SDK_PROXY_IMAGE}),201);
  assert.equal(await request('DELETE','/containers/'+name+'-proxy'),204);
  const first=gate.records[0].deletedAt;
  assert.equal(await request('DELETE','/containers/'+id),404);
  assert.equal(gate.records[0].deletedAt,first);assert.equal(gate.records[0].firstDeletionStatus,204);
  assert.deepEqual(gate.records[0].deletionEvents.map(e=>e.status),[204,404]);
  assert.equal(await request('POST','/containers/'+name+'-proxy/wait'),404);
  assert.equal(await request('POST','/containers/'+id+'/wait'),404);
  assert.equal(await request('POST','/containers/'+'0'.repeat(64)+'/wait'),403);
  assert.equal(seen.filter(r=>r.method==='POST'&&r.path.endsWith('/wait')).length,2);
 }finally{await gate.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true});}
});

test('explicit local stop fault rejects only created owned optimizers, keeps evidence and permits recovery after removal',async()=>{
 const dir=await mkdtemp('/tmp/shift-gate-test-'),upstreamSocket=dir+'/up.sock',socketPath=dir+'/gate.sock',seen=[];
 const optimizerId='e'.repeat(64),proxyId='f'.repeat(64),stopFaultFile=dir+'/fault.json';let running=true;
 const upstream=http.createServer(async(req,res)=>{
  for await(const chunk of req){}seen.push({method:req.method,path:req.url});
  if(req.url.startsWith('/images/')){res.writeHead(200);res.end(JSON.stringify({Id:'sha256:'+(req.url.includes('proxy-everything')?'d':'c').repeat(64)}));}
  else if(req.url.startsWith('/containers/create')){res.writeHead(201);res.end(JSON.stringify({Id:req.url.endsWith('-proxy')?proxyId:optimizerId}));}
  else if(req.method==='GET'){res.writeHead(200);res.end(JSON.stringify({State:{Running:req.url.includes(optimizerId)&&running}}));}
  else{res.writeHead(204);res.end();}
 });await new Promise(r=>upstream.listen(upstreamSocket,r));
 const gate=await startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId:'sha256:'+'c'.repeat(64),proxyImageId:'sha256:'+'d'.repeat(64),evidenceFile:dir+'/evidence.json',stopFaultFile});
 const request=(method,url,body)=>new Promise((resolve,reject)=>{const r=http.request({socketPath,method,path:url},async res=>{for await(const chunk of res){}resolve(res.statusCode);});r.on('error',reject);r.end(body?JSON.stringify(body):undefined);});
 try{
  await writeFile(stopFaultFile,JSON.stringify({owner,mode:'reject-owned-stop'}),{mode:0o600});
  assert.equal(await request('POST','/containers/create?name='+name,{Image:'cloudflare-dev/optimizercontainer:abcd'}),201);
  assert.equal(await request('POST','/containers/create?name='+name+'-proxy',{Image:SDK_PROXY_IMAGE}),201);
  for(const [method,suffix] of [['POST','/stop'],['POST','/kill'],['DELETE','']])assert.equal(await request(method,'/containers/'+optimizerId+suffix),503);
  assert.equal(gate.faults.length,3);assert(gate.faults.every(f=>f.running&&f.id===optimizerId));
  assert.equal(seen.filter(r=>r.method!=='GET'&&r.path.startsWith('/containers/'+optimizerId)).length,0);
  assert.equal(await request('POST','/containers/'+proxyId+'/stop'),204);
  assert.equal(await request('POST','/containers/'+'0'.repeat(64)+'/stop'),403);
  await writeFile(stopFaultFile,JSON.stringify({owner:'foreign',mode:'reject-owned-stop'}));
  assert.equal(await request('POST','/containers/'+optimizerId+'/stop'),403);
  await unlink(stopFaultFile);await symlink(dir+'/evidence.json',stopFaultFile);
  assert.equal(await request('POST','/containers/'+optimizerId+'/stop'),403);
  await unlink(stopFaultFile);running=false;
  assert.equal(await request('POST','/containers/'+optimizerId+'/stop'),204);
  assert.equal(seen.filter(r=>r.method==='POST'&&r.path==='/containers/'+optimizerId+'/stop').length,1);
 }finally{await gate.close();await new Promise(r=>upstream.close(r));}
 const evidence=JSON.parse(await readFile(dir+'/evidence.json','utf8'));
 assert.equal(evidence.closed,true);assert.equal(evidence.faults.length,3);assert.equal(evidence.errors.length,3);
 await rm(dir,{recursive:true});
});

test('stale expected image rejects optimizer creation before any Docker mutation with a specific diagnostic',async()=>{
 const dir=await mkdtemp('/tmp/shift-gate-test-'),upstreamSocket=dir+'/up.sock',socketPath=dir+'/gate.sock',seen=[];
 const upstream=http.createServer(async(req,res)=>{for await(const chunk of req){}seen.push(req.method);
  res.writeHead(200);res.end(JSON.stringify({Id:'sha256:'+'e'.repeat(64)}));});
 await new Promise(r=>upstream.listen(upstreamSocket,r));
 const gate=await startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId:'sha256:'+'c'.repeat(64),proxyImageId:'sha256:'+'d'.repeat(64),evidenceFile:dir+'/evidence.json'});
 try{
  const status=await new Promise((resolve,reject)=>{const r=http.request({socketPath,method:'POST',path:'/containers/create?name='+name},async res=>{for await(const chunk of res){}resolve(res.statusCode);});r.on('error',reject);r.end(JSON.stringify({Image:'cloudflare-dev/optimizercontainer:abcd'}));});
  assert.equal(status,403);assert.deepEqual(seen,['GET']);assert.equal(gate.records.length,0);
  assert.equal(gate.errors[0].code,'IMAGE_ID_MISMATCH');
 }finally{await gate.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true});}
});

test('read-only SDK rejects optimizer creation before any daemon request',async()=>{
 const dir=await mkdtemp('/tmp/shift-gate-readonly-'),upstreamSocket=dir+'/up.sock',socketPath=dir+'/gate.sock',seen=[];
 const upstream=http.createServer((req,res)=>{seen.push(req.url);res.end('{}');});await new Promise(r=>upstream.listen(upstreamSocket,r));
 const gate=await startBoundedDockerGate({socketPath,upstreamSocket,owner,optimizerImageId:'sha256:'+'c'.repeat(64),proxyImageId:'sha256:'+'d'.repeat(64),evidenceFile:dir+'/evidence.json',readOnly:true});
 try{const status=await new Promise((resolve,reject)=>{const req=http.request({socketPath,method:'POST',path:'/containers/create?name='+name,headers:{'content-type':'application/json'}},async res=>{for await(const c of res){}resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify({Image:'cloudflare-dev/optimizercontainer:abcd1234',HostConfig:{}}));});assert.equal(status,403);assert.equal(seen.length,0);assert.equal(gate.records.length,0);assert.equal(gate.errors[0].code,'OPTIMIZER_CREATION_DISABLED');}finally{await gate.close();await new Promise(r=>upstream.close(r));await rm(dir,{recursive:true});}
});
