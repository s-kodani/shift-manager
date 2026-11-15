import{fixture}from'./fixtures.mjs';
import{test}from'node:test';
import assert from'node:assert/strict';
import{readFile,writeFile,mkdir,rm,access,symlink}from'node:fs/promises';
import{createHash,randomUUID}from'node:crypto';
import path from'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import{sqlCatalog,prepareImport,verifyBackup,restoreBackup,pruneBackups,RETENTION_MS,save,assertFrozenMaintenance,command,startBackup}from'../../scripts/backup-lib.mjs';

test('a pre-recorded backup ID cannot replace an existing owner or create a new remote export',async()=>{
 const id=randomUUID(),dir=path.resolve('.cache/backups',id);await mkdir(dir,{recursive:true,mode:0o700});await writeFile(dir+'/operation.json','fictional existing owner');
 try{await assert.rejects(startBackup(true,{id}),e=>e.code==='EEXIST');assert.equal(await readFile(dir+'/operation.json','utf8'),'fictional existing owner');await assert.rejects(startBackup(true,{id:'invalid'}),/INVALID_BACKUP_ID/);}finally{await rm(dir,{recursive:true});}
});

test('maintenance-aware catalogs require a frozen drained restore point; legacy catalogs retain their shape',async()=>{
 const id=randomUUID(),extra=`CREATE TABLE maintenance_state(id INTEGER,mode TEXT,revision INTEGER,maintenance_id TEXT);CREATE TABLE maintenance_lease(id TEXT);INSERT INTO maintenance_state VALUES(1,'FROZEN',2,'${id}');`;
 const f=await fixture(extra);try{
  assert.deepEqual(f.manifest.catalog.maintenance,{mode:'FROZEN',revision:2,maintenanceId:id,activeLeases:0,activeRevalidations:0});assertFrozenMaintenance(f.manifest.catalog.maintenance);await verifyBackup(f.id);
  for(const value of [{...f.manifest.catalog.maintenance,mode:'DRAINING'},{...f.manifest.catalog.maintenance,activeLeases:1},{...f.manifest.catalog.maintenance,activeRevalidations:1}])assert.throws(()=>assertFrozenMaintenance(value));
 }finally{await rm(f.dir,{recursive:true,force:true});}
 const legacy=await fixture();try{assert.equal('maintenance' in legacy.manifest.catalog,false);await verifyBackup(legacy.id);}finally{await rm(legacy.dir,{recursive:true,force:true});}
 const open=await fixture(extra.replace("'FROZEN'","'OPEN'"));try{await assert.rejects(verifyBackup(open.id),/MAINTENANCE_NOT_FROZEN/);}finally{await rm(open.dir,{recursive:true,force:true});}
});

