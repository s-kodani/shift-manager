import { Hono } from 'hono';
import { createAuth, type ResetDelivery } from './auth';
import {withMaintenanceDelivery} from './maintenance-delivery';
import { resetDeliveryConfigured } from './reset-mail';
import { productRoutes } from './product-routes';
import { inputRoutes } from './input-routes';
import { staffSubmissionRoutes } from './staff-submission-routes';
import { explanationRoutes } from './explanation-routes';
import type { SummaryProvider } from './explanations';
import { resetPages } from './reset-page';
import {appPages} from './app-pages';
import type { ApiEnv } from './product';
import {computeRoutes} from './compute-routes';
import {draftRoutes} from './draft-routes';
import {publicationRoutes} from './publication-routes';
import {historyRoutes} from './history-routes';
import {leaveRoutes} from './leave-routes';
import {handleJobBatch,recoverDeliveries} from './compute-worker';
import {AuthInputError,authJson,signInBody,resetRequestBody,resetPasswordBody,changePasswordBody} from './auth-request';
import {limitedResponse,pruneAuthLimits} from './auth-request-limit';
import {withMaintenance,MaintenanceError,maintenanceHeaders,requireRecoverySecurity} from './maintenance';
import {withMaintenanceDatabase,databaseOnlyAuthPath} from './maintenance-database';
import {withMaintenanceBusiness,guardedBusinessPath} from './maintenance-business';
export {OptimizerContainer} from './optimizer-container';

type Access = { tenant_id: string; team_id: string; role: string; staff_id: string | null };

