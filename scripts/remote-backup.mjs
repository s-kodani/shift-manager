import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,mkdir,chmod,stat,rename,access,copyFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {command,verifyBackup,save} from './backup-lib.mjs';
import {BACKUP_BUCKET,MAX_ARCHIVE_BYTES,archiveKey,markerKey,validateMarker} from './remote-backup-contract.mjs';

export async function hashFile(file){const hash=createHash('sha256');for await(const data of createReadStream(file))hash.update(data);return hash.digest('hex');}
const flags=['--remote','--config','infra/backup-monitor.jsonc'];
export const wranglerTransport={
  async get(key,file,{optional=false}={}){
    try{await command('remote-backup-get',['r2','object','get',BACKUP_BUCKET+'/'+key,...flags,'--file',file]);await chmod(file,0o600);return true;}
    catch(e){if(optional&&e.kind==='OBJECT_NOT_FOUND')return false;throw e;}
  },
  async put(key,file,type){await command('remote-backup-put',['r2','object','put',BACKUP_BUCKET+'/'+key,...flags,'--file',file,'--content-type',type,'--cache-control','private, no-store']);},
};
async function archiveMatches(file,expected){assert.equal((await stat(file)).size,expected.bytes,'REMOTE_ARCHIVE_SIZE');assert.equal(await hashFile(file),expected.sha256,'REMOTE_ARCHIVE_HASH');}
export async function packBackup(id){
  const {dir,manifest}=await verifyBackup(id),file=path.join(dir,'archive.zip');
  let existing=true;try{await access(file);}catch(e){if(e.code!=='ENOENT')throw e;existing=false;}
  if(existing){
    const root=path.join(dir,'pack-check-'+randomUUID());await mkdir(root,{mode:0o700});
    const before=await hashFile(file);await command('check-packed-backup',['scripts/backup-archive.py','unpack',file,path.join(root,id)],{python:true});
    assert.deepEqual((await verifyBackup(id,{root})).manifest,manifest);assert.equal(await hashFile(file),before,'ARCHIVE_CHANGED_DURING_VERIFICATION');
  }else await command('pack-backup',['scripts/backup-archive.py','pack',dir,file],{python:true});
  assert((await stat(file)).size<=MAX_ARCHIVE_BYTES,'REMOTE_ARCHIVE_TOO_LARGE');return {dir,manifest,file};
}
export async function publishBackup(id,{transport=wranglerTransport,now=Date.now()}={}){
  const {dir,manifest}=await verifyBackup(id);assert(manifest.expiresAt>now,'BACKUP_ALREADY_EXPIRED');
  const receipt=path.join(dir,'remote.json');let op;
  try{op=JSON.parse(await readFile(receipt,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!op){
    const {file}=await packBackup(id);
    const marker={version:'shift-remote-backup-v1',id,bucket:BACKUP_BUCKET,source:{mode:manifest.source.mode,databaseId:manifest.source.databaseId,bucket:manifest.source.bucket},createdAt:manifest.createdAt,completedAt:manifest.completedAt,publishedAt:now,expiresAt:manifest.expiresAt,sqlSha256:manifest.sql.sha256,manifestSha256:await hashFile(path.join(dir,'manifest.json')),archive:{sha256:await hashFile(file),bytes:(await stat(file)).size},counts:{tables:Object.keys(manifest.catalog.tables).length,objects:manifest.catalog.objects.length}};
    validateMarker(marker,{id,now});op={id,bucket:BACKUP_BUCKET,stage:'PACKED',marker};await save(receipt,op);
  }
  assert.equal(op.id,id);assert.equal(op.bucket,BACKUP_BUCKET);const marker=validateMarker(op.marker,{id,now});
  assert.equal(marker.manifestSha256,await hashFile(path.join(dir,'manifest.json')),'BACKUP_CHANGED_DURING_PUBLICATION');await archiveMatches(path.join(dir,'archive.zip'),marker.archive);
  assert(['PACKED','ARCHIVE_DISPATCHED','ARCHIVE_VERIFIED','MARKER_DISPATCHED','COMPLETE'].includes(op.stage));
  const archiveReadback=path.join(dir,'archive-readback.zip'),markerFile=path.join(dir,'remote-marker.json');
  if(['PACKED','ARCHIVE_DISPATCHED'].includes(op.stage)){
    const exists=await transport.get(archiveKey(id),archiveReadback,{optional:true});
    if(!exists){op.stage='ARCHIVE_DISPATCHED';await save(receipt,op);await transport.put(archiveKey(id),path.join(dir,'archive.zip'),'application/zip');await transport.get(archiveKey(id),archiveReadback);}
    await archiveMatches(archiveReadback,marker.archive);op.stage='ARCHIVE_VERIFIED';await save(receipt,op);
  }
  if(op.stage==='ARCHIVE_VERIFIED'){
    // Completion is advertised only after the complete archive is read back.
    op.stage='MARKER_DISPATCHED';await save(receipt,op);await save(markerFile,marker);await transport.put(markerKey(id),markerFile,'application/json');
  }
  if(['MARKER_DISPATCHED','COMPLETE'].includes(op.stage)){
    const found=await transport.get(markerKey(id),markerFile,{optional:true});
    if(!found){assert.equal(op.stage,'MARKER_DISPATCHED','COMMITTED_MARKER_MISSING');await save(markerFile,marker);await transport.put(markerKey(id),markerFile,'application/json');await transport.get(markerKey(id),markerFile);}
    assert.deepEqual(validateMarker(JSON.parse(await readFile(markerFile,'utf8')),{id,now}),marker,'REMOTE_MARKER_CHANGED');
    await transport.get(archiveKey(id),archiveReadback);await archiveMatches(archiveReadback,marker.archive);
    op.stage='COMPLETE';op.verifiedAt=Date.now();await save(receipt,op);
  }
  return {backupId:id,remote:true,bucket:BACKUP_BUCKET,archiveBytes:marker.archive.bytes,objects:marker.counts.objects,expiresAt:marker.expiresAt};
}
export async function downloadBackup(id,{transport=wranglerTransport,now=Date.now(),adopt=true,downloadRoot}={}){
  // A fresh private download root preserves existing local copies on any error.
  const root=downloadRoot??path.resolve('.cache/backup-downloads',randomUUID());await mkdir(path.dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700});await chmod(path.dirname(root),0o700);
  const markerFile=path.join(root,'remote-marker.json');await transport.get(markerKey(id),markerFile);assert((await stat(markerFile)).size<8000);
  const marker=validateMarker(JSON.parse(await readFile(markerFile,'utf8')),{id,now}),archive=path.join(root,'archive.zip');
  await transport.get(archiveKey(id),archive);await archiveMatches(archive,marker.archive);
  await command('unpack-backup',['scripts/backup-archive.py','unpack',archive,path.join(root,id)],{python:true});
  const {dir,manifest}=await verifyBackup(id,{root});assert.equal(await hashFile(path.join(dir,'manifest.json')),marker.manifestSha256);assert.equal(manifest.sql.sha256,marker.sqlSha256);assert.equal(manifest.expiresAt,marker.expiresAt);
  assert.deepEqual({mode:manifest.source.mode,databaseId:manifest.source.databaseId,bucket:manifest.source.bucket},marker.source);assert.equal(Object.keys(manifest.catalog.tables).length,marker.counts.tables);assert.equal(manifest.catalog.objects.length,marker.counts.objects);
  // Preserve the frozen archive and receipt; recovery must not repackage with
  // different ZIP timestamps or renew the original retention on a retry.
  await copyFile(archive,path.join(dir,'archive.zip'));await chmod(path.join(dir,'archive.zip'),0o600);
  await save(path.join(dir,'remote.json'),{id,bucket:BACKUP_BUCKET,stage:'COMPLETE',marker,verifiedAt:Date.now()});
  await save(path.join(dir,'operation.json'),{id,source:manifest.source,createdAt:manifest.createdAt,stage:'COMPLETE'});
  if(adopt){
    const backups=path.resolve('.cache/backups');await mkdir(backups,{recursive:true,mode:0o700});let existing=true;try{await access(path.join(backups,id));}catch(e){if(e.code!=='ENOENT')throw e;existing=false;}
    if(existing){const current=await verifyBackup(id);assert.deepEqual(current.manifest,manifest,'EXISTING_BACKUP_DIFFERS');}
    else await rename(dir,path.join(backups,id));
  }
  return {backupId:id,verified:true,objects:marker.counts.objects,tables:marker.counts.tables,adopted:adopt};
}