const sha=b=>createHash('sha256').update(b).digest('hex');
const exists=p=>access(p).then(()=>true,()=>false);
test('recovery catalog and verified package preserve stored gzip bytes and digest without expansion',async()=>{
 const raw=Buffer.from(JSON.stringify({fictional:true,assignments:['fictional'.repeat(1_000_000)]})),body=gzipSync(raw),f=await fixture('',{body});
 try{const verified=await verifyBackup(f.id);assert(verified);const saved=await readFile(path.join(f.dir,'objects',sha(body)+'.json'));assert.deepEqual(saved,body);assert.deepEqual(gunzipSync(saved),raw);assert.equal(f.manifest.catalog.objects[0].bytes,body.length);}
 finally{await rm(f.dir,{recursive:true});}
});
test('complete package verifies every referenced object; SQL and body tampering fail',async()=>{
  const f=await fixture();try{
    await verifyBackup(f.id);
    await writeFile(path.join(f.dir,'database.sql'),f.sql+'SELECT 1;');await assert.rejects(verifyBackup(f.id));
    await writeFile(path.join(f.dir,'database.sql'),f.sql);const object=path.join(f.dir,'objects',sha(f.body)+'.json');await rm(object);await assert.rejects(verifyBackup(f.id));
    await writeFile(object,Buffer.alloc(f.body.length));await assert.rejects(verifyBackup(f.id),/BACKUP_OBJECT_HASH/);
    await writeFile(object,f.body);await verifyBackup(f.id);
  }finally{await rm(f.dir,{recursive:true});}
});
test('an exported live compute or revalidation cannot become an accepted restore point',async()=>{
  for(const sql of ["INSERT INTO compute_job(state) VALUES('RUNNING');","INSERT INTO compute_job(state) VALUES('QUEUED');","INSERT INTO compute_job(state) VALUES('CANCELLING');","INSERT INTO publication_revalidation_request(state) VALUES('RUNNING');"]){
    const f=await fixture(sql);try{await assert.rejects(verifyBackup(f.id),/ACTIVE_/);}finally{await rm(f.dir,{recursive:true});}
  }
});
test('unknown R2 reference tables, conflicting hashes and foreign key damage fail catalog',async()=>{
  const f=await fixture();try{
    for(const extra of ["CREATE TABLE future_storage(object_key TEXT);",`INSERT INTO schedule_draft_version VALUES('fictional/object','${'0'.repeat(64)}',1);`,"CREATE TABLE parent(id TEXT PRIMARY KEY);CREATE TABLE child(id TEXT REFERENCES parent(id));INSERT INTO child VALUES('missing');"]){
      await writeFile(path.join(f.dir,'database.sql'),f.sql+extra);await assert.rejects(sqlCatalog(path.join(f.dir,'database.sql')));
    }
  }finally{await rm(f.dir,{recursive:true});}
});
test('modified SQL cannot attach a database or load extensions; unsupported blobs fail closed',async()=>{
  const f=await fixture();try{
    for(const extra of ["ATTACH DATABASE ':memory:' AS attacker;","SELECT load_extension('untrusted');","CREATE TABLE unexpected_blob(value BLOB);INSERT INTO unexpected_blob VALUES(x'0001');"]){await writeFile(path.join(f.dir,'database.sql'),f.sql+extra);await assert.rejects(sqlCatalog(path.join(f.dir,'database.sql')));}
  }finally{await rm(f.dir,{recursive:true});}
});
test('restoration rejects the source PoC and mismatched target identity before any remote dispatch',async()=>{
  const f=await fixture(),rid=randomUUID(),name='shift-planner-restore-'+rid.replaceAll('-','').slice(0,12),profile=path.join(f.dir,'profile.json');
  try{
    const p={kind:'owned-fictional-restore-rehearsal',rehearsalId:rid,databaseName:name,bucket:name,databaseId:'11111111-2222-4333-8444-555555555555',configFile:path.join(f.dir,'config.json')};await save(profile,p);await assert.rejects(restoreBackup(f.id,profile));
    p.databaseId=randomUUID();await save(profile,p);await save(p.configFile,{account_id:"11111111111111111111111111111111",d1_databases:[{binding:"DB",database_id:randomUUID(),database_name:name}],r2_buckets:[{binding:"INPUTS",bucket_name:name}]});await assert.rejects(restoreBackup(f.id,profile));
    await save(p.configFile,{account_id:'11111111111111111111111111111111',d1_databases:[{binding:'DECOY',database_id:p.databaseId,database_name:name},{binding:'DB',database_id:'11111111-2222-4333-8444-555555555555',database_name:'shift-manager-example'}],r2_buckets:[{binding:'INPUTS',bucket_name:name}]});await assert.rejects(restoreBackup(f.id,profile),/AMBIGUOUS_TARGET_DATABASE/);
    assert.equal(await exists(path.join(f.dir,'restore-'+rid+'.json')),false);
  }finally{await rm(f.dir,{recursive:true});}
});
test('30-day pruning preserves newer and incomplete packages and never touches source data',async()=>{
  const root=path.resolve('.cache/backup-pruning-tests',randomUUID()),f=await fixture('',{root}),incomplete=randomUUID(),incompleteDir=path.join(root,incomplete),source=path.resolve('.cache/backup-test-source-'+randomUUID());
  await mkdir(incompleteDir);await writeFile(path.join(incompleteDir,'operation.json'),'{"stage":"IMPORT_DISPATCHED"}');await writeFile(source,'fictional source must survive');
  try{
    await pruneBackups(f.manifest.expiresAt-1,{root});assert(await exists(f.dir));
    const r=await pruneBackups(f.manifest.expiresAt,{root});assert.equal(r.retentionDays,30);assert.equal(await exists(f.dir),false);assert(await exists(incompleteDir));assert.equal(await readFile(source,'utf8'),'fictional source must survive');
  }finally{await rm(root,{recursive:true,force:true});await rm(source);}
});

