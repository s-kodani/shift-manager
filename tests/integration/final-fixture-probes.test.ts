import {env,applyD1Migrations} from 'cloudflare:test';
import {beforeAll,expect,it} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
import {prepareFinalFixture,controlFinalFixture} from '../../apps/api/src/final-fixture-probes';
import {createInputSnapshot,readInputSnapshot} from '../../apps/api/src/input-snapshots';
import {createJob,claimJob,cancelJob} from '../../apps/api/src/compute-jobs';
import {authorizeFault} from '../../apps/api/src/compute-faults';
import {inputFixture} from '../../apps/api/src/input-probes';

beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const idle={activeRpc:false,persistedFence:false,persistedCheckFence:false,processRunning:false};
const solver=new Proxy(env.SOLVER,{get(target,key){
 if(key==='getByName')return (name:string)=>new Proxy(target.getByName(name),{get(stub,field){
  if(field==='executionState')return async()=>idle;
  if(field==='releaseIdleProbe')return async()=>({released:true,...idle});
  const value=Reflect.get(stub,field,stub);return typeof value==='function'?value.bind(stub):value;
 }});
 const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
}});
const bindings=()=>({...env,ENVIRONMENT:'poc',MAIL_DELIVERY:'disabled',AI_EXPLANATIONS:'disabled',SOLVER:solver});
const command=()=>({ownerId:crypto.randomUUID(),profile:'single' as const,jobIds:Array.from({length:3},()=>crypto.randomUUID())});
const request=(path:string,body:unknown,headers:Record<string,string>={authorization:`Bearer ${env.POC_TOKEN}`})=>new Request(env.AUTH_BASE_URL+path,{method:'POST',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json',...headers},body:JSON.stringify(body)});

it('final setup stays token/environment protected and refuses invalid ownership without provisioning',async()=>{
 const c=command(),before=await env.DB.prepare('SELECT count(*) FROM company').first<number>('count(*)');
 expect((await worker.fetch(request('/__poc/final-fixture',c,{}),bindings())).status).toBe(403);
 for(const change of [{ENVIRONMENT:'local'},{ENVIRONMENT:'production'},{MAIL_DELIVERY:'resend'},{AI_EXPLANATIONS:'workers-ai'}])
  expect((await worker.fetch(request('/__poc/final-fixture',c),{...bindings(),...change})).status).toBe(403);
 expect((await worker.fetch(request('/__poc/final-fixture',{...c,jobIds:[c.jobIds[0],c.jobIds[0],c.jobIds[2]]}),bindings())).status).toBe(400);
 expect(await env.DB.prepare('SELECT count(*) FROM company').first<number>('count(*)')).toBe(before);
});

it('fixture preparation creates no job and preserves both actual first-password gates, with one owner and no persisted credentials',async()=>{
 const c=command(),response=await worker.fetch(request('/__poc/final-fixture',c),bindings());expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 const f=await response.json<Awaited<ReturnType<typeof prepareFinalFixture>>>();
 expect(await env.DB.prepare('SELECT count(*) FROM compute_job WHERE company_id=?').bind(f.companyId).first<number>('count(*)')).toBe(0);
 expect(await env.DB.prepare('SELECT count(*) FROM access_state a JOIN user u ON u.id=a.user_id WHERE u.email IN (?,?) AND must_change_password=1').bind(f.email,f.staffLogin.email).first<number>('count(*)')).toBe(2);
 const meta=(await env.DB.prepare('SELECT metadata FROM cancellation_probe WHERE id=?').bind(c.ownerId).first<string>('metadata'))!;
 expect(meta.includes(f.password)||meta.includes(f.staffLogin.initialPassword)).toBe(false);
 for(const credential of [{email:f.email,password:f.password},{email:f.staffLogin.email,password:f.staffLogin.initialPassword}]){
  const login=await worker.fetch(request('/api/auth/sign-in/email',credential),bindings());expect(login.status).toBe(200);
  const headers={authorization:`Bearer ${env.POC_TOKEN}`,cookie:login.headers.get('set-cookie')!.split(';')[0]};
  const blocked=await worker.fetch(new Request(env.AUTH_BASE_URL+'/api/context',{headers}),bindings());expect(blocked.status).toBe(403);
  expect((await worker.fetch(request('/api/password',{currentPassword:credential.password,newPassword:crypto.randomUUID()+crypto.randomUUID()},headers),bindings())).status).toBe(200);
 }
 expect((await worker.fetch(request('/__poc/final-fixture',c),bindings())).status).toBe(409);
 expect(await env.DB.prepare('SELECT count(*) FROM company WHERE name=?').bind('架空取消確定検証:'+c.ownerId).first<number>('count(*)')).toBe(1);
 const closed=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'});expect('cleaned' in closed&&closed.cleaned).toBe(true);
 expect('credentials' in closed?closed.credentials:null).toEqual({enabled:0,sessions:0,passwords:0});
 const inspected=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'status'});expect(inspected).toMatchObject({cleaned:true,ownerId:c.ownerId});
});

