import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { type ApiEnv, ProductError } from './product';
import { inputMonth } from './input-versions';
import { staffSubmission, submissionWindowCommand } from './staff-submission-contract';
import { readStaffSubmission, saveStaffSubmission, readSubmissionWindow, setSubmissionWindow } from './staff-submission';
import { dispatchRevalidations } from './publication-revalidation';

export function staffSubmissionRoutes() {
  const app=new Hono<ApiEnv>(),base='/companies/:company/inputs/teams/:team';
  for(const path of [base+'/self-month/*',base+'/submission-window/*']) {
    app.use(path,async(c,next)=>{
      c.header('cache-control','no-store');
      if(!['GET','HEAD'].includes(c.req.method)&&c.req.header('origin')!==c.env.AUTH_BASE_URL)return c.json({error:'INVALID_ORIGIN'},403);
      await next();
    });
    app.use(path,bodyLimit({maxSize:128*1024,onError:c=>c.json({error:'INPUT_TOO_LARGE'},413)}));
  }
  app.onError((error,c)=>{
    if(error instanceof ProductError)return c.json({error:error.code},error.status);
    if(error instanceof z.ZodError||error instanceof SyntaxError)return c.json({error:'INVALID_INPUT'},400);
    return c.json({error:'INTERNAL_ERROR'},500);
  });
  const scope=(p:Record<string,string>)=>({company:z.string().uuid().parse(p.company),team:z.string().uuid().parse(p.team),month:inputMonth.parse(p.month)});
  app.get(base+'/self-month/:month',async c=>{
    const s=scope(c.req.param());return c.json(await readStaffSubmission(c.env.DB,s.company,s.team,c.get('identity').userId,s.month));
  });
  app.post(base+'/self-month/:month',async c=>{
    const s=scope(c.req.param()),result=await saveStaffSubmission(c.env.DB,c.env.INPUTS,s.company,s.team,c.get('identity').userId,s.month,staffSubmission.parse(await c.req.json()));
    await dispatchRevalidations(c.env.DB,c.env.COMPUTE_QUEUE,s.company);return c.json(result);
  });
  app.get(base+'/submission-window/:month',async c=>{
    const s=scope(c.req.param());return c.json(await readSubmissionWindow(c.env.DB,s.company,s.team,c.get('identity').userId,s.month));
  });
  app.post(base+'/submission-window/:month',async c=>{
    const s=scope(c.req.param());return c.json(await setSubmissionWindow(c.env.DB,s.company,s.team,c.get('identity').userId,s.month,submissionWindowCommand.parse(await c.req.json())));
  });
  return app;
}
