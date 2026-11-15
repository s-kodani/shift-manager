import {expect,it} from 'vitest';
import {boundedBytes} from '../../apps/api/src/bounded-body';
import {encodeStoredSchedule,decodeStoredSchedule,isCompressedSchedule,scheduleObjectMetadata,SCHEDULE_JSON_LIMIT} from '../../apps/api/src/schedule-serialization';
import {sha256} from '../../apps/api/src/input-snapshots';

it('stored legacy JSON remains readable with unchanged small-object bytes',async()=>{
 const value={schemaVersion:1,reason:'架空',assignments:[]};
 const bytes=await encodeStoredSchedule(value);
 expect(isCompressedSchedule(bytes)).toBe(false);
 expect(new TextDecoder().decode(bytes)).toBe(JSON.stringify(value));
 expect(await decodeStoredSchedule(bytes)).toEqual(value);
 expect(scheduleObjectMetadata(bytes)).toEqual({contentType:'application/json'});
});
it('expanded monthly results over 8MB fit the existing stored limit and preserve every field',async()=>{
 const value={jobId:'fictional',assignments:['x'.repeat(8_100_000)],validation:{status:'VERIFIED'}};
 const raw=new TextEncoder().encode(JSON.stringify(value)),bytes=await encodeStoredSchedule(value);
 expect(raw.byteLength).toBeGreaterThan(8_000_000);
 expect(bytes.byteLength).toBeLessThan(8_000_000);
 expect(isCompressedSchedule(bytes)).toBe(true);
 expect(await decodeStoredSchedule(bytes)).toEqual(value);
 expect(await sha256(bytes)).not.toBe(await sha256(raw));
 expect(scheduleObjectMetadata(bytes)).toEqual({contentType:'application/gzip'});
 expect(scheduleObjectMetadata(bytes)).not.toHaveProperty('contentEncoding');
});
it('bounded expansion rejects compressed oversized data as well as legacy oversized JSON',async()=>{
 const raw=new TextEncoder().encode(JSON.stringify('x'.repeat(SCHEDULE_JSON_LIMIT)));
 const compressed=await boundedBytes(new Response(raw).body!.pipeThrough(new CompressionStream('gzip')),1_000_000);
 await expect(decodeStoredSchedule(compressed)).rejects.toThrow('BODY_LIMIT');
 await expect(decodeStoredSchedule(raw)).rejects.toThrow('BODY_LIMIT');
 await expect(encodeStoredSchedule('x'.repeat(SCHEDULE_JSON_LIMIT))).rejects.toThrow('RESULT_TOO_LARGE');
});
it('both plain and compressed objects obey the caller stored-byte limit',async()=>{
 const error=new Error('DRAFT_TOO_LARGE');
 await expect(encodeStoredSchedule({data:'test'},error,1)).rejects.toBe(error);
 await expect(encodeStoredSchedule({data:'fictional'.repeat(10_000)},error,1)).rejects.toBe(error);
});
it('corrupted gzip and malformed legacy JSON cannot be read',async()=>{
 const bytes=await encodeStoredSchedule({data:'fictional'.repeat(10_000)});
 await expect(decodeStoredSchedule(bytes.slice(0,bytes.length-4))).rejects.toThrow();
 await expect(decodeStoredSchedule(new TextEncoder().encode('{'))).rejects.toThrow();
});
