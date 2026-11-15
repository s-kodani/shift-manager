import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {captureRecoveryAssetManifest,verifyRecoveryAssets} from '../../scripts/final-recovery-assets.mjs';
async function fixture(work){const dir=await realpath(await mkdtemp(tmpdir()+'/shift-recovery-assets-'));try{await mkdir(dir+'/assets');await writeFile(dir+'/index.html','fictional html');await writeFile(dir+'/assets/app.js','fictional javascript');return await work(dir,await captureRecoveryAssetManifest(dir));}finally{await rm(dir,{recursive:true});}}
test('real loopback HTTP bytes and cookies match the sealed source asset manifest',async()=>fixture(async(dir,manifest)=>{
 const routes=[],server=createServer((req,res)=>{routes.push(req.url);assert.equal(req.headers.authorization,'Bearer fictional-poc-token');assert.equal(req.headers.cookie,'fictional-current-staff-cookie');res.end(req.url==='/app'?'fictional html':'fictional javascript');});
 await new Promise(r=>server.listen(0,'localhost',r));try{const records=await verifyRecoveryAssets({manifest,base:'http://localhost:'+server.address().port,token:'fictional-poc-token',cookie:'fictional-current-staff-cookie'});assert.deepEqual(records,manifest.files);assert.deepEqual(routes.sort(),['/app','/app-assets/assets/app.js']);}finally{await new Promise(r=>server.close(r));}
}));
test('status, same-size corruption, oversize and redirected responses cannot pass as restored assets',async()=>fixture(async(_dir,manifest)=>{
 for(const response of [()=>new Response('',{status:503}),()=>new Response('x'.repeat(manifest.files[0].bytes)),()=>new Response('x'.repeat(manifest.files[0].bytes+1)),()=>new Response('',{status:302,headers:{location:'https://foreign.invalid'}})]){
  let calls=0;await assert.rejects(verifyRecoveryAssets({manifest,base:'https://fictional.example.invalid',token:'fictional',request:async()=>{calls++;return response();}}));assert.equal(calls,1);
 }
}));
test('unsafe paths and symlinked source files are rejected before credential-bearing requests',async()=>fixture(async(dir,manifest)=>{
 let calls=0;await assert.rejects(verifyRecoveryAssets({manifest:{files:[{...manifest.files[0],file:'../private'},manifest.files[1]]},base:'https://fictional.example.invalid',token:'fictional',request:async()=>{calls++;throw Error('UNEXPECTED_HTTP');}}));assert.equal(calls,0);
 await symlink(dir+'/index.html',dir+'/assets/alias.js');await assert.rejects(captureRecoveryAssetManifest(dir));
}));
