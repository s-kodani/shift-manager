import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './fixtures.mjs';
import {publishBackup,downloadBackup,packBackup} from '../../scripts/remote-backup.mjs';
import {markerKey,archiveKey,validateMarker} from '../../scripts/remote-backup-contract.mjs';
import {command} from '../../scripts/backup-lib.mjs';
function memoryTransport({loseArchive=false,loseMarker=false,corruptArchive=false}={}){
  const values=new Map(),puts=[];
  return {values,puts,
    async get(key,file,{optional=false}={}){const data=values.get(key);if(!data){if(optional)return false;throw new Error('TEST_MISSING');}await writeFile(file,data);return true;},
    async put(key,file){const data=await readFile(file);puts.push(key);values.set(key,corruptArchive&&key.endsWith('.zip')?Buffer.alloc(data.length):data);
      if(loseArchive&&key.endsWith('.zip')){loseArchive=false;throw new Error('SIMULATED_LOST_ARCHIVE_RESPONSE');}
      if(loseMarker&&key.endsWith('.json')){loseMarker=false;throw new Error('SIMULATED_LOST_MARKER_RESPONSE');}}
  };
}
test('remote publication and download round trip verifies complete SQL and every referenced object',async()=>{
  const f=await fixture('',{fresh:true}),transport=memoryTransport(),root=f.dir+'-download',adoptRoot=root+'-adopt';
  try{
    await publishBackup(f.id,{transport});const marker=validateMarker(JSON.parse(transport.values.get(markerKey(f.id))),{id:f.id});assert.equal(marker.counts.objects,1);
    const report=await downloadBackup(f.id,{transport,adopt:false,downloadRoot:root});assert.equal(report.objects,1);assert.equal(await readFile(path.join(root,f.id,'database.sql'),'utf8'),f.sql);
    await publishBackup(f.id,{transport});assert.equal(transport.puts.length,2,'completion retry must not renew retention with writes');
    await rm(f.dir,{recursive:true});await downloadBackup(f.id,{transport,downloadRoot:adoptRoot});await publishBackup(f.id,{transport});assert.equal(transport.puts.length,2,'recovered copy must keep the exact original archive and marker');
  }finally{await rm(f.dir,{recursive:true});await rm(root,{recursive:true,force:true});await rm(adoptRoot,{recursive:true,force:true});}
});
test('lost archive or marker responses reconcile the same immutable ID without duplicate writes',async()=>{
  for(const stage of ['loseArchive','loseMarker']){
    const f=await fixture('',{fresh:true}),transport=memoryTransport({[stage]:true});
    try{await assert.rejects(publishBackup(f.id,{transport}),/SIMULATED_LOST/);await publishBackup(f.id,{transport});assert.equal(transport.puts.filter(k=>k===archiveKey(f.id)).length,1);assert.equal(transport.puts.filter(k=>k===markerKey(f.id)).length,1);}
    finally{await rm(f.dir,{recursive:true});}
  }
});
test('a corrupt archive never creates a completion marker; a corrupt download preserves existing copy',async()=>{
  const f=await fixture('',{fresh:true}),bad=memoryTransport({corruptArchive:true}),good=memoryTransport(),root=f.dir+'-download';
  try{
    await assert.rejects(publishBackup(f.id,{transport:bad}),/REMOTE_ARCHIVE_HASH/);assert.equal(bad.values.has(markerKey(f.id)),false);
    // Preserve the failed operation rather than silently overwriting corruption.
    await assert.rejects(publishBackup(f.id,{transport:bad}),/REMOTE_ARCHIVE_HASH/);
    await rm(path.join(f.dir,'remote.json'));await publishBackup(f.id,{transport:good});good.values.set(archiveKey(f.id),Buffer.alloc(good.values.get(archiveKey(f.id)).length));
    await assert.rejects(downloadBackup(f.id,{transport:good,downloadRoot:root}),/REMOTE_ARCHIVE_HASH/);assert.equal(await readFile(path.join(f.dir,'database.sql'),'utf8'),f.sql);
  }finally{await rm(f.dir,{recursive:true});await rm(root,{recursive:true,force:true});}
});
test('archive extraction refuses unexpected paths, duplicate entries and symlinks',async()=>{
  const f=await fixture('',{fresh:true});
  try{
    await packBackup(f.id);
    for(const kind of ['traversal','duplicate','symlink']){
      const file=path.join(f.dir,kind+'.zip'),target=path.join(f.dir,kind+'-unpacked');
      await command('test-malformed-zip',['-c',`import zipfile,sys,stat; src,out,kind=sys.argv[1:]; a=zipfile.ZipFile(src); z=zipfile.ZipFile(out,'w'); [(z.writestr(i,a.read(i))) for i in a.infolist() if kind!='symlink' or i.filename!='database.sql']; info=zipfile.ZipInfo('database.sql' if kind!='traversal' else '../escaped'); info.external_attr=(stat.S_IFLNK|0o777)<<16 if kind=='symlink' else 0; z.writestr(info,'untrusted'); z.close()`,path.join(f.dir,'archive.zip'),file,kind],{python:true});
      await assert.rejects(command('reject-malformed-zip',['scripts/backup-archive.py','unpack',file,target],{python:true}));
      await assert.rejects(access(path.join(f.dir,'escaped')));
    }
  }finally{await rm(f.dir,{recursive:true});}
});
test('remote markers reject expired copies, identity substitution and late TTL renewal',async()=>{
  const f=await fixture('',{fresh:true}),transport=memoryTransport();
  try{await publishBackup(f.id,{transport});const marker=JSON.parse(transport.values.get(markerKey(f.id)));validateMarker(marker,{now:marker.expiresAt-1});assert.throws(()=>validateMarker(marker,{now:marker.expiresAt}));
    for(const changed of [{...marker,id:'not-a-uuid'},{...marker,id:[marker.id]},{...marker,sqlSha256:[marker.sqlSha256]},{...marker,archive:{...marker.archive,bytes:300*1024*1024+1}},{...marker,bucket:'original-source-bucket'},{...marker,expiresAt:marker.expiresAt+1},{...marker,source:{...marker.source,databaseId:'different-database'}}])assert.throws(()=>validateMarker(changed));
  }finally{await rm(f.dir,{recursive:true});}
});
