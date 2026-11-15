import {env, applyD1Migrations} from 'cloudflare:test';
import {beforeAll, expect, it, vi} from 'vitest';
import {createApp} from '../../apps/api/src/index';
import worker from '../../apps/api/src/poc-worker';
import {startMailProbe, inspectMailProbe, cleanupExpiredMailProbes} from '../../apps/api/src/reset-mail-probe';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const base = 'https://shift.example.invalid';
const configured = {...env, AUTH_BASE_URL:base, RESEND_API_KEY:'fictional-key', SOLVER: env.SOLVER!};
const reset = (token:string, newPassword:string, origin=base) => new Request(base+'/api/auth/reset-password', {
  method:'POST', headers:{'content-type':'application/json', origin}, body:JSON.stringify({token,newPassword}),
});

it('reset pages are public, isolated from the reference mock, and carry no token or account data', async () => {
  for (const path of ['/reset','/reset.css','/reset.browser.js',
    '/app-assets/assets/app-icon-32.png', '/app-assets/assets/app-icon-180.png', '/app-assets/assets/app-icon-192.png']) {
    const response = await worker.fetch(new Request(base+path), configured);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain('unsafe-inline');
  }
  const html = await (await createApp().request(base+'/reset', {}, configured)).text();
  expect(html).toContain('autocomplete="new-password"');
  expect(html).toContain('aria-live="polite"');
  expect(html).not.toContain('/mock/');
  expect(html).toContain('src="/app-assets/assets/app-icon-192.png"');
  expect((await createApp().request(base+'/reset', {}, configured)).headers.get('content-security-policy')).toContain("img-src 'self'");
  // Making the reset page's icons public must not expose the product bundle.
  expect((await worker.fetch(new Request(base+'/app-assets/assets/private.png'), configured)).status).toBe(403);
  const privateResponse = await worker.fetch(new Request(base+'/api/auth/get-session'), configured);
  expect(privateResponse.status).toBe(403);
});

it('public reset POST rejects foreign origin, oversized and malformed input before native reset', async () => {
  expect((await worker.fetch(reset('fictional-token','Fictional-valid-password','https://other.invalid'),configured)).status).toBe(403);
  expect((await worker.fetch(reset('fictional-token','short'),configured)).status).toBe(400);
  const oversized = new Request(base+'/api/auth/reset-password',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'x'.repeat(4097)});
  expect((await worker.fetch(oversized,configured)).status).toBe(413);
  const invalid = new Request(base+'/api/auth/reset-password',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{'});
  expect((await worker.fetch(invalid,configured)).status).toBe(400);
  expect((await worker.fetch(new Request(base+'/api/auth/reset-password'),configured)).status).toBe(403);
});

it('PoC forwards auth only after the private token guard, preserving input checks', async () => {
  const privateEnv={...configured,POC_TOKEN:'fictional-private-token'};
  const req=(token:string)=>new Request(base+'/api/auth/sign-in/email',{method:'POST',headers:{origin:base,'content-type':'application/json',authorization:token},body:'{'});
  expect((await worker.fetch(req(''),privateEnv)).status).toBe(403);
  expect((await worker.fetch(req('Bearer wrong-token'),privateEnv)).status).toBe(403);
  const response=await worker.fetch(req('Bearer fictional-private-token'),privateEnv);
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect((await worker.fetch(new Request(base+'/api/auth/get-session',{headers:{authorization:'Bearer fictional-private-token'}}),privateEnv)).status).toBe(200);
  expect((await worker.fetch(new Request(base+'/api/product',{headers:{authorization:'Bearer fictional-private-token'}}),privateEnv)).status).toBe(404);
});

it('native reset reaches the public page flow, preserves recipient privacy, uses the token once, and cleans the fictional account', async () => {
  const recipient = `fictional-contact-${crypto.randomUUID()}@example.invalid`;
  const transport=vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"fictional-id"}'));
  const report=await startMailProbe(configured,{recipient},transport);
  expect(report.accepted).toBe(true);
  expect(JSON.stringify(report)).not.toContain(recipient);
  expect(transport).toHaveBeenCalledTimes(1);
  const body=JSON.parse(String(transport.mock.calls[0][1]?.body));
  expect(body.to).toEqual([recipient]);
  const link=new URL(body.text.split('\n')[1]);
  expect(link.origin).toBe(base);
  expect(link.pathname).toBe('/reset');
  expect(link.search).toBe('');
  const token=new URLSearchParams(link.hash.slice(1)).get('token')!;
  expect(await env.DB.prepare('SELECT 1 FROM user WHERE email=?').bind(recipient).first()).toBeNull();
  const probeUser=await env.DB.prepare('SELECT user_id FROM reset_delivery_probe WHERE id=?').bind(report.probeId).first<string>('user_id');
  expect(await env.DB.prepare('SELECT 1 FROM team_member WHERE user_id=?').bind(probeUser).first()).toBeNull();
  const oldSession=await createSession(probeUser!);
  const password=`Fictional-reset-${crypto.randomUUID()}`;
  expect((await worker.fetch(reset(token,password),configured)).status).toBe(200);
  expect((await worker.fetch(reset(token,password),configured)).status).toBe(400);
  expect(await env.DB.prepare('SELECT 1 FROM session WHERE id=?').bind(oldSession).first()).toBeNull();
  expect((await inspectMailProbe(env.DB,{probeId:report.probeId,cleanup:false})).resetCompleted).toBe(true);
  const cleaned=await inspectMailProbe(env.DB,{probeId:report.probeId,cleanup:true});
  expect(cleaned.cleaned).toBe(true);
  expect(await env.DB.prepare('SELECT 1 FROM user WHERE id=?').bind(probeUser).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM account WHERE userId=?').bind(probeUser).first()).toBeNull();
});

async function createSession(userId:string) {
  const id=crypto.randomUUID();
  const now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)')
    .bind(id,new Date(Date.now()+600000).toISOString(),crypto.randomUUID(),now,now,userId).run();
  return id;
}

it('expired delivery probes remove tokens and accounts without deleting another active probe', async () => {
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response('{}'));
  const expired=await startMailProbe(configured,{recipient:'fictional-contact@example.invalid'},transport);
  const active=await startMailProbe(configured,{recipient:'fictional-contact@example.invalid'},transport);
  const id=await env.DB.prepare('SELECT user_id FROM reset_delivery_probe WHERE id=?').bind(expired.probeId).first<string>('user_id');
  await env.DB.prepare('UPDATE reset_delivery_probe SET expires_at=? WHERE id=?').bind(Date.now()-1,expired.probeId).run();
  await cleanupExpiredMailProbes(env.DB);
  expect(await env.DB.prepare('SELECT 1 FROM user WHERE id=?').bind(id).first()).toBeNull();
  expect(await env.DB.prepare('SELECT 1 FROM verification WHERE value=?').bind(id).first()).toBeNull();
  expect((await inspectMailProbe(env.DB,{probeId:active.probeId,cleanup:true})).exists).toBe(true);
});

it('delivery failures leave no fictional account, token, or successful probe record', async () => {
  const before=await env.DB.prepare('SELECT COUNT(*) AS count FROM reset_delivery_probe').first<number>('count');
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>new Response('private provider details',{status:403}));
  await expect(startMailProbe(configured,{recipient:'fictional-contact@example.invalid'},transport)).rejects.toThrow('RESET_MAIL_PROBE_FAILED');
  expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM reset_delivery_probe').first('count')).toBe(before);
  expect(transport).toHaveBeenCalledTimes(1);
});
