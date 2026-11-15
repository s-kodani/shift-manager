import {targetFetch} from './deployment-target.mjs';
// Byte-level static asset comparison; no business mutation or solver dispatch.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
function files(manifest){
 assert(Array.isArray(manifest?.files)&&manifest.files.length>1&&manifest.files.length<=1000);assert.equal(new Set(manifest.files.map(f=>f.file)).size,manifest.files.length);assert(manifest.files.some(f=>f.file==='index.html'));
 let total=0;for(const f of manifest.files){assert(f.file==='index.html'||/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(f.file));assert(Number.isSafeInteger(f.bytes)&&f.bytes>0);assert.match(f.sha256,/^[a-f0-9]{64}$/);total+=f.bytes;}assert(total<=128_000_000);return manifest.files;
}
export async function captureRecoveryAssetManifest(arg){
 const dir=path.resolve(arg);assert.equal(await realpath(dir),dir);const records=[];let total=0;
 async function visit(relative){for(const name of (await readdir(path.join(dir,relative))).sort()){
  const rel=path.join(relative,name),file=path.join(dir,rel),s=await lstat(file);assert(!s.isSymbolicLink());
  if(s.isDirectory())await visit(rel);else{assert(s.isFile()&&s.nlink===1);assert(rel==='index.html'||/^assets\/[A-Za-z0-9_.-]+\.(js|css)$/.test(rel));total+=s.size;assert(total<=128_000_000);const raw=await readFile(file);assert.equal(raw.length,s.size);records.push({file:rel,bytes:raw.length,sha256:sha(raw)});}
 }}await visit('');const manifest={schema:'final-recovery-assets-v1',files:records};files(manifest);return manifest;
}
export async function verifyRecoveryAssets({manifest,base,token,cookie='',request=targetFetch}){
 const expected=files(manifest),origin=new URL(base);assert.equal(origin.origin,base);assert(origin.protocol==='https:'||(origin.protocol==='http:'&&origin.hostname==='localhost'));const records=[];
 for(const f of expected){
  const route=f.file==='index.html'?'/app':'/app-assets/'+f.file,response=await request(base+route,{headers:{authorization:'Bearer '+token,cookie},redirect:'error',signal:AbortSignal.timeout(30000)});
  if(response.status!==200){await response.body?.cancel();throw Error('FINAL_RECOVERY_ASSET_STATUS_UNCONFIRMED');}
  const reader=response.body?.getReader();assert(reader);const chunks=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>f.bytes){await reader.cancel();throw Error('FINAL_RECOVERY_ASSET_SIZE_CHANGED');}chunks.push(value);}
  const raw=Buffer.concat(chunks);assert.equal(raw.length,f.bytes,'FINAL_RECOVERY_ASSET_SIZE_CHANGED');assert.equal(sha(raw),f.sha256,'FINAL_RECOVERY_ASSET_SHA_CHANGED');records.push({file:f.file,bytes:raw.length,sha256:sha(raw)});
 }return records;
}
