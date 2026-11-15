import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nativeResourceProfile,assertResourceLimits,assertNativeSources} from '../../scripts/native-resource-profile.mjs';

test('an expensive rehearsal cannot silently change size, mode or quota',()=>{
 assert.equal(nativeResourceProfile({}),null);
 for(const env of [{NATIVE_FIXTURE_STAFF:'101'},{NATIVE_RESOURCE_PROFILE:'standard-3'},
  {NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_LARGE_COMPUTE:'1',NATIVE_FIXTURE_STAFF:'1'},
  {NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_LARGE_COMPUTE:'1',NATIVE_HTTP_COMPUTE:'1'}])assert.throws(()=>nativeResourceProfile(env));
});
test('an unlimited container, extra swap or stopped process cannot prove applied limits',()=>{
 const p=nativeResourceProfile({NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_LARGE_COMPUTE:'1',NATIVE_FIXTURE_STAFF:'101'});
 const correct={HostConfig:{NanoCpus:1_000_000_000,Memory:6*1024**3,MemorySwap:6*1024**3},State:{Running:true}};
 assertResourceLimits(p,correct);
 for(const key of ['NanoCpus','Memory','MemorySwap'])assert.throws(()=>assertResourceLimits(p,{...correct,HostConfig:{...correct.HostConfig,[key]:0}}));
 assert.throws(()=>assertResourceLimits(p,{...correct,State:{Running:false}}));
});
test('bounded HTTP acceptance retains the full fixture and rejects mixed or advisory modes',()=>{
 const env={NATIVE_RESOURCE_PROFILE:'standard-2',NATIVE_LARGE_COMPUTE:'1',NATIVE_RESOURCE_SCOPE:'http',NATIVE_HTTP_COMPUTE:'1'};
 const profile=nativeResourceProfile(env);
 assert.equal(profile.scope,'http');assert.equal(profile.staff,500);
 for(const changes of [{NATIVE_HTTP_COMPUTE:'0'},{NATIVE_REGISTERED_COMPUTE:'1'},
  {NATIVE_SAVED_CANDIDATE:'1'},{NATIVE_FIXTURE_STAFF:'101'},{NATIVE_RESOURCE_SCOPE:'prepared-snapshot'},
  {NATIVE_RESOURCE_SCOPE:'unknown'},{NATIVE_RESOURCE_PROFILE:undefined}]){
  assert.throws(()=>nativeResourceProfile({...env,...changes}));
 }
 const registered=nativeResourceProfile({...env,NATIVE_RESOURCE_SCOPE:'registered',NATIVE_HTTP_COMPUTE:'0',NATIVE_REGISTERED_COMPUTE:'1'});
 assert.equal(registered.scope,'registered');assert.equal(registered.staff,500);
});
test('a reused image with missing, extra or stale Python source is rejected',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-source-test-'));
 try{
  await fs.writeFile(root+'/server.py','fictional-source');
  const health={runtime:{uid:65534,hasShell:false},sourceSha256:{'server.py':createHash('sha256').update('fictional-source').digest('hex')}};
  await assertNativeSources(health,root);
  for(const sourceSha256 of [{},{...health.sourceSha256,'unexpected.py':'a'},{'server.py':'stale'}])await assert.rejects(assertNativeSources({...health,sourceSha256},root));
  await assert.rejects(assertNativeSources({...health,runtime:{uid:0,hasShell:false}},root));
 }finally{await fs.rm(root,{recursive:true});}
});