export function createApp(deliverReset?: ResetDelivery, explain?: SummaryProvider) {
  const app = new Hono<ApiEnv>();
  app.route('/', resetPages());
  app.route('/',appPages());
  app.get('/health', (c) => c.json({ status: 'ok', scope: 'A0-A1-PoC' }));
  // Native auth/password responses bypass headers prepared before the handler.
  // Apply the policy after every API response, including failures and exports.
  app.use('/api/*', async (c, next) => {
    try {
      await requireRecoverySecurity(c.env.DB,c.env.RECOVERY_SECURITY_ID);
      if(databaseOnlyAuthPath(c.req.path)){
        const original=c.env;
        await withMaintenanceDatabase(original.DB,async DB=>{
          c.env={...original,DB};
          try{await next();}finally{c.env=original;}
        });
      }else if(guardedBusinessPath(c.req.path)){
        const original=c.env;
        // Background delivery owns a separate admission and the original
        // bindings; it cannot inherit a foreground token released on response.
        c.set('backgroundWork',work=>withMaintenanceDelivery(original,work));
        await withMaintenanceBusiness(original,async scoped=>{
          c.env=scoped;
          try{await next();}finally{c.env=original;}
        });
      }else await withMaintenance(c.env.DB,'FOREGROUND',next);
    }
    catch(error) {
      if(error instanceof MaintenanceError){
        c.header('set-cookie',undefined);
        // A downstream auth handler may already have finalized its response.
        // Replace that response explicitly instead of returning an ignored one.
        c.res=c.json({error:error.code},503,maintenanceHeaders);return c.res;
      }
      throw error;
    }
    c.header('cache-control', 'no-store');
  });
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    const allowed = new Set(['sign-in/email', 'sign-out', 'get-session', 'request-password-reset', 'reset-password']);
    if (!allowed.has(c.req.path.slice('/api/auth/'.length))) return c.json({ error: 'NOT_FOUND' }, 404);
    c.header('cache-control', 'no-store');
    if(c.req.path==='/api/auth/get-session')return c.req.method==='GET'?createAuth(c.env,deliverReset).handler(c.req.raw):c.json({error:'NOT_FOUND'},404);
    if(c.req.method!=='POST')return c.json({error:'NOT_FOUND'},404);
    let body:unknown;try{body=await authJson(c.req.raw,c.env.AUTH_BASE_URL);}catch(error){if(error instanceof AuthInputError)return c.json({error:error.code},error.status);throw error;}
    let data:object,subject:{key:string;window:number;max:number}|undefined;
    if(c.req.path==='/api/auth/sign-in/email'){
      const parsed=signInBody.safeParse(body);if(!parsed.success)return c.json({error:'INVALID_INPUT'},400);data=parsed.data;subject={key:'email:sign-in:'+parsed.data.email,window:60,max:20};
    }else if(c.req.path==='/api/auth/request-password-reset'){
      const parsed=resetRequestBody.safeParse(body);if(!parsed.success)return c.json({error:'INVALID_INPUT'},400);
      const target=c.env.AUTH_BASE_URL+'/reset';if(parsed.data.redirectTo!==undefined&&parsed.data.redirectTo!==target)return c.json({error:'INVALID_REDIRECT'},400);
      data={email:parsed.data.email,redirectTo:target};subject={key:'email:request-reset:'+parsed.data.email,window:3600,max:3};
    }else if(c.req.path==='/api/auth/reset-password'){
      const parsed=resetPasswordBody.safeParse(body);if(!parsed.success)return c.json({error:'INVALID_INPUT'},400);data=parsed.data;subject={key:'token:reset:'+parsed.data.token,window:60,max:10};
    }else{
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return c.json({error:'INVALID_INPUT'},400);data={};
    }
    const request=new Request(c.req.url,{method:'POST',headers:c.req.raw.headers,body:JSON.stringify(data)});
    const run=async()=>{
      const response=await createAuth(c.env,deliverReset,subject).handler(request);
      if(response.status===429){const retry=Number(response.headers.get('x-retry-after'));return limitedResponse(Number.isSafeInteger(retry)&&retry>0?retry:60);}
      return response;
    };
    if (c.req.path === '/api/auth/request-password-reset') {
      // Check configuration before looking up an account; no account-dependent
      // error status when the mail provider is unavailable.
      if (!deliverReset && !resetDeliveryConfigured(c.env)) return c.json({ error: 'RESET_DELIVERY_NOT_CONFIGURED' }, 503);
      const response = await run();
      if (response.status >= 500) {
        return c.json({ status: true, message: 'If this email exists in our system, check your email for the reset link' });
      }
      return response;
    }
    return run();
  });
  app.use('/api/*', async (c, next) => {
    const session = await createAuth(c.env, deliverReset).api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'UNAUTHENTICATED' }, 401);
    const access = await c.env.DB.prepare('SELECT enabled, must_change_password FROM access_state WHERE user_id = ?')
      .bind(session.user.id).first<{ enabled: number; must_change_password: number }>();
    if (!access?.enabled) return c.json({ error: 'USER_DISABLED' }, 403);
    c.set('identity', { userId: session.user.id, mustChange: !!access.must_change_password });
    c.header('cache-control', 'no-store');
    if (access.must_change_password && !['/api/password', '/api/access'].includes(c.req.path)) {
      return c.json({ error: 'PASSWORD_CHANGE_REQUIRED' }, 403);
    }
    await next();
  });
  app.get('/api/access', (c) => c.json(c.get('identity')));
  app.post('/api/password', async (c) => {
    let body:unknown;try{body=await authJson(c.req.raw,c.env.AUTH_BASE_URL);}catch(error){if(error instanceof AuthInputError)return c.json({error:error.code},error.status);throw error;}
    const parsed = changePasswordBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_INPUT' }, 400);
    if (parsed.data.currentPassword === parsed.data.newPassword) return c.json({ error: 'PASSWORD_UNCHANGED' }, 400);
    const url = new URL('/api/auth/change-password', c.env.AUTH_BASE_URL);
    const response = await createAuth(c.env, deliverReset,{key:'user:change:'+c.get('identity').userId,window:60,max:10}).handler(new Request(url, {
      method: 'POST', headers: c.req.raw.headers,
      body: JSON.stringify({ ...parsed.data, revokeOtherSessions: true }),
    }));
    if(response.status===429){const retry=Number(response.headers.get('x-retry-after'));return limitedResponse(Number.isSafeInteger(retry)&&retry>0?retry:60);}
    if (response.ok) {
      // If this write fails, business APIs remain blocked; retry by changing again.
      await c.env.DB.prepare('UPDATE access_state SET must_change_password = 0 WHERE user_id = ? AND enabled = 1')
        .bind(c.get('identity').userId).run();
    }
    return response;
  });
  app.get('/api/me', async (c) => {
    const memberships = await c.env.DB.prepare('SELECT tenant_id, team_id, role, staff_id FROM membership WHERE user_id = ?')
      .bind(c.get('identity').userId).all<Access>();
    return c.json({ userId: c.get('identity').userId, memberships: memberships.results });
  });
  app.route('/api', computeRoutes());
  app.route('/api', publicationRoutes());
  app.route('/api', draftRoutes());
  app.route('/api', historyRoutes());
  app.route('/api', leaveRoutes());
  app.route('/api', staffSubmissionRoutes());
  app.route('/api', explanationRoutes(explain));
  app.route('/api', inputRoutes());
  app.route('/api', productRoutes());
  // Permission probes return only fictitious identifiers, not schedule data.
  app.get('/api/tenants/:tenant/teams/:team/staff/:staff/probe', async (c) => {
    const row = await c.env.DB.prepare(`SELECT role, staff_id FROM membership
      WHERE user_id = ? AND tenant_id = ? AND team_id = ?`)
      .bind(c.get('identity').userId, c.req.param('tenant'), c.req.param('team')).first<Access>();
    if (!row || (row.role === 'staff' && row.staff_id !== c.req.param('staff'))) {
      return c.json({ error: 'FORBIDDEN' }, 403);
    }
    return c.json({ authorized: true, scope: 'permission-probe' });
  });
  app.onError((error, c) => error instanceof MaintenanceError
    ? c.json({error:error.code},503,maintenanceHeaders)
    : c.json({ error: 'INTERNAL_ERROR' }, 500));
  return app;
}

const app=createApp();
export default {
 fetch: (request,env,ctx)=>app.fetch(request,env,ctx),
 queue:handleJobBatch,
 scheduled:async(_event,env)=>{try{await withMaintenanceDelivery(env,async scoped=>{await pruneAuthLimits(scoped.DB);await recoverDeliveries(scoped);});}catch(error){if(!(error instanceof MaintenanceError))throw error;}},
} satisfies ExportedHandler<Env>;