test('import preparation keeps quoted semicolons, triggers and later unique foreign-key targets',async()=>{
  const f=await fixture(`CREATE TABLE child(parent_id TEXT REFERENCES parent(id));INSERT INTO child VALUES('p;quoted');CREATE TABLE parent(id TEXT);INSERT INTO parent VALUES('p;quoted');CREATE UNIQUE INDEX parent_id ON parent(id);CREATE TRIGGER immutable_child BEFORE UPDATE ON child BEGIN SELECT RAISE(ABORT,'immutable;child');END;`);
  try{const target=path.join(f.dir,'prepared.sql');await prepareImport(path.join(f.dir,'database.sql'),target);assert.deepEqual(await sqlCatalog(target),f.manifest.catalog);const sql=await readFile(target,'utf8');assert(sql.indexOf('CREATE UNIQUE INDEX parent_id')<sql.indexOf('INSERT INTO child'));}
  finally{await rm(f.dir,{recursive:true});}
});
test('import preparation preserves cancellation effective-head and combined-notice views',async()=>{
 const f=await fixture(`CREATE TABLE publication(id TEXT PRIMARY KEY);CREATE TABLE cancellation(original_id TEXT REFERENCES publication(id),effective_id TEXT REFERENCES publication(id));INSERT INTO publication VALUES('original'),('cancelled');INSERT INTO cancellation VALUES('original','cancelled');CREATE VIEW effective_head AS SELECT coalesce(c.effective_id,p.id) AS id FROM publication p LEFT JOIN cancellation c ON c.original_id=p.id;CREATE VIEW combined_notice AS SELECT id FROM publication UNION ALL SELECT effective_id AS id FROM cancellation;CREATE TRIGGER protect_effective BEFORE UPDATE ON cancellation BEGIN SELECT RAISE(ABORT,'immutable');END;`);
 try{const target=path.join(f.dir,'prepared.sql');await prepareImport(path.join(f.dir,'database.sql'),target);assert.deepEqual(await sqlCatalog(target),f.manifest.catalog);}
 finally{await rm(f.dir,{recursive:true});}
});
test('large single-row TEXT and multi-row exports restore under the actual 100KB SQL limit without changing values or triggers',async()=>{
 const value="架空😀,);'\"\n".repeat(18000),escaped=value.replaceAll("'","''");
 const f=await fixture(`CREATE TABLE long_export(id TEXT PRIMARY KEY,value TEXT);INSERT INTO long_export VALUES('large','${escaped}'),('small','semi;quote''comma,');CREATE VIEW long_export_view AS SELECT id,length(value) AS size FROM long_export;CREATE TRIGGER immutable_long BEFORE UPDATE ON long_export BEGIN SELECT RAISE(ABORT,'immutable');END;`);
 try{
  const target=path.join(f.dir,'prepared.sql');await prepareImport(path.join(f.dir,'database.sql'),target);
  assert.deepEqual(await sqlCatalog(target),f.manifest.catalog);
  // Use SQLite's enforced statement limit rather than measuring the helper's
  // own chunks. Includes Unicode, quotes, semicolons, newlines and row commas.
  const result=await command('bounded-sql-test',['-c',`import sqlite3,sys
from pathlib import Path
db=sqlite3.connect(':memory:')
db.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH,100000)
db.execute('PRAGMA foreign_keys=ON')
db.execute('BEGIN')
pending=''
for char in Path(sys.argv[1]).read_text():
 pending+=char
 if char==';' and sqlite3.complete_statement(pending):
  db.execute(pending)
  pending=''
assert not pending.strip()
db.commit()
assert db.execute('SELECT count(*) FROM long_export_view').fetchone()[0]==2
assert not db.execute("SELECT name FROM sqlite_schema WHERE name LIKE '__shift_restore_text_%'").fetchall()
try:
 db.execute("UPDATE long_export SET value='changed'")
except sqlite3.IntegrityError:
 print('LIMIT_AND_IMMUTABILITY_VERIFIED')
else:
 raise AssertionError('IMMUTABILITY_LOST')`,target],{python:true});
  assert.equal(result.trim(),'LIMIT_AND_IMMUTABILITY_VERIFIED');
 }finally{await rm(f.dir,{recursive:true});}
});
test('unknown dispatched import is preserved and refused without another remote request',async()=>{
  const f=await fixture(),rid=randomUUID(),name='shift-planner-restore-'+rid.replaceAll('-','').slice(0,12),profile=path.join(f.dir,'profile.json'),cfg=path.join(f.dir,'config.json'),databaseId=randomUUID();
  try{await save(profile,{kind:'owned-fictional-restore-rehearsal',rehearsalId:rid,databaseName:name,bucket:name,databaseId,configFile:cfg});await save(cfg,{account_id:"11111111111111111111111111111111",d1_databases:[{binding:"DB",database_id:databaseId,database_name:name}],r2_buckets:[{binding:"INPUTS",bucket_name:name}]});const receipt=path.join(f.dir,'restore-'+rid+'.json');await save(receipt,{stage:'IMPORT_DISPATCHED',rehearsalId:rid,objects:0,databaseId,bucket:name,backupId:f.id});const before=await readFile(receipt,'utf8');await assert.rejects(restoreBackup(f.id,profile),/IMPORT_OUTCOME_UNKNOWN/);assert.equal(await readFile(receipt,'utf8'),before);}
  finally{await rm(f.dir,{recursive:true});}
});
test('backup SQL symlinks are rejected before parsing or restoring',async()=>{
  const f=await fixture();try{const source=path.join(f.dir,'original.sql'),file=path.join(f.dir,'database.sql');await writeFile(source,f.sql);await rm(file);await symlink(source,file);await assert.rejects(verifyBackup(f.id),/SYMLINK_BACKUP_SQL/);}
  finally{await rm(f.dir,{recursive:true});}
});