it('only the declared J2 RUNNING attempt can be armed for an existing normal job, without dispatching another job',async()=>{
 const c=command(),f=await prepareFinalFixture(bindings(),c);
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id IN (SELECT user_id FROM company_admin WHERE company_id=?)').bind(f.companyId).run();
 const admin=(await env.DB.prepare('SELECT user_id FROM company_admin WHERE company_id=?').bind(f.companyId).first<string>('user_id'))!;
 const snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,f.companyId,f.teamId,admin,{operationId:snapshotId,expectedRevision:9,month:f.month});
 await expect(controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'arm-fault'})).rejects.toThrow('FAULT_NOT_ALLOWED');
 const jobId=c.jobIds[1];await createJob(env.DB,env.INPUTS,f.companyId,f.teamId,admin,{operationId:jobId,snapshotId,expectedRevision:9});
 await expect(controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'arm-fault'})).rejects.toThrow('FAULT_NOT_ALLOWED');
 await claimJob(env.DB,{version:1,companyId:f.companyId,teamId:f.teamId,jobId});
 expect(await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'arm-fault'})).toEqual({armed:true,jobId,attempt:1});
 expect(await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'arm-fault'})).toEqual({armed:true,jobId,attempt:1});
 await authorizeFault(env.DB,'poc',{version:1,companyId:f.companyId,teamId:f.teamId,jobId},{operationId:crypto.randomUUID(),probeId:jobId,expectedAttempt:1,mode:'crash'});
 expect(await env.DB.prepare('SELECT count(*) FROM compute_job WHERE company_id=?').bind(f.companyId).first<number>('count(*)')).toBe(1);
 await expect(controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'release'})).rejects.toThrow('PROBE_BUSY');
 await expect(controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'})).rejects.toThrow('PROBE_BUSY');
});

it('expired/failed owners remain inspectable; a mismatched ledger never authorizes control',async()=>{
 const c=command(),f=await prepareFinalFixture(bindings(),c);
 await env.DB.prepare('UPDATE cancellation_probe SET expires_at=0 WHERE id=?').bind(c.ownerId).run();
 expect(await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'status'})).toMatchObject({expired:true,companyId:f.companyId});
 await expect(controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'release'})).rejects.toThrow('PROBE_BUSY');
 const closed=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'});expect('cleaned' in closed&&closed.cleaned).toBe(true);
 const other=crypto.randomUUID();await env.DB.prepare("INSERT INTO cancellation_probe(id,stage,metadata,results,created_at,expires_at) VALUES (?,'PREPARING','{}','[]',?,?)").bind(other,Date.now(),Date.now()+60000).run();
 await expect(controlFinalFixture(bindings(),{ownerId:other,action:'cleanup'})).rejects.toThrow('FORBIDDEN');
});

it('a failed preparation retains its original owner, clears only its lease and cannot be retried to make a replacement',async()=>{
 const c=command(),name='架空取消確定検証:'+c.ownerId;
 await env.DB.prepare(`CREATE TRIGGER final_prepare_failure BEFORE INSERT ON company WHEN NEW.name='${name}' BEGIN SELECT RAISE(ABORT,'FINAL_INJECTED_PREPARATION_FAILURE'); END`).run();
 try{
  await expect(prepareFinalFixture(bindings(),c)).rejects.toThrow('FINAL_PREPARATION_FAILED_INSPECT_EXISTING_OWNER');
 }finally{await env.DB.prepare('DROP TRIGGER final_prepare_failure').run();}
 const inspected=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'status'});
 expect(inspected).toMatchObject({stage:'FINAL_PREPARATION_FAILED',busy:false,companyId:null});
 await expect(prepareFinalFixture(bindings(),c)).rejects.toThrow('PROBE_ALREADY_EXISTS');
 expect(await env.DB.prepare('SELECT count(*) FROM company WHERE name=?').bind(name).first<number>('count(*)')).toBe(0);
 const closed=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'});
 expect('cleaned' in closed&&closed.cleaned).toBe(true);
});

