import {env,applyD1Migrations} from 'cloudflare:test';
import {expect,it,beforeAll} from 'vitest';
import worker from '../../apps/api/src/poc-worker';
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
import input from '../fixtures/optimizer-benchmark-input.json';
import {optimizerBenchmark} from '../../apps/api/src/optimizer-benchmark';

const command=()=>({input:structuredClone(input),strategy:'balanced-incumbent-v2',budgetSeconds:120});
const request=(data:unknown,token=env.POC_TOKEN)=>new Request('https://poc.invalid/__poc/optimizer-benchmark',{
  method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(data),
});
it('private benchmark requires token and PoC environment before touching the solver',async()=>{
  expect((await worker.fetch(request(command(),'wrong'),env)).status).toBe(403);
  for(const environment of ['local','production'])
    expect((await worker.fetch(request(command()),{...env,ENVIRONMENT:environment})).status).toBe(403);
});
it('private benchmark rejects unbounded settings, unknown keys and non-fictional identity',()=>{
  for(const budgetSeconds of [true,0,121,Infinity,NaN])expect(optimizerBenchmark.safeParse({...command(),budgetSeconds}).success).toBe(false);
  expect(optimizerBenchmark.safeParse({...command(),strategy:'unknown'}).success).toBe(false);
  expect(optimizerBenchmark.safeParse({...command(),overrideHardConditions:true}).success).toBe(false);
  for(const field of ['tenantId','teamId','jobId'] as const){
    const data=command();data.input[field]='real-business';expect(optimizerBenchmark.safeParse(data).success).toBe(false);
  }
  const data=command();data.input.staff[0].id='real-staff';expect(optimizerBenchmark.safeParse(data).success).toBe(false);
});
it('private benchmark input failures do not call any Container RPC',async()=>{
  let calls=0;
  const bindings={...env,ENVIRONMENT:'poc',SOLVER:{getByName:()=>{calls++;throw new Error('Unexpected RPC');}}} as unknown as Cloudflare.PocEnv;
  for(const body of [{...command(),budgetSeconds:121},{...command(),strategy:'unknown'},{}])
    expect((await worker.fetch(request(body),bindings)).status).toBe(400);
  const oversized=new Request('https://poc.invalid/__poc/optimizer-benchmark',{
    method:'POST',headers:{authorization:`Bearer ${env.POC_TOKEN}`},body:'x'.repeat(4_000_001),
  });
  expect((await worker.fetch(oversized,bindings)).status).toBe(413);expect(calls).toBe(0);
});
it.each(['balanced-incumbent-v2','balanced-incumbent-v3','balanced-incumbent-v4'])('private benchmark %s targets the synthetic object and preserves stop evidence',async(strategy)=>{
  const data={...command(),strategy};
  const expected={solverStatus:'FEASIBLE',validation:{status:'VERIFIED'},benchmark:{strategy,budgetSeconds:120}};
  const bindings={...env,ENVIRONMENT:'poc',SOLVER:{getByName:(name:string)=>{
    expect(name).toBe('synthetic-poc');return {benchmark:async(received:unknown)=>{
      expect(received).toEqual(data);return {httpStatus:200,body:JSON.stringify(expected),processStopped:true};
    }};
  }}} as unknown as Cloudflare.PocEnv;
  const response=await worker.fetch(request(data),bindings);
  expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-poc-process-stopped')).toBe('true');expect(await response.json()).toEqual(expected);
});
