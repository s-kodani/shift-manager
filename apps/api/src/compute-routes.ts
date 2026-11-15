import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {z} from 'zod';
import {type ApiEnv,ProductError} from './product';
import {createJob,getJob,listJobs,cancelJob,readJobResult,jobCommand,cancelCommand,dispatchJobs} from './compute-jobs';
export function computeRoutes(){
 const app=new Hono<ApiEnv>();
 const base='/companies/:company/compute/teams/:team/jobs';
 app.use('/companies/:company/compute/*',async(c,next)=>{
  c.header('cache-control','no-store');
  if(!['GET','HEAD'].includes(c.req.method)&&c.req.header('origin')!==c.env.AUTH_BASE_URL)return c.json({error:'INVALID_ORIGIN'},403);
  await next();
 });
 app.use('/companies/:company/compute/*',bodyLimit({maxSize:4096,onError:c=>c.json({error:'BODY_LIMIT'},413)}));
 app.onError((error,c)=>{
  if(error instanceof ProductError)return c.json({error:error.code},error.status);
  if(error instanceof z.ZodError||error instanceof SyntaxError)return c.json({error:'INVALID_INPUT'},400);
  return c.json({error:'INTERNAL_ERROR'},500);
 });
 const scope=(params:Record<string,string>)=>({company:z.string().uuid().parse(params.company),team:z.string().uuid().parse(params.team)});
 app.post(base,async(c)=>{
  const {company,team}=scope(c.req.param());
  const accepted=await createJob(c.env.DB,c.env.INPUTS,company,team,c.get('identity').userId,jobCommand.parse(await c.req.json()));
  c.executionCtx.waitUntil(c.get('backgroundWork')(env=>dispatchJobs(env.DB,env.COMPUTE_QUEUE)).catch(()=>undefined));
  return c.json(accepted,202);
 });
 app.get(base,async(c)=>{const {company,team}=scope(c.req.param());return c.json(await listJobs(c.env.DB,company,team,c.get('identity').userId));});
 app.get(base+'/:job',async(c)=>{
  const {company,team}=scope(c.req.param());return c.json(await getJob(c.env.DB,company,team,c.get('identity').userId,z.string().uuid().parse(c.req.param('job'))));
 });
 app.get(base+'/:job/result',async(c)=>{
  const {company,team}=scope(c.req.param());return c.json(await readJobResult(c.env.DB,c.env.INPUTS,company,team,c.get('identity').userId,z.string().uuid().parse(c.req.param('job'))));
 });
 app.post(base+'/:job/cancel',async(c)=>{
  const {company,team}=scope(c.req.param());
  const cancelled=await cancelJob(c.env.DB,company,team,c.get('identity').userId,z.string().uuid().parse(c.req.param('job')),cancelCommand.parse(await c.req.json()));
  c.executionCtx.waitUntil(c.get('backgroundWork')(env=>dispatchJobs(env.DB,env.COMPUTE_QUEUE)).catch(()=>undefined));
  return c.json(cancelled);
 });
 return app;
}
