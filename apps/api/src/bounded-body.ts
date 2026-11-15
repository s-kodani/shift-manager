export async function boundedBytes(body:ReadableStream<Uint8Array>|null,maximum:number) {
 if(!body)throw new Error('EMPTY_BODY');const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0;
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw new Error('BODY_LIMIT');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