it('a job accepted after the idle read rolls back credential retirement and owner closure',async()=>{
 const c=command(),f=await prepareFinalFixture(bindings(),c);
 const admin=(await env.DB.prepare('SELECT user_id FROM company_admin WHERE company_id=?').bind(f.companyId).first<string>('user_id'))!;
 await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(admin).run();
 const snapshotId=crypto.randomUUID();await createInputSnapshot(env.DB,env.INPUTS,f.companyId,f.teamId,admin,{operationId:snapshotId,expectedRevision:9,month:f.month});
 let accepted=false;
 const racing=new Proxy(env.SOLVER,{get(target,key){
  if(key==='getByName')return (name:string)=>new Proxy(target.getByName(name),{get(stub,field){
   if(field==='executionState')return async()=>{
    if(!accepted){accepted=true;await createJob(env.DB,env.INPUTS,f.companyId,f.teamId,admin,{operationId:c.jobIds[0],snapshotId,expectedRevision:9});}
    return idle;
   };
   const value=Reflect.get(stub,field,stub);return typeof value==='function'?value.bind(stub):value;
  }});
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 await expect(controlFinalFixture({...bindings(),SOLVER:racing},{ownerId:c.ownerId,action:'cleanup'})).rejects.toThrow();
 expect(accepted).toBe(true);
 expect(await env.DB.prepare('SELECT cleaned_at FROM cancellation_probe WHERE id=?').bind(c.ownerId).first('cleaned_at')).toBeNull();
 expect(await env.DB.prepare('SELECT count(*) n FROM access_state WHERE enabled=1 AND user_id IN (SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?)').bind(f.companyId,f.companyId).first<number>('n')).toBe(2);
 expect(await env.DB.prepare('SELECT count(*) n FROM account WHERE password IS NOT NULL AND userId IN (SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?)').bind(f.companyId,f.companyId).first<number>('n')).toBe(2);
 await cancelJob(env.DB,f.companyId,f.teamId,admin,c.jobIds[0],{operationId:crypto.randomUUID(),expectedAttempt:0});
 const closed=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'});
 expect('cleaned' in closed&&closed.cleaned).toBe(true);
});

it('the 101-person setup keeps all credentials gated and dispatches zero jobs',async()=>{
 const base=await inputFixture(env.DB,env.INPUTS),snapshotId=crypto.randomUUID();
 await createInputSnapshot(env.DB,env.INPUTS,base.company.companyId,base.team,base.company.userId,{operationId:snapshotId,expectedRevision:base.revision,month:'2026-10'});
 const frozen=await readInputSnapshot(env.DB,env.INPUTS,base.company.companyId,base.team,base.company.userId,snapshotId);
 const input=structuredClone(frozen.input);input.tenantId='fictional-company-a';input.jobId='fictional-operational-101-30-v1';
 input.staff=Array.from({length:101},(_,i)=>({...structuredClone(input.staff[0]),id:'fictional-'+i,unavailable:[],preferences:[]}));
 input.events=[];input.history=[];input.locks=[];input.exceptions=[];input.published=[];
 const c={ownerId:crypto.randomUUID(),profile:'operational101' as const,jobIds:[crypto.randomUUID()],source:{input,assignments:[]}};
 const f=await prepareFinalFixture(bindings(),c);
 expect(f.staffCount).toBe(101);
 expect(await env.DB.prepare('SELECT count(*) FROM staff WHERE company_id=?').bind(f.companyId).first<number>('count(*)')).toBe(101);
 const counts=await env.DB.prepare('SELECT count(*) n FROM access_state WHERE enabled=1 AND must_change_password=1 AND user_id IN (SELECT user_id FROM company_admin WHERE company_id=? UNION SELECT user_id FROM staff WHERE company_id=?)').bind(f.companyId,f.companyId).first<{n:number}>();expect(counts?.n).toBe(102);
 expect(await env.DB.prepare('SELECT count(*) FROM compute_job WHERE company_id=?').bind(f.companyId).first<number>('count(*)')).toBe(0);
 const closed=await controlFinalFixture(bindings(),{ownerId:c.ownerId,action:'cleanup'});expect('credentials' in closed?closed.credentials:null).toEqual({enabled:0,sessions:0,passwords:0});
},120000);
