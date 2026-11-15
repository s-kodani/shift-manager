// Experimental local HTTP bridge, preserving the original URL and real Worker.
// It avoids Wrangler's separate ProxyWorker hop. No retry or production use.
import {unstable_startWorker} from 'wrangler';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import assert from 'node:assert/strict';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {assertLocalDirectConfig,assertLocalRecoveryDirectConfig,assertLocalFinalRecoveryDirectConfig,DIRECT_WRANGLER_VERSION} from './local-direct-config.mjs';
const [config,persist,portText,flag]=process.argv.slice(2),port=Number(portText);
assert(process.argv.length===5||(process.argv.length===6&&['--bounded-sdk','--final-acceptance','--recovery','--recovery-sdk','--restore-browser','--final-recovery','--final-recovery-readonly-sdk'].includes(flag)),'LOCAL_DIRECT_USAGE');
assert(config&&persist&&Number.isInteger(port)&&port>1024&&port<65536);
const version=JSON.parse(await readFile(new URL('../node_modules/wrangler/package.json',import.meta.url))).version;
assert.equal(version,DIRECT_WRANGLER_VERSION,'LOCAL_DIRECT_WRANGLER_CHANGED_REVALIDATE');
const cfg=JSON.parse(await readFile(config));
const options=['--final-recovery','--final-recovery-readonly-sdk'].includes(flag)?assertLocalFinalRecoveryDirectConfig(cfg,{config,port,appConfig:path.basename(config)==='operator.jsonc'?JSON.parse(await readFile(path.join(path.dirname(config),'app.jsonc'))):undefined}):['--recovery','--recovery-sdk','--restore-browser','--final-recovery','--final-recovery-readonly-sdk'].includes(flag)?assertLocalRecoveryDirectConfig(cfg,{config,port,enableContainers:flag==='--recovery-sdk'||flag==='--restore-browser',browserRestore:flag==='--restore-browser',appConfig:path.basename(config)==='operator.jsonc'?JSON.parse(await readFile(path.join(path.dirname(config),'app.jsonc'))):undefined}):assertLocalDirectConfig(cfg,{config,port,bounded:['--bounded-sdk','--final-acceptance'].includes(flag),finalAcceptance:flag==='--final-acceptance'});
if(flag==='--final-recovery-readonly-sdk'){assert.equal(port,8789);assert.equal(path.dirname(path.resolve(config)),path.resolve('.cache/local-restores',path.basename(path.dirname(config))));options.enableContainers=true;options.containerEngine='unix:///tmp/shift-restore-'+path.basename(path.dirname(config))+'.sock';}
assert.equal(await realpath(options.root),options.root,'LOCAL_ROOT_SYMLINK');
assert.equal(path.resolve(persist),options.persist??path.join(options.root,'state'),'LOCAL_PERSIST_OUTSIDE_OWNER');
const worker=await unstable_startWorker({config,dev:{remote:false,server:{hostname:'127.0.0.1',port:0},persist,registry:options.registry,watch:false,inspector:false,enableContainers:options.enableContainers,containerBuildId:randomBytes(8).toString('hex'),containerEngine:options.containerEngine,logLevel:'error'}});
await worker.ready;
// worker.ready denotes the proxy listener, not completion of the user bundle.
let runtime;const readyUntil=Date.now()+30000;
while(Date.now()<readyUntil){runtime=worker.raw.runtimes.find(r=>r.mf);if(runtime)break;await new Promise(r=>setTimeout(r,50));}
if(!runtime?.mf){await worker.dispose();throw Error('LOCAL_USER_WORKER_MISSING');}
await runtime.mf.ready;
const pending=new Set();
const server=http.createServer((req,res)=>{
 const task=(async()=>{
  // Bind and route only the configured loopback origin.
  assert.equal(req.headers.host,'localhost:'+port,'LOCAL_HOST_REQUIRED');
  const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined&&!['connection','keep-alive','transfer-encoding','upgrade'].includes(key)){for(const v of Array.isArray(value)?value:[value])headers.append(key,v);}
  let length=0;const chunks=[];for await(const b of req){length+=b.length;assert(length<=16*1024**2,'LOCAL_BODY_LIMIT');chunks.push(b);}
  const body=['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks);
  const response=await runtime.mf.dispatchFetch('http://localhost:'+port+req.url,{method:req.method,headers,body,redirect:'manual'});
  res.statusCode=response.status;
  for(const [key,value] of response.headers)if(!['set-cookie','connection','transfer-encoding'].includes(key))res.setHeader(key,value);
  const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);
  if(response.body)await new Promise((resolve,reject)=>{const stream=Readable.fromWeb(response.body);stream.on('error',reject);res.on('finish',resolve);res.on('close',resolve);stream.pipe(res);});else res.end();
 })().catch(()=>{if(!res.headersSent){res.statusCode=502;res.end('LOCAL_BRIDGE_FAILED');}else res.destroy();}).finally(()=>pending.delete(task));pending.add(task);
});
server.keepAliveTimeout=0;
server.on('upgrade',(_req,socket)=>socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'));
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
console.log(JSON.stringify({ready:true,route:'local-user-worker-direct',port}));
let ending=false;async function finish(){if(ending)return;ending=true;server.close();await Promise.allSettled([...pending]);server.closeAllConnections();await worker.dispose();}
process.once('SIGTERM',()=>void finish());process.once('SIGINT',()=>void finish());
