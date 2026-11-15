import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,rm,chmod} from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {prepareMaintenance,readMaintenance,sendMaintenance,inspectMaintenance,currentMaintenance,listMaintenanceLeases} from '../../scripts/maintenance-client.mjs';
import {maintenanceCommand,maintenanceFingerprint} from '../../scripts/maintenance-contract.mjs';
import {save} from '../../scripts/backup-lib.mjs';
const root=()=>path.resolve('.cache/maintenance-test-'+randomUUID());
test('maintenance CLI rejects arbitrary or malformed URLs before token access without echoing URL credentials',()=>{
 for(const url of ['https://operator:fictional-private@arbitrary.invalid','invalid fictional-private']){
  const r=spawnSync(process.execPath,['scripts/maintenance.mjs','status'],{env:{...process.env,MAINTENANCE_OPERATOR_URL:url},encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(r.stderr.trim(),'MAINTENANCE_OPERATOR_URL_INVALID');assert(!r.stdout.includes('fictional-private'));
 }
});
for(const action of ['reclaim','retire'])test(action+' selection is canonical, bounded and owned across a lost response',async()=>{
 const dir=root();try{
  const ids=[randomUUID(),randomUUID()],maintenanceId=randomUUID();
  const input={action,leaseIds:ids,maintenanceId,expectedRevision:7,reason:'架空終了記録の回収'};
  assert.equal(await maintenanceFingerprint({...input,operationId:maintenanceId}),await maintenanceFingerprint({...input,operationId:maintenanceId,leaseIds:[...ids].reverse()}));
  for(const leaseIds of [[],[ids[0],ids[0]],Array.from({length:41},()=>randomUUID())])assert.throws(()=>maintenanceCommand.parse({...input,operationId:randomUUID(),leaseIds}));
  const p=await prepareMaintenance(dir,input),owner=(await readMaintenance(dir,p.id)).owner;
  assert.deepEqual(owner.payload.leaseIds,[...ids].sort());
  const committed={found:true,id:p.id,principal:'fictional-operator',action,fingerprint:owner.fingerprint,maintenance_id:maintenanceId,mode:'DRAINING',revision:8,reason:input.reason,created_at:Date.now()};
  await assert.rejects(sendMaintenance(dir,p.id,async()=>{throw new Error('fictional response loss');}),/OUTCOME_UNKNOWN/);
  assert.equal((await readMaintenance(dir,p.id)).owner.stage,'UNCERTAIN');
  const result=await inspectMaintenance(dir,p.id,async(route,body)=>{assert.equal(route,'/maintenance/inspect');assert.equal(body.operationId,p.id);return {status:200,body:committed};});
  assert.equal(result.receiptRevision,8);assert.equal(result.receiptMode,'DRAINING');assert.equal((await readMaintenance(dir,p.id)).owner.stage,'COMMITTED');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('lease inventory uses validated cursors and rejects incomplete or sensitive unexpected response fields',async()=>{
 const id=randomUUID(),body={schema:'maintenance-leases-v4',mode:'DRAINING',revision:1,maintenance_id:randomUUID(),leases:[{id,kind:'FOREGROUND',started_at:0,completed_at:null,guard_version:0,resource_guard:0,delivery_guard:0}],nextCursor:null};
 const response=await listMaintenanceLeases(async(route,input)=>{assert.equal(route,'/maintenance/leases');assert.deepEqual(input,{cursor:id});return {status:200,body};},id);assert.equal(response.leases[0].completed_at,null);
 await assert.rejects(listMaintenanceLeases(async()=>assert.fail('must not dispatch'),'invalid'));
 for(const invalid of [{...body,secret:'fictional-private'},{...body,leases:[{id,kind:'FOREGROUND',started_at:0}]},{...body,leases:Array.from({length:51},()=>body.leases[0])}])await assert.rejects(listMaintenanceLeases(async()=>({status:200,body:invalid})));
});
const receipt=owner=>({found:true,id:owner.id,principal:'fictional-operator',action:owner.payload.action,fingerprint:owner.fingerprint,maintenance_id:owner.id,mode:'DRAINING',revision:1,reason:owner.payload.reason,created_at:Date.now()});
test('maintenance loss preserves private ownership; absent inspection and same-ID confirmation never create a new command',async()=>{
 const dir=root();try{
  const p=await prepareMaintenance(dir,{action:'begin',expectedRevision:0,reason:'架空受付停止'}),original=await readMaintenance(dir,p.id);let committed,posts=0;
  const lost=async(route,body)=>{assert.equal(route,'/maintenance/command');assert.deepEqual(body,original.owner.payload);posts++;committed=receipt(original.owner);throw new Error('fictional lost response');};
  await assert.rejects(sendMaintenance(dir,p.id,lost),/MAINTENANCE_OUTCOME_UNKNOWN/);
  assert.equal((await readMaintenance(dir,p.id)).owner.stage,'UNCERTAIN');
  assert.deepEqual(await inspectMaintenance(dir,p.id,async()=>({status:200,body:{found:false}})),{id:p.id,stage:'UNCERTAIN',found:false});
  const r=await sendMaintenance(dir,p.id,async(route,body)=>{posts++;assert.equal(body.operationId,p.id);return {status:200,body:committed};});
  assert.equal(r.receiptMode,'DRAINING');assert.equal(posts,2);assert.equal((await readMaintenance(dir,p.id)).owner.stage,'COMMITTED');
  const after=await sendMaintenance(dir,p.id,async(route)=>{assert.equal(route,'/maintenance/inspect');return {status:200,body:committed};});assert.equal(after.receiptRevision,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('maintenance status is current while a saved command receipt remains historical; mismatched receipt is uncertain',async()=>{
 const dir=root();try{
  const p=await prepareMaintenance(dir,{action:'begin',expectedRevision:0,reason:'架空受付停止'}),owner=(await readMaintenance(dir,p.id)).owner;
  await assert.rejects(sendMaintenance(dir,p.id,async()=>({status:200,body:{...receipt(owner),id:randomUUID()}})),/MAINTENANCE_OUTCOME_UNKNOWN/);
  const status=await currentMaintenance(async()=>({status:200,body:{schema:'maintenance-status-v1',mode:'OPEN',revision:3,maintenance_id:null,last_operation_id:randomUUID(),updated_at:0,activeLeases:0,activeJobs:0,activeRevalidations:0}}));assert.equal(status.mode,'OPEN');
  assert.equal((await readMaintenance(dir,p.id)).owner.stage,'UNCERTAIN');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('maintenance owner tampering, broad file permissions, unexpected fields and invalid revision are rejected before dispatch',async()=>{
 const dir=root();try{
  await mkdir(dir,{mode:0o700});await assert.rejects(prepareMaintenance(dir,{action:'begin',expectedRevision:-1,reason:'架空受付停止'}));
  await assert.rejects(prepareMaintenance(dir,{action:'begin',expectedRevision:0,reason:'架空受付停止',staffData:true}));
  const p=await prepareMaintenance(dir,{action:'freeze',expectedRevision:1,maintenanceId:randomUUID(),reason:'架空終了確認'}),{owner}=await readMaintenance(dir,p.id),file=path.join(dir,p.id,'operation.json');
  await chmod(file,0o644);await assert.rejects(sendMaintenance(dir,p.id,async()=>{assert.fail('must not dispatch');}),/MAINTENANCE_PRIVATE_FILE_REQUIRED/);await chmod(file,0o600);
  owner.payload.reason='異なる理由';await save(file,owner);await assert.rejects(readMaintenance(dir,p.id),/MAINTENANCE_INVALID_OWNER/);
  assert((await readFile(file,'utf8')).includes('異なる理由'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('migration retains historical receipts and classifies legacy leases as unknown',()=>{
 const code=`import sqlite3, pathlib
c=sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
c.executescript(pathlib.Path('infra/migrations/0027_maintenance.sql').read_text())
c.execute("INSERT INTO maintenance_operation VALUES ('old-operation','fictional-operator','begin','old-fingerprint','old-operation','DRAINING',1,'fictional reason',123)")
c.execute("INSERT INTO maintenance_lease VALUES ('legacy-lease','FOREGROUND',0)")
c.executescript(pathlib.Path('infra/migrations/0028_maintenance_completion.sql').read_text())
assert c.execute('SELECT * FROM maintenance_operation').fetchall()==[('old-operation','fictional-operator','begin','old-fingerprint','old-operation','DRAINING',1,'fictional reason',123)]
assert c.execute('SELECT completed_at FROM maintenance_lease').fetchone()==(None,)
for sql in ["UPDATE maintenance_operation SET reason='changed'",'DELETE FROM maintenance_operation']:
 try: c.execute(sql)
 except sqlite3.IntegrityError as e: assert 'IMMUTABLE_MAINTENANCE_OPERATION' in str(e)
 else: raise AssertionError('historical receipt is mutable')
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('historical receipts retained; legacy completion unknown; FK valid')`;
 const result=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert(result.stdout.includes('legacy completion unknown'));
});

test('database retirement migration preserves completed recovery receipts and never upgrades legacy authority',()=>{
 const code=`import sqlite3,pathlib
c=sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for f in ['0027_maintenance.sql','0028_maintenance_completion.sql']: c.executescript(pathlib.Path('infra/migrations',f).read_text())
c.execute("UPDATE maintenance_state SET mode='DRAINING',revision=2,maintenance_id='begin',last_operation_id='reclaim' WHERE id=1")
c.execute("INSERT INTO maintenance_operation VALUES ('reclaim','fictional-operator','reclaim','fingerprint','begin','DRAINING',2,'reason',123)")
c.execute("INSERT INTO maintenance_lease VALUES ('completed','FOREGROUND',0,1)")
c.execute("INSERT INTO maintenance_lease_recovery VALUES ('completed','reclaim','FOREGROUND',0,1)")
c.execute("DELETE FROM maintenance_lease WHERE id='completed'")
c.execute("INSERT INTO maintenance_recovery_commit VALUES ('reclaim',1)")
c.execute("INSERT INTO maintenance_lease VALUES ('unknown','FOREGROUND',0,NULL)")
before={t:c.execute('SELECT * FROM '+t).fetchall() for t in ['maintenance_operation','maintenance_lease_recovery','maintenance_recovery_commit']}
c.executescript(pathlib.Path('infra/migrations/0029_maintenance_database_retirement.sql').read_text())
assert c.execute('SELECT completed_at,guard_version FROM maintenance_lease').fetchall()==[(None,0)]
assert all(c.execute('SELECT * FROM '+t).fetchall()==rows for t,rows in before.items())
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('existing FK receipts retained; legacy guard zero')`;
 const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('legacy guard zero'));
});

test('business authority migration retains SQL-only retirement proof and does not promote legacy or auth leases',()=>{
 const code=`import sqlite3,pathlib
c=sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for f in ['0027_maintenance.sql','0028_maintenance_completion.sql','0029_maintenance_database_retirement.sql']: c.executescript(pathlib.Path('infra/migrations',f).read_text())
c.execute("INSERT INTO maintenance_lease VALUES ('legacy','FOREGROUND',0,NULL,0)")
c.execute("INSERT INTO maintenance_lease VALUES ('auth','FOREGROUND',0,NULL,1)")
c.execute("INSERT INTO maintenance_lease VALUES ('retired','FOREGROUND',0,NULL,1)")
c.execute("UPDATE maintenance_state SET mode='DRAINING',revision=1,maintenance_id='begin',last_operation_id='retire' WHERE id=1")
c.execute("INSERT INTO maintenance_retirement_operation VALUES ('retire','operator','retire','fingerprint','begin','DRAINING',1,'reason',123)")
c.execute("INSERT INTO maintenance_lease_retirement VALUES ('retired','retire','FOREGROUND',0,1,123)")
c.execute("DELETE FROM maintenance_lease WHERE id='retired'")
c.execute("INSERT INTO maintenance_retirement_commit VALUES ('retire',1)")
c.executescript(pathlib.Path('infra/migrations/0031_maintenance_business_authority.sql').read_text())
assert c.execute('SELECT id,guard_version,resource_guard FROM maintenance_lease ORDER BY id').fetchall()==[('auth',1,0),('legacy',0,0)]
assert c.execute('SELECT lease_id,guard_version,retired_at,resource_guard FROM maintenance_lease_retirement').fetchall()==[('retired',1,123,0)]
assert c.execute('SELECT * FROM maintenance_retirement_commit').fetchall()==[('retire',1)]
for sql in ["UPDATE maintenance_lease SET resource_guard=1 WHERE id='auth'","UPDATE maintenance_lease SET resource_guard=1 WHERE id='legacy'"]:
 try:c.execute(sql)
 except sqlite3.IntegrityError as e:assert 'IMMUTABLE_MAINTENANCE_GUARD' in str(e)
 else:raise AssertionError('old authority promoted')
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('historical SQL retirement preserved; old resource scope remains zero')`;
 const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('old resource scope remains zero'));
});
test('delivery migration preserves foreground retirement history and keeps every existing background admission completion-only',()=>{
 const code=`import sqlite3,pathlib
c=sqlite3.connect(':memory:')
c.execute('PRAGMA foreign_keys=ON')
for f in ['0027_maintenance.sql','0028_maintenance_completion.sql','0029_maintenance_database_retirement.sql','0031_maintenance_business_authority.sql']:c.executescript(pathlib.Path('infra/migrations',f).read_text())
c.execute("INSERT INTO maintenance_lease VALUES ('legacy-bg','BACKGROUND',10,NULL,0,0)")
c.execute("INSERT INTO maintenance_lease VALUES ('fg','FOREGROUND',11,NULL,1,1)")
c.execute("UPDATE maintenance_state SET mode='DRAINING',revision=1,maintenance_id='begin',last_operation_id='retire' WHERE id=1")
c.execute("INSERT INTO maintenance_retirement_operation VALUES ('retire','operator','retire','fingerprint','begin','DRAINING',1,'reason',123)")
c.execute("INSERT INTO maintenance_lease_retirement VALUES ('fg','retire','FOREGROUND',11,1,123,1)")
c.execute("DELETE FROM maintenance_lease WHERE id='fg'")
c.execute("INSERT INTO maintenance_retirement_commit VALUES ('retire',1)")
before={t:c.execute('SELECT * FROM '+t).fetchall() for t in ['maintenance_retirement_operation','maintenance_lease_retirement','maintenance_retirement_commit']}
c.executescript(pathlib.Path('infra/migrations/0032_maintenance_delivery_authority.sql').read_text())
assert all(c.execute('SELECT * FROM '+t).fetchall()==rows for t,rows in before.items())
assert c.execute('SELECT id,delivery_guard,completed_at FROM maintenance_lease').fetchall()==[('legacy-bg',0,None)]
try:c.execute("UPDATE maintenance_lease SET delivery_guard=1 WHERE id='legacy-bg'")
except sqlite3.IntegrityError as e:assert 'IMMUTABLE_MAINTENANCE_GUARD' in str(e)
else:raise AssertionError('legacy promoted')
assert not c.execute('PRAGMA foreign_key_check').fetchall()
print('foreground receipts preserved; legacy background remains zero')`;
 const r=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert(r.stdout.includes('legacy background remains zero'));
});
