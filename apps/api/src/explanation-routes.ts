import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { ProductError,type ApiEnv } from './product';
import { explanationSource,explanationCommand } from './explanation-contract';
import { readExplanation,generateExplanation,workersSummaryProvider,EXPLANATION_MODEL,type SummaryProvider } from './explanations';
export function explanationRoutes(provider?:SummaryProvider){
  const app=new Hono<ApiEnv>(),base='/companies/:company/explanations/teams/:team';
  app.use('/companies/:company/explanations/*',async(c,next)=>{
    c.header('cache-control','no-store');
    if(!['GET','HEAD'].includes(c.req.method)&&c.req.header('origin')!==c.env.AUTH_BASE_URL)return c.json({error:'INVALID_ORIGIN'},403);
    await next();
  });
  app.use('/companies/:company/explanations/*',bodyLimit({maxSize:2048,onError:c=>c.json({error:'BODY_LIMIT'},413)}));
  app.onError((e,c)=>e instanceof ProductError?c.json({error:e.code},e.status):e instanceof z.ZodError||e instanceof SyntaxError?c.json({error:'INVALID_INPUT'},400):c.json({error:'INTERNAL_ERROR'},500));
  const scope=(params:Record<string,string>)=>({company:z.string().uuid().parse(params.company),team:z.string().uuid().parse(params.team)});
  app.get(base,async c=>{const {company,team}=scope(c.req.param());return c.json(await readExplanation(c.env,company,team,c.get('identity').userId,explanationSource.parse({kind:c.req.query('kind'),id:c.req.query('id')})));});
  app.post(base,async c=>{const {company,team}=scope(c.req.param());return c.json(await generateExplanation(c.env,company,team,c.get('identity').userId,explanationCommand.parse(await c.req.json()),provider??(c.env.AI_EXPLANATIONS==='workers-ai'&&c.env.AI?workersSummaryProvider((request,signal)=>c.env.AI!.run(EXPLANATION_MODEL,request,{signal})):undefined)));});
  return app;
}
