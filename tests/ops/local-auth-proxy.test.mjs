import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {patchLocalProxy,PROXY_VERSION,PROXY_SHA} from '../../scripts/local-auth-proxy-candidate.mjs';
import {createHash} from 'node:crypto';
const source=await readFile('node_modules/wrangler/wrangler-dist/ProxyWorker.js','utf8');
test('isolated proxy candidate refuses an unreviewed dependency or source',()=>{
 assert.equal(createHash('sha256').update(source).digest('hex'),PROXY_SHA);
 assert.throws(()=>patchLocalProxy(source,'4.150.0'),/LOCAL_PROXY_VERSION_CHANGED/);
 assert.throws(()=>patchLocalProxy(source+'\n',PROXY_VERSION),/LOCAL_PROXY_SOURCE_CHANGED/);
});
test('only internal HTTP loopback connections close; forwarding and retry code stay intact',()=>{
 const patched=patchLocalProxy(source,PROXY_VERSION);
 const start=patched.indexOf('      // Project local diagnostic:');
 const end=patched.indexOf('      const attemptUserWorkerFetch',start);
 const added=patched.slice(start,end);
 assert.equal(patched.slice(0,start)+patched.slice(end),source);
 for(const url of ['http://localhost:8787/x','http://127.0.0.1:9988/x','http://[::1]:9988/x','https://localhost/x','http://example.com/x','https://example.com/x']){
  const headers=new Headers({authorization:'Bearer fictitious-test',cookie:'fictitious=test'});
  vm.runInNewContext(added,{headers,userWorkerUrl:new URL(url)});
  assert.equal(headers.get('connection'),url.startsWith('http:')&&new URL(url).hostname!=='example.com'?'close':null);
  assert.equal(headers.get('authorization'),'Bearer fictitious-test');assert.equal(headers.get('cookie'),'fictitious=test');
 }
});
