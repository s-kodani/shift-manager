import {z} from 'zod';

export class AuthInputError extends Error{
  constructor(public code:string,public status:400|403|413|415){super(code);}
}
export async function authJson(request:Request,base:string){
  if(request.headers.get('origin')!==base)throw new AuthInputError('INVALID_ORIGIN',403);
  if(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw new AuthInputError('INVALID_CONTENT_TYPE',415);
  const reader=request.body?.getReader();if(!reader)throw new AuthInputError('INVALID_INPUT',400);
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();throw new AuthInputError('BODY_LIMIT',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)) as unknown;}catch{throw new AuthInputError('INVALID_INPUT',400);}
}
const email=z.email().max(254).transform(s=>s.toLowerCase());
export const signInBody=z.object({email,password:z.string().min(1).max(128),rememberMe:z.boolean().optional()}).strict();
export const resetRequestBody=z.object({email,redirectTo:z.string().max(2048).optional()}).strict();
export const resetPasswordBody=z.object({token:z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),newPassword:z.string().min(12).max(128)}).strict();
export const changePasswordBody=z.object({currentPassword:z.string().min(1).max(128),newPassword:z.string().min(12).max(128)}).strict();
