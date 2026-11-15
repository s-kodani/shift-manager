import {env,applyD1Migrations,createExecutionContext} from 'cloudflare:test';
import {beforeAll,it,expect} from 'vitest';
import worker from '../../apps/api/src/local-business-recovery-worker';
import {inputFixture} from '../../apps/api/src/input-probes';
const token=crypto.randomUUID()+crypto.randomUUID(),bindings=()=>({...env,ENVIRONMENT:'local',POC_TOKEN:token});
const request=(path:string,body:object,auth='Bearer '+token,url='http://localhost:8787')=>new Request(url+path,{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify(body)});
const createProbe=()=>env.DB.prepare(`CREATE TABLE local_business_check_probe(id TEXT PRIMARY KEY,fixture_id TEXT NOT NULL,lease_id TEXT NOT NULL,phase TEXT NOT NULL,validation_status TEXT,released INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(fixture_id) REFERENCES local_ui_fixture(id))`).run();
beforeAll(async()=>{
 await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS local_ui_fixture(id TEXT PRIMARY KEY,company_id TEXT NOT NULL,expires_at INTEGER NOT NULL,cleaned_at INTEGER)').run();
 await createProbe();
});
it('observing a frozen source without a control table cannot initialize it',async()=>{
 const fixtureId=crypto.randomUUID(),probeId=crypto.randomUUID();
 await env.DB.prepare('INSERT INTO local_ui_fixture VALUES (?,?,?,NULL)').bind(fixtureId,crypto.randomUUID(),Date.now()+60000).run();
 await env.DB.prepare('DROP TABLE local_business_check_probe').run();
 await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN' WHERE id=1").run();
 try{
  for(const path of ['/__local/business-check-state','/__local/business-check-release'])expect((await worker.fetch(request(path,{fixtureId,probeId}),bindings(),createExecutionContext())).status).toBe(404);
  expect(await env.DB.prepare("SELECT name FROM sqlite_schema WHERE name='local_business_check_probe'").first()).toBeNull();
 }finally{
  await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();await createProbe();
 }
});
it('the fault controller rejects remote hosts, non-local environments and missing or wrong bearer tokens before admission',async()=>{
 const body={fixtureId:crypto.randomUUID(),probeId:crypto.randomUUID()},path='/__local/business-check-state';
 for(const [url,auth,mode] of [['https://example.invalid','Bearer '+token,'local'],['http://localhost:8787','Bearer '+token,'poc'],['http://localhost:8787','','local'],['http://localhost:8787','Bearer invalid','local']]){
  const r=await worker.fetch(request(path,body,auth,url),{...bindings(),ENVIRONMENT:mode},createExecutionContext());expect(r.status).toBe(403);
 }
 expect(await env.DB.prepare('SELECT count(*) n FROM maintenance_lease').first('n')).toBe(0);
});
it('a controller cannot read a probe belonging to another fixture or a cleaned/expired fixture',async()=>{
 const ids=[crypto.randomUUID(),crypto.randomUUID()];
 for(const id of ids)await env.DB.prepare('INSERT INTO local_ui_fixture VALUES (?,?,?,NULL)').bind(id,crypto.randomUUID(),Date.now()+60000).run();
 const probeId=crypto.randomUUID(),path='/__local/business-check-state';
 await worker.fetch(request(path,{fixtureId:ids[0],probeId}),bindings(),createExecutionContext());
 await env.DB.prepare('INSERT INTO local_business_check_probe(id,fixture_id,lease_id,phase) VALUES (?,?,?,?)').bind(probeId,ids[0],crypto.randomUUID(),'WAITING_BEFORE_RPC').run();
 expect((await worker.fetch(request(path,{fixtureId:ids[1],probeId}),bindings(),createExecutionContext())).status).toBe(404);
 await env.DB.prepare('UPDATE local_ui_fixture SET expires_at=0 WHERE id=?').bind(ids[0]).run();
 expect((await worker.fetch(request(path,{fixtureId:ids[0],probeId}),bindings(),createExecutionContext())).status).toBe(404);
});
it('a frozen source cannot release even its private timing barrier; explicit reopening permits that control update',async()=>{
 const fixtureId=crypto.randomUUID(),probeId=crypto.randomUUID();
 await env.DB.prepare('INSERT INTO local_ui_fixture VALUES (?,?,?,NULL)').bind(fixtureId,crypto.randomUUID(),Date.now()+60000).run();
 await worker.fetch(request('/__local/business-check-state',{fixtureId,probeId}),bindings(),createExecutionContext());
 await env.DB.prepare('INSERT INTO local_business_check_probe(id,fixture_id,lease_id,phase) VALUES (?,?,?,?)').bind(probeId,fixtureId,crypto.randomUUID(),'WAITING_AFTER_RPC').run();
 await env.DB.prepare("UPDATE maintenance_state SET mode='FROZEN' WHERE id=1").run();
 try{
  const r=await worker.fetch(request('/__local/business-check-release',{fixtureId,probeId}),bindings(),createExecutionContext());expect(await r.json()).toMatchObject({released:0});
 }finally{await env.DB.prepare("UPDATE maintenance_state SET mode='OPEN' WHERE id=1").run();}
 const r=await worker.fetch(request('/__local/business-check-release',{fixtureId,probeId}),bindings(),createExecutionContext());expect(await r.json()).toMatchObject({released:1});
});
it('foreign company and missing snapshot candidates cannot reach checker RPC or leave a business admission behind',async()=>{
 const f=await inputFixture(env.DB,env.INPUTS),fixtureId=crypto.randomUUID();
 await env.DB.prepare('INSERT INTO local_ui_fixture VALUES (?,?,?,NULL)').bind(fixtureId,f.company.companyId,Date.now()+60000).run();
 const candidate={companyId:f.company.companyId,teamId:f.team,userId:f.company.userId,snapshotId:crypto.randomUUID(),assignments:[],locks:[],exceptions:[]};
 const foreign=await worker.fetch(request('/__local/business-check',{fixtureId,probeId:crypto.randomUUID(),phase:'direct',candidate:{...candidate,companyId:crypto.randomUUID()}}),bindings(),createExecutionContext());expect(foreign.status).toBe(403);
 const missing=await worker.fetch(request('/__local/business-check',{fixtureId,probeId:crypto.randomUUID(),phase:'direct',candidate}),bindings(),createExecutionContext());expect(missing.status).toBe(500);
 expect(await env.DB.prepare('SELECT count(*) n FROM maintenance_lease').first('n')).toBe(0);
});
