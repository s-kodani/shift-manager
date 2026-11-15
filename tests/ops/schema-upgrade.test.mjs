import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,rm,mkdtemp,readdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {command,save,sqlCatalog,RETENTION_MS} from '../../scripts/backup-lib.mjs';
import {rehearseSchemaUpgrade,applySchemaUpgrade,verifySchemaUpgrade} from '../../scripts/backup-schema-upgrade.mjs';
import {localRestoreRoot,validateLocalRestoreProfile} from '../../scripts/local-restore-profile.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const generation=`import pathlib,sqlite3,sys
files=sorted(pathlib.Path('infra/migrations').glob('*.sql'));n=int(sys.argv[2]);db=sqlite3.connect(':memory:')
db.executescript('\\n'.join(p.read_text() for p in files[:n]))
db.execute('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
db.executemany('INSERT INTO d1_migrations(id,name,applied_at) VALUES(?,?,?)',[(i+1,p.name,'2026-10-12 00:00:00') for i,p in enumerate(files[:n])])
db.execute("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('fictional-user','架空利用者','upgrade@example.invalid',0,0)")
db.execute("INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES('fictional-account','fictional-user','credential','fictional-user','fictional-test-hash',0,0)")
db.execute("INSERT INTO company(id,name) VALUES('fictional-company','架空企業')")
db.execute("INSERT INTO team(company_id,id,name) VALUES('fictional-company','fictional-team','架空チーム')")
db.execute("INSERT INTO staff(company_id,team_id,id,staff_number,name,user_id) VALUES('fictional-company','fictional-team','fictional-staff','F001','架空スタッフ','fictional-user')")
if n>=34: db.execute("UPDATE staff SET status='inactive'")
db.execute("UPDATE maintenance_state SET mode='FROZEN',revision=2,maintenance_id='00000000-0000-0000-0000-000000000001'")
db.commit();pathlib.Path(sys.argv[1]).write_text('\\n'.join(db.iterdump())+'\\n')
`;
async function source(root,n=27){const file=path.join(root,'database.sql');await command('fictional-schema',['-c',generation,file,String(n)],{python:true});return file;}
test('reviewed 0027–0034 copies reach the current schema while every old application row and restore boundary remain exact',async()=>{
 const root=await mkdtemp(path.resolve('.cache/schema-upgrade-test-'));
 try{for(let n=27;n<=34;n++){
  const s=await source(root,n),before=await sqlCatalog(s),work=path.join(root,String(n)),plan=await rehearseSchemaUpgrade(s,work,'2026-10-13 00:00:00');
  assert.equal(plan.fromVersion,n);assert.equal(plan.toVersion,34);assert.equal(plan.migrations.length,34);
  assert.deepEqual(plan.catalog.maintenance,before.maintenance);assert.deepEqual(plan.catalog.objects,before.objects);
  for(const [table,value]of Object.entries(before.tables))if(table!=='d1_migrations'&&(table!=='staff'||n===34))assert.deepEqual(plan.catalog.tables[table],value,table);
  const staff=JSON.parse(await command('staff-upgrade-check',['-c',`import sqlite3,json,sys
db=sqlite3.connect(':memory:');db.executescript(open(sys.argv[1]).read());print(json.dumps(db.execute('SELECT staff_number,name,status FROM staff').fetchall()))`,path.join(work,'expected.sql')],{python:true}));
  assert.deepEqual(staff,[['F001','架空スタッフ',n===34?'inactive':'active']]);
  assert.equal(plan.catalog.tables.d1_migrations.rows,34);assert.deepEqual(plan.catalog,await sqlCatalog(path.join(work,'expected.sql')));
  assert.equal(plan.bundleSha256,sha(await readFile(path.join(work,'upgrade.sql'))));
  const bundle=await readFile(path.join(work,'upgrade.sql'),'utf8');assert.equal(bundle.includes('ALTER TABLE'),n<34);
 }}finally{await rm(root,{recursive:true});}
});
test('final PoC D1 receipt schema and rows survive no-op recovery; altered schema, extra index and unresolved producer are rejected',async()=>{
 const root=await mkdtemp(path.resolve('.cache/schema-final-probe-test-'));
 try{
  const file=await source(root,34),original=await readFile(file,'utf8');
  const ddl="CREATE TABLE final_d1_probe(id TEXT PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('RUNNING','COMPLETE','FAILED')),results_json TEXT,created_at INTEGER NOT NULL,finished_at INTEGER);";
  const completed=ddl+"INSERT INTO final_d1_probe VALUES('fictional-final-probe','COMPLETE','[]',0,1);";
  await writeFile(file,original+completed);const before=await sqlCatalog(file),plan=await rehearseSchemaUpgrade(file,path.join(root,'valid'),'2026-10-15 00:00:00');
  assert.equal(plan.fromVersion,34);assert.equal(plan.toVersion,34);assert.deepEqual(plan.catalog,before);assert.equal(plan.catalog.tables.final_d1_probe.rows,1);
  for(const [i,extra]of [completed.replace('results_json TEXT','results_json BLOB'),completed+"CREATE INDEX unreviewed_final_index ON final_d1_probe(state);",ddl+"INSERT INTO final_d1_probe VALUES('fictional-running-probe','RUNNING',NULL,0,NULL);"].entries()){
   await writeFile(file,original+extra);await assert.rejects(rehearseSchemaUpgrade(file,path.join(root,'invalid-'+i),'2026-10-15 00:00:00'));
  }
 }finally{await rm(root,{recursive:true});}
});
test('the reviewed staff column addition cannot conceal changed, deleted or deactivated staff or an unreviewed migration',async()=>{
 const root=await mkdtemp(path.resolve('.cache/schema-staff-integrity-test-'));
 try{
  const file=await source(root,33),migrations=path.join(root,'migrations');await mkdir(migrations);
  for(const name of await readdir('infra/migrations'))await copyFile(path.join('infra/migrations',name),path.join(migrations,name));
  const last=path.join(migrations,'0034_staff_lifecycle.sql'),original=await readFile(last,'utf8');
  for(const [i,change]of ["UPDATE staff SET name='changed';","DELETE FROM staff;","UPDATE staff SET status='inactive';"].entries()){
   await writeFile(last,original+'\n'+change);
   await assert.rejects(command('staff-integrity',['scripts/backup-schema-upgrade.py',file,migrations,path.join(root,`bundle-${i}.sql`),path.join(root,`expected-${i}.sql`),'2026-11-14 00:00:00'],{python:true}));
  }
  await writeFile(last,original);await writeFile(path.join(migrations,'0035_unreviewed.sql'),'SELECT 1;');
  await assert.rejects(command('unreviewed-migration',['scripts/backup-schema-upgrade.py',file,migrations,path.join(root,'future.sql'),path.join(root,'future-expected.sql'),'2026-11-14 00:00:00'],{python:true}));
 }finally{await rm(root,{recursive:true});}
});
test('unreviewed versions, missing/forged ledger entries, changed constraints and an active maintenance boundary refuse upgrade',async()=>{
 const root=await mkdtemp(path.resolve('.cache/schema-upgrade-test-'));
 try{const s=await source(root),original=await readFile(s,'utf8');let i=0;
  for(const changed of [
   original+"DELETE FROM d1_migrations WHERE id=5;",
   original+"UPDATE d1_migrations SET name='0099_future.sql' WHERE id=27;",
   original+"INSERT INTO d1_migrations VALUES(28,'0028_maintenance_completion.sql','2026-10-12 00:00:00');",
   original.replace("CHECK(length(name) BETWEEN 1 AND 120)","CHECK(length(name) BETWEEN 1 AND 999)"),
   original+"UPDATE maintenance_state SET mode='OPEN';",
   original+"INSERT INTO maintenance_lease VALUES('unfinished','FOREGROUND',0);",
   original+"CREATE TABLE future_business(value TEXT);",
   original+"ATTACH DATABASE ':memory:' AS attacker;",
  ]){await writeFile(s,changed);await assert.rejects(rehearseSchemaUpgrade(s,path.join(root,'bad-'+i++),'2026-10-13 00:00:00'));}
 }finally{await rm(root,{recursive:true});}
});
async function ownedPlan(){
 const id=randomUUID(),dir=path.resolve('.cache/backups',id);await mkdir(path.join(dir,'objects'),{recursive:true,mode:0o700});
 const s=await source(dir),bytes=await readFile(s),catalog=await sqlCatalog(s),at=Date.now();
 const manifest={version:'shift-backup-v1',id,state:'COMPLETE',source:{mode:'local',databaseId:'00000000-0000-0000-0000-000000000000',bucket:'shift-planner-inputs-local'},createdAt:at,completedAt:at,retentionDays:30,expiresAt:at+RETENTION_MS,sql:{sha256:sha(bytes),bytes:bytes.length},catalog};await save(path.join(dir,'manifest.json'),manifest);
 const rid=randomUUID(),root=localRestoreRoot(rid),name='shift-planner-restore-'+rid.replaceAll('-','').slice(0,12);await mkdir(root,{recursive:true,mode:0o700});
 const p={kind:'owned-fictional-local-restore-rehearsal',mode:'local',rehearsalId:rid,databaseName:name,databaseId:randomUUID(),bucket:name,configFile:path.join(root,'app.jsonc')},profile=path.join(root,'profile.json');
 await save(profile,p);await save(p.configFile,{name,vars:{ENVIRONMENT:'local',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',RECOVERY_SECURITY_ID:rid},d1_databases:[{binding:'DB',database_id:p.databaseId,database_name:name,migrations_dir:path.resolve('infra/migrations')}],r2_buckets:[{binding:'INPUTS',bucket_name:name}]});
 const {targetIdentity}=await validateLocalRestoreProfile(manifest,profile,p);await save(path.join(dir,'restore-'+rid+'.json'),{rehearsalId:rid,backupId:id,databaseId:p.databaseId,bucket:name,stage:'COMPLETE',objects:0,targetIdentity});
 const work=path.join(dir,'schema-upgrade-'+rid),plan=await rehearseSchemaUpgrade(s,work,'2026-10-13 00:00:00'),file=path.join(dir,'schema-upgrade-'+rid+'.json'),owner={version:'restore-schema-upgrade-v1',backupId:id,backupSqlSha256:manifest.sql.sha256,rehearsalId:rid,databaseId:p.databaseId,bucket:name,targetIdentity,stage:'PREPARED',plan};await save(file,owner);
 return {id,dir,root,profile,p,work,owner,file,cleanup:async()=>{await rm(dir,{recursive:true});await rm(root,{recursive:true});}};
}
test('an unknown migration is never resent, and a live producer cannot be converted to a verified receipt',async()=>{
 const f=await ownedPlan();try{
  for(const stage of ['DISPATCHED','UNCERTAIN','APPLIED','VERIFIED']){
   await save(f.file,{...f.owner,stage,producerPid:process.pid});
   await assert.rejects(applySchemaUpgrade(f.id,f.profile),/INSPECT_SAME_TARGET/);
  }
  await save(f.file,{...f.owner,stage:'DISPATCHED',producerPid:process.pid});await assert.rejects(verifySchemaUpgrade(f.id,f.profile),/PRODUCER_STILL_LIVE/);
 }finally{await f.cleanup();}
});
test('edited migration SQL, expectation bytes or receipt catalogs cannot authorize migration or pre-auth proof',async()=>{
 const f=await ownedPlan();try{
  const bundle=path.join(f.work,'upgrade.sql'),b=await readFile(bundle);await writeFile(bundle,Buffer.concat([b,Buffer.from('\nSELECT 1;')]));await assert.rejects(applySchemaUpgrade(f.id,f.profile),/BUNDLE_CHANGED/);await writeFile(bundle,b);
  const expected=path.join(f.work,'expected.sql'),e=await readFile(expected);await writeFile(expected,Buffer.concat([e,Buffer.from('\nSELECT 1;')]));await assert.rejects(applySchemaUpgrade(f.id,f.profile),/EXPECTATION_CHANGED/);await writeFile(expected,e);
  const owner=structuredClone(f.owner);owner.plan.catalog.tables.account.sha256='0'.repeat(64);await save(f.file,owner);await assert.rejects(applySchemaUpgrade(f.id,f.profile),/PLAN_CHANGED/);
  await save(f.file,{...f.owner,targetIdentity:{...f.owner.targetIdentity,configSha256:'0'.repeat(64)}});await assert.rejects(applySchemaUpgrade(f.id,f.profile),/TARGET_CHANGED/);
 }finally{await f.cleanup();}
});
