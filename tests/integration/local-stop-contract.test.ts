import {expect,it} from 'vitest';
import worker from '../../apps/api/src/local-stop-contract-worker';
type ProbeEnv=Parameters<typeof worker.fetch>[1];
const id='11111111-1111-4111-8111-111111111111';
function setup(){const names:string[]=[];const env={ENVIRONMENT:'local',LOCAL_PROBE_TOKEN:'fictional-probe-token',SOLVER:{getByName:(name:string)=>{names.push(name);return {probeState:async()=>({id,stage:'READY'})};}}} as unknown as ProbeEnv;return {env,calls:()=>names.length,names};}
it('stop probe is rejected outside the explicit local entry before any SDK access',async()=>{
 const s=setup();for(const [url,environment] of [['http://localhost/__local/stop-contract','production'],['https://example.invalid/__local/stop-contract','local']]){
  const response=await worker.fetch(new Request(url,{method:'POST',headers:{authorization:'Bearer fictional-probe-token'},body:JSON.stringify({id,action:'state'})}),{...s.env,ENVIRONMENT:environment});expect(response.status).toBe(403);
 }expect(s.calls()).toBe(0);
});
it('probe rejects missing token, malformed input and oversized body without acquiring an SDK object',async()=>{
 const s=setup();const request=(body:string,token?:string)=>new Request('http://localhost/__local/stop-contract',{method:'POST',headers:token?{authorization:'Bearer '+token}:{},body});
 expect((await worker.fetch(request(JSON.stringify({id,action:'start'})),s.env)).status).toBe(403);
 for(const body of ['not-json',JSON.stringify({id,action:'unknown'}),'x'.repeat(1025)])expect((await worker.fetch(request(body,'fictional-probe-token'),s.env)).status).toBe(503);
 expect(s.calls()).toBe(0);
});
it('local readiness is read-only and state uses the authenticated owned probe namespace',async()=>{
 const s=setup();expect((await worker.fetch(new Request('http://localhost/health'),s.env)).status).toBe(200);expect(s.calls()).toBe(0);
 const response=await worker.fetch(new Request('http://localhost/__local/stop-contract',{method:'POST',headers:{authorization:'Bearer fictional-probe-token'},body:JSON.stringify({id,action:'state'})}),s.env);expect(response.status).toBe(200);expect(s.names).toEqual(['stop-contract:'+id]);expect(await response.json()).toEqual({id,stage:'READY'});
});
