import {env} from 'cloudflare:test';
import {expect,it} from 'vitest';
import {encodeStoredSchedule,decodeStoredSchedule,isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import {sha256} from '../../apps/api/src/input-snapshots';

it('native checker receives the full 500-person 30-minute monthly reference above the old 4MB request limit',async()=>{
 const bindings=env as unknown as {LARGE_CHECKER_FIXTURE:Fetcher;NATIVE_CHECKER:Fetcher;CANCELLATION_NATIVE_CHECK_URL:string};
 const response=await bindings.LARGE_CHECKER_FIXTURE.fetch('http://large-fixture.local/');
 const body=await response.text(),payload=JSON.parse(body);
 expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4_000_000);
 expect(payload.input.staff).toHaveLength(500);expect(payload.input.slotMinutes).toBe(30);
 const checked=await bindings.NATIVE_CHECKER.fetch(bindings.CANCELLATION_NATIVE_CHECK_URL+'/check',{method:'POST',headers:{'content-type':'application/json'},body});
 expect(checked.status).toBe(200);const validation=await checked.json() as {status:string;violations:string[];objectiveVector:number[]};
 expect(validation.status).toBe('VERIFIED');expect(validation.violations).toEqual([]);
 expect(validation.objectiveVector).toEqual([0,224000,500,360564000]);
 const result={input:payload.input,assignments:payload.assignments,validation};
 const bytes=await encodeStoredSchedule(result),key=`native-monthly-${crypto.randomUUID()}`;
 expect(isCompressedSchedule(bytes)).toBe(true);
 await env.INPUTS.put(key,bytes,{sha256:await sha256(bytes),httpMetadata:{contentType:'application/gzip'}});
 const saved=new Uint8Array(await(await env.INPUTS.get(key))!.arrayBuffer());
 expect(await sha256(saved)).toBe(await sha256(bytes));
 const restored=await decodeStoredSchedule(saved);expect(restored.assignments).toEqual(payload.assignments);expect(restored.validation).toEqual(validation);
 // This checks real monthly /check transport and R2 serialization, not the
 // 500-person business solver/Queues/UI pipeline or optimality of this reference.
});
