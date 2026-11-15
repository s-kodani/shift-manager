import {boundedBytes} from './bounded-body';

// Technical limits, independent of product constraints. SQL/backups continue
// to count and hash the actual stored bytes, capped at their existing 8MB.
export const SCHEDULE_JSON_LIMIT=16_000_000;
export const SCHEDULE_OBJECT_LIMIT=8_000_000;
const COMPRESSION_THRESHOLD=64_000;
const stream=(bytes:Uint8Array)=>new ReadableStream<Uint8Array>({start(controller){controller.enqueue(bytes);controller.close();}});
export const isCompressedSchedule=(bytes:Uint8Array)=>bytes[0]===0x1f&&bytes[1]===0x8b;
export async function encodeStoredSchedule(value:unknown,oversize:Error=new Error('RESULT_TOO_LARGE'),storedLimit=SCHEDULE_OBJECT_LIMIT){
 const bytes=new TextEncoder().encode(JSON.stringify(value));
 if(bytes.byteLength>SCHEDULE_JSON_LIMIT)throw oversize;
 if(bytes.byteLength<=COMPRESSION_THRESHOLD){if(bytes.byteLength>storedLimit)throw oversize;return bytes;}
 try{return await boundedBytes(stream(bytes).pipeThrough(new CompressionStream('gzip')),storedLimit);}
 catch(error){if(error instanceof Error&&error.message==='BODY_LIMIT')throw oversize;throw error;}
}
export async function decodeStoredSchedule(bytes:Uint8Array):Promise<any>{
 const expanded=isCompressedSchedule(bytes)?await boundedBytes(stream(bytes).pipeThrough(new DecompressionStream('gzip')),SCHEDULE_JSON_LIMIT):bytes;
 if(expanded.byteLength>SCHEDULE_JSON_LIMIT)throw new Error('BODY_LIMIT');
 return JSON.parse(new TextDecoder().decode(expanded));
}
// Do not mark R2 content-encoding gzip: CLI/backup fetches must preserve bytes
// for the manifest hash. Integrity readers detect gzip after verifying it.
export const scheduleObjectMetadata=(bytes:Uint8Array)=>({contentType:isCompressedSchedule(bytes)?'application/gzip':'application/json'});
