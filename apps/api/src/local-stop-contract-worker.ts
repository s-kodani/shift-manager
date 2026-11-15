// Dedicated loopback conformance probe. Product/PoC entries never import it.
import {Container} from '@cloudflare/containers';
import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {confirmProcessStopped} from './container-lifecycle';
import {boundedBytes} from './compute-jobs';
type ProbeEnv={ENVIRONMENT:string;LOCAL_PROBE_TOKEN:string;SOLVER:DurableObjectNamespace<OptimizerContainer>};
type Probe={id:string;mode:'json'|'bounded';stage:string;events:{phase:string;at:number;running:boolean}[];bodyLocked?:boolean;stopError?:string};
export class OptimizerContainer extends Container<ProbeEnv>{
 defaultPort=8080;sleepAfter='1m';enableInternet=false;
 private held:Response|null=null;
 async startProbe(id:string,mode:Probe['mode']){
  if(await this.ctx.storage.get('probe'))throw Error('LOCAL_START_ALREADY_DISPATCHED');
  const p:Probe={id,mode,stage:'STARTING',events:[{phase:'START_DISPATCH',at:Date.now(),running:this.ctx.container?.running===true}]};await this.ctx.storage.put('probe',p);
  const response=await this.containerFetch('http://container/health');if(!response.ok)throw Error('LOCAL_HEALTH_FAILED');
  this.held=response;
  const health=mode==='json'?await response.json():JSON.parse(new TextDecoder().decode(await boundedBytes(response.body,128000)));
  if(!health||typeof health!=='object'||!('status' in health)||health.status!=='ok')throw Error('LOCAL_HEALTH_FAILED');
  p.bodyLocked=response.body?.locked;p.stage='READY';p.events.push({phase:'HEALTH_READ',at:Date.now(),running:this.ctx.container?.running===true});await this.ctx.storage.put('probe',p);return p;
 }
 async stopProbe(id:string){
  const p=await this.ctx.storage.get<Probe>('probe');if(!p||p.id!==id||p.stage!=='READY')throw Error('LOCAL_STOP_NOT_READY');
  p.stage='STOPPING';p.events.push({phase:'STOP_DISPATCH',at:Date.now(),running:this.ctx.container?.running===true});await this.ctx.storage.put('probe',p);
  try{if(!this.ctx.container)throw Error('PROCESS_STOP_UNCONFIRMED');await confirmProcessStopped(this.ctx.container);p.stage='STOP_RETURNED';}
  catch{p.stage='STOP_FAILED';p.stopError='PROCESS_STOP_UNCONFIRMED';}
  p.events.push({phase:p.stage,at:Date.now(),running:this.ctx.container?.running===true});await this.ctx.storage.put('probe',p);return p;
 }
 async clearBody(id:string){const p=await this.ctx.storage.get<Probe>('probe');if(!p||p.id!==id)throw Error('LOCAL_OWNER_MISMATCH');this.held=null;p.events.push({phase:'BODY_RELEASED',at:Date.now(),running:this.ctx.container?.running===true});await this.ctx.storage.put('probe',p);return p;}
 async probeState(id:string){const p=await this.ctx.storage.get<Probe>('probe');if(!p||p.id!==id)throw Error('LOCAL_OWNER_MISMATCH');return {...p,currentRunning:this.ctx.container?.running===true};}
}
const input=z.object({id:z.string().uuid(),action:z.enum(['start','stop','clear-body','state']),mode:z.enum(['json','bounded']).optional()}).strict();
export default {
 async fetch(request:Request,env:ProbeEnv){
  const url=new URL(request.url),headers={'cache-control':'no-store'};
  if(env.ENVIRONMENT!=='local'||!['localhost','127.0.0.1'].includes(url.hostname))return Response.json({error:'LOCAL_ONLY'},{status:403,headers});
  if(request.method==='GET'&&url.pathname==='/health')return Response.json({ready:true},{headers});
  const actual=new TextEncoder().encode(request.headers.get('authorization')??''),expected=new TextEncoder().encode('Bearer '+env.LOCAL_PROBE_TOKEN);
  if(!env.LOCAL_PROBE_TOKEN||actual.length!==expected.length||!timingSafeEqual(actual,expected))return Response.json({error:'FORBIDDEN'},{status:403,headers});
  if(request.method!=='POST'||url.pathname!=='/__local/stop-contract')return Response.json({error:'NOT_FOUND'},{status:404,headers});
  try{const c=input.parse(JSON.parse(new TextDecoder().decode(await boundedBytes(request.body,1024)))),target=env.SOLVER.getByName('stop-contract:'+c.id);
   const result=c.action==='start'?await target.startProbe(c.id,c.mode??'json'):c.action==='stop'?await target.stopProbe(c.id):c.action==='clear-body'?await target.clearBody(c.id):await target.probeState(c.id);
   return Response.json(result,{headers});
  }catch{return Response.json({error:'LOCAL_STOP_PROBE_FAILED'},{status:503,headers});}
 },
} satisfies ExportedHandler<ProbeEnv>;
