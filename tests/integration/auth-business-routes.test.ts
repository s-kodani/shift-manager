import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { createAuth } from '../../apps/api/src/auth';
import { createApp } from '../../apps/api/src/index';

const app = createApp();
const base = env.AUTH_BASE_URL;
// Use the registered method/path pairs, including input resources expanded by
// loops. New business routes must satisfy the same session gate automatically.
const routes = [...new Map(app.routes
  .filter(r => r.path.startsWith('/api/') && !r.path.startsWith('/api/auth/')
    && !['/api/access', '/api/password'].includes(r.path)
    && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method))
  .map(r => [r.method + ' ' + r.path, { method: r.method, path: r.path }])).values()];
const id = '00000000-0000-4000-8000-000000000001';
function concrete(path: string) {
  return path.replace(/:([A-Za-z]+)/g, (_match, key: string) => key === 'month' ? '2026-10' : id);
}
let userId: string, cookie: string;

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  const email = crypto.randomUUID() + '@example.invalid';
  const password = 'Fictional-' + crypto.randomUUID();
  const user = await createAuth(env).api.createUser({ body: { email, password, name: '架空認証試験' } });
  userId = user.user.id;
  await env.DB.prepare('INSERT INTO access_state VALUES (?,1,0)').bind(userId).run();
  const response = await app.request(base + '/api/auth/sign-in/email', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, env);
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  expect((await app.request(base + '/api/me', { headers: { cookie } }, env)).status).toBe(200);
});

const states = [
  { name: 'unauthenticated', status: 401, error: 'UNAUTHENTICATED' },
  { name: 'first password change required', status: 403, error: 'PASSWORD_CHANGE_REQUIRED' },
  { name: 'expired server session', status: 401, error: 'UNAUTHENTICATED' },
  { name: 'logged out', status: 401, error: 'UNAUTHENTICATED' },
  { name: 'disabled existing session', status: 403, error: 'USER_DISABLED' },
] as const;

it.each(states)('TS-AUTH-01/06: every registered business method refuses $name before request parsing', async state => {
  let sentCookie: string | undefined = cookie;
  if (state.name === 'unauthenticated') sentCookie = undefined;
  if (state.name === 'first password change required') {
    await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(userId).run();
    expect((await app.request(base + '/api/access', { headers: { cookie } }, env)).status).toBe(200);
  }
  if (state.name === 'expired server session') {
    await env.DB.prepare('UPDATE session SET expiresAt=? WHERE userId=?').bind(Date.now() - 60_000, userId).run();
  }
  if (state.name === 'logged out') {
    const response = await app.request(base + '/api/auth/sign-out', {
      method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: '{}',
    }, env);
    expect(response.status).toBe(200);
  }
  if (state.name === 'disabled existing session') {
    await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(userId).run();
  }
  const tables = ['company', 'work_input_version', 'compute_job', 'product_audit', 'schedule_publication_version', 'schedule_publication_notice'];
  const counts = () => Promise.all(tables.map(table => env.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first<number>('n')));
  const before = await counts();
  expect(routes.length).toBeGreaterThan(0);
  for (const route of routes) {
    const response = await app.request(base + concrete(route.path), {
      method: route.method,
      headers: { origin: base, 'content-type': 'application/json', ...(sentCookie ? { cookie: sentCookie } : {}) },
      // Intentionally malformed: a rejected identity must never reach parsing,
      // CSV import, R2 lookup, job dispatch or provider inference.
      ...(route.method === 'GET' ? {} : { body: '{' }),
    }, env);
    const label = route.method + ' ' + route.path;
    expect(response.status, label).toBe(state.status);
    expect(await response.json(), label).toEqual({ error: state.error });
    expect(response.headers.get('cache-control'), label).toBe('no-store');
  }
  expect(await counts()).toEqual(before);
});
