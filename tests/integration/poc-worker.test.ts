import { env,applyD1Migrations } from 'cloudflare:test';
import { expect, it,beforeAll } from 'vitest';
import worker from '../../apps/api/src/poc-worker';
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});

const request = (path: string, token = env.POC_TOKEN, body?: string) => new Request(`https://poc.invalid${path}`, {
  method: 'POST', headers: {'authorization': `Bearer ${token}`}, body,
});
const bindings = env as Cloudflare.PocEnv;

it('denies missing and incorrect PoC tokens before executing probes', async () => {
  for (const r of [new Request('https://poc.invalid/__poc/d1'), request('/__poc/auth', 'wrong'), request('/__poc/check', 'wrong'), request('/__poc/optimizer-health', 'wrong'),request('/__poc/optimizer-destroy-idle','wrong'),request('/__poc/inputs','wrong'),request('/__poc/csv-assets','wrong'),request('/__poc/reset-mail','wrong'),request('/__poc/reset-mail-status','wrong'),request('/__poc/compute-start','wrong'),request('/__poc/compute-status','wrong'),request('/__poc/compute-cleanup','wrong'),request('/__poc/compute-interrupt','wrong')]) {
    expect((await worker.fetch(r, bindings)).status).toBe(403);
  }
});
it('idle recovery rejects other environments and active process ownership', async () => {
  let calls=0;
  const target={executionState:async()=>({activeRpc:false,persistedFence:false,processRunning:true}),destroy:async()=>{calls++;}};
  const bound={...env,ENVIRONMENT:'poc',SOLVER:{getByName:(name:string)=>{expect(name).toBe('synthetic-poc');return target;}}} as unknown as Cloudflare.PocEnv;
  for(const environment of ['local','production'])expect((await worker.fetch(request('/__poc/optimizer-destroy-idle'),{...bound,ENVIRONMENT:environment})).status).toBe(403);
  for(const state of [{activeRpc:true,persistedFence:false},{activeRpc:false,persistedFence:true}]){
    target.executionState=async()=>({...state,processRunning:true});
    expect((await worker.fetch(request('/__poc/optimizer-destroy-idle'),bound)).status).toBe(409);
  }
  expect(calls).toBe(0);
});
it('idle recovery reports the observed process state after destroy', async () => {
  let running=true;
  const bound={...env,ENVIRONMENT:'poc',SOLVER:{getByName:()=>({executionState:async()=>({activeRpc:false,persistedFence:false,processRunning:running}),destroy:async()=>{running=false;}})}} as unknown as Cloudflare.PocEnv;
  const response=await worker.fetch(request('/__poc/optimizer-destroy-idle'),bound);
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({released:true,processRunning:false});
});
it('rejects unknown authorized routes', async () => {
  for(const path of ['/api/auth/sign-up/email','/api/auth/admin/create-user','/api/unknown']) {
    expect((await worker.fetch(request(path), bindings)).status).toBe(404);
  }
});
it('bounds input before forwarding to Containers', async () => {
  expect((await worker.fetch(request('/__poc/optimizer', undefined, 'x'.repeat(4_000_001)), bindings)).status).toBe(413);
  expect((await worker.fetch(request('/__poc/check', undefined, 'x'.repeat(4_000_001)), bindings)).status).toBe(413);
});
it('returns a generic failure on a rejected Container request', async () => {
  const failing = {...env, SOLVER: {getByName: () => ({fetch: async () => {throw new Error('internal detail');}})}} as unknown as Cloudflare.PocEnv;
  const response = await worker.fetch(request('/__poc/optimizer', undefined, '{}'), failing);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({error: 'PROBE_FAILED'});
});
