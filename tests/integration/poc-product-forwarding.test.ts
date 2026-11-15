import {env,applyD1Migrations,createExecutionContext,waitOnExecutionContext} from 'cloudflare:test';
import {beforeAll,beforeEach,expect,it} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
import {inputFixture} from '../../apps/api/src/input-probes';
import {createInputSnapshot} from '../../apps/api/src/input-snapshots';
import {cancelJob} from '../../apps/api/src/compute-jobs';

let f:Awaited<ReturnType<typeof inputFixture>>;
const bindings=()=>({...env,ENVIRONMENT:'poc'});
const token=()=>({authorization:`Bearer ${env.POC_TOKEN}`});
const request=(path:string,headers:Record<string,string>=token(),body?:unknown)=>new Request(env.AUTH_BASE_URL+path,{
  method:body===undefined?'GET':'POST',headers:{...headers,...(body===undefined?{}:{origin:env.AUTH_BASE_URL,'content-type':'application/json'})},
  body:body===undefined?undefined:JSON.stringify(body),
});
async function login(){
  const r=await worker.fetch(request('/api/auth/sign-in/email',token(),{email:f.email,password:f.company.initialPassword}),bindings());
  expect(r.status).toBe(200);return r.headers.get('set-cookie')!.split(';')[0];
}
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
beforeEach(async()=>{f=await inputFixture(env.DB);});

it('private product HTML/assets keep the PoC token and environment boundary',async()=>{
  for(const path of ['/app','/app-assets/assets/private.json','/api/context'])
    expect((await worker.fetch(request(path,{}),bindings())).status).toBe(403);
  expect((await worker.fetch(request('/app'),{...env,ENVIRONMENT:'local'})).status).toBe(403);
  expect((await worker.fetch(request('/api/unknown'),bindings())).status).toBe(404);
  const page=await worker.fetch(request('/app'),bindings());expect(page.status).toBe(200);
  expect(page.headers.get('cache-control')).toBe('no-store');
  const html=await page.text(),asset=html.match(/src="([^"]+\.js)"/)![1];
  expect(asset).toMatch(/^\/app-assets\/assets\//);
  expect((await worker.fetch(request(asset),bindings())).status).toBe(200);
  expect((await worker.fetch(request('/app-assets/assets/private.json'),bindings())).status).toBe(404);
});

it('the PoC token never replaces login, first change or live company authority',async()=>{
  expect((await worker.fetch(request('/api/context'),bindings())).status).toBe(401);
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(f.company.userId).run();
  const cookie=await login(),headers={...token(),cookie};
  const blocked=await worker.fetch(request('/api/context',headers),bindings());
  expect(blocked.status).toBe(403);expect(await blocked.json()).toEqual({error:'PASSWORD_CHANGE_REQUIRED'});
  const changed=await worker.fetch(request('/api/password',headers,{currentPassword:f.company.initialPassword,newPassword:crypto.randomUUID()+crypto.randomUUID()}),bindings());
  expect(changed.status).toBe(200);
  const fresh={...token(),cookie:changed.headers.get('set-cookie')!.split(';')[0]};
  const context=await worker.fetch(request('/api/context',fresh),bindings());expect(context.status).toBe(200);
  expect(JSON.stringify(await context.json())).toContain(f.company.companyId);
  expect((await worker.fetch(request(`/api/companies/${crypto.randomUUID()}/teams/${f.team}/staff`,fresh),bindings())).status).toBe(403);
  await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(f.company.userId).run();
  expect((await worker.fetch(request('/api/context',fresh),bindings())).status).toBe(403);
});

it('the real ExecutionContext reaches product job dispatch after the private HTTP response',async()=>{
  const cookie=await login(),snapshotId=crypto.randomUUID();
  await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
  const sent:unknown[]=[],queue:Queue={
    async metrics(){return {backlogCount:sent.length,backlogBytes:0};},
    async send(body){sent.push(body);return {metadata:{metrics:{backlogCount:sent.length,backlogBytes:0}}};},
    async sendBatch(messages){for(const message of messages)sent.push(message.body);return {metadata:{metrics:{backlogCount:sent.length,backlogBytes:0}}};},
  };
  const ctx=createExecutionContext(),id=crypto.randomUUID();
  const result=await worker.fetch(request(`/api/companies/${f.company.companyId}/compute/teams/${f.team}/jobs`,{...token(),cookie},{operationId:id,snapshotId,expectedRevision:f.revision}),{...bindings(),COMPUTE_QUEUE:queue},ctx);
  expect(result.status).toBe(202);await waitOnExecutionContext(ctx);
  expect(sent).toEqual([{version:1,companyId:f.company.companyId,teamId:f.team,jobId:id}]);
  expect(await env.DB.prepare('SELECT state FROM compute_job WHERE company_id=? AND id=?').bind(f.company.companyId,id).first('state')).toBe('QUEUED');
  await cancelJob(env.DB,f.company.companyId,f.team,f.company.userId,id,{operationId:crypto.randomUUID(),expectedAttempt:0});
});
