import { env,applyD1Migrations } from 'cloudflare:test';
import { beforeAll,expect,it } from 'vitest';
import { runSubmissionProbes,inspectSubmissionProbe,cleanupSubmissionProbe } from '../../apps/api/src/staff-submission-probes';
import { inputFixture } from '../../apps/api/src/input-probes';
import poc from '../../apps/api/src/poc-worker';
beforeAll(async()=>{await applyD1Migrations(env.DB,env.TEST_MIGRATIONS);});
const bindings=()=>({...env,ENVIRONMENT:'poc'});
it('private fictional self submission probe uses native auth, actual atomic SQL, concurrent delivery, R2, scoped cleanup and refuses restart',async()=>{
  const probeId=crypto.randomUUID(),r=await runSubmissionProbes(bindings(),{probeId});
  expect(r.results).toHaveLength(9);expect(r.results.every(r=>r.passed)).toBe(true);expect(r.cleanup).toMatchObject({probeId,enabled:0,sessions:0,passwords:0});
  await expect(runSubmissionProbes(bindings(),{probeId})).rejects.toThrow('PROBE_ALREADY_EXISTS');
  expect(await cleanupSubmissionProbe(bindings(),probeId)).toEqual(await inspectSubmissionProbe(bindings(),probeId));
});
it('failed probe cleans only its owned fictional company, retaining unrelated credentials',async()=>{
  const unrelated=await inputFixture(env.DB,env.INPUTS),probeId=crypto.randomUUID();
  const bucket=new Proxy(env.INPUTS,{get(target,key){if(key==='put')return ()=>Promise.reject(new Error('INJECTED_R2_FAILURE'));const v=Reflect.get(target,key,target);return typeof v==='function'?v.bind(target):v;}});
  await expect(runSubmissionProbes({...bindings(),INPUTS:bucket},{probeId})).rejects.toThrow('INJECTED_R2_FAILURE');
  expect(await inspectSubmissionProbe(bindings(),probeId)).toMatchObject({enabled:0,sessions:0,passwords:0});
  expect(await env.DB.prepare('SELECT enabled FROM access_state WHERE user_id=?').bind(unrelated.company.userId).first('enabled')).toBe(1);
});
it('probe surface retains the bearer guard, body bound, UUID contract and no-store errors',async()=>{
  const request=(path:string,body:string,token=true)=>poc.fetch(new Request('https://private.invalid/__poc/'+path,{method:'POST',headers:token?{authorization:'Bearer '+env.POC_TOKEN}:{},body}),bindings() as Cloudflare.PocEnv);
  for(const path of ['staff-submission','staff-submission-status','staff-submission-cleanup'])expect((await request(path,'{}',false)).status).toBe(403);
  for(const [body,status] of [['{}',400],['invalid',400],['x'.repeat(1025),413]] as const){const r=await request('staff-submission-status',body);expect(r.status).toBe(status);expect(r.headers.get('cache-control')).toBe('no-store');}
  await expect(runSubmissionProbes(env,{probeId:crypto.randomUUID()})).rejects.toThrow('FORBIDDEN');
});
