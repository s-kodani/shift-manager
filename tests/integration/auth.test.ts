import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { createAuth } from '../../apps/api/src/auth';
import { createApp } from '../../apps/api/src/index';

const mailbox: {email: string; url: string}[] = [];
const app = createApp(async (m) => { mailbox.push(m); });
const auth = createAuth(env, async (m) => { mailbox.push(m); });
const base = env.AUTH_BASE_URL;
let userId: string;
const initial = () => `Fake-initial-${crypto.randomUUID()}`;
let password: string;

async function request(path: string, body?: object, cookie?: string) {
  return app.request(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, env);
}
async function login(pass = password) {
  const response = await request('/api/auth/sign-in/email', {email: 'staff@example.invalid', password: pass});
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  for (const table of ['membership', 'access_state', 'session', 'account', 'verification', 'user']) {
    await env.DB.prepare(`DELETE FROM "${table}"`).run();
  }
  mailbox.length = 0;
  password = initial();
  const created = await auth.api.createUser({ body: { email: 'staff@example.invalid', password, name: 'Fictional Staff' } });
  userId = created.user.id;
  await env.DB.prepare('INSERT INTO access_state VALUES (?,1,1)').bind(userId).run();
  await env.DB.prepare("INSERT INTO membership VALUES (?,'fake-a','team-a','staff','staff-a')").bind(userId).run();
});
it('STACK-03: signup and admin HTTP provisioning are closed', async () => {
  expect((await request('/api/auth/sign-up/email', { email: 'other@example.invalid', name: 'Other', password: initial() })).status).toBe(404);
  expect((await request('/api/auth/admin/create-user', {})).status).toBe(404);
  expect((await request('/api/auth/change-password', {})).status).toBe(404);
});
it('STACK-03: first change required, wrong/current-equal password cannot unlock; successful change unlocks', async () => {
  expect((await request('/api/me')).status).toBe(401);
  const cookie = await login();
  expect((await request('/api/me', undefined, cookie)).status).toBe(403);
  expect((await request('/api/password', { currentPassword: 'wrong', newPassword: initial() }, cookie)).ok).toBe(false);
  expect((await request('/api/password', { currentPassword: password, newPassword: password }, cookie)).status).toBe(400);
  expect((await request('/api/me', undefined, cookie)).status).toBe(403);
  const changed = initial();
  const response = await request('/api/password', { currentPassword: password, newPassword: changed }, cookie);
  expect(response.status).toBe(200);
  const changedCookie = response.headers.get('set-cookie')!.split(';')[0];
  expect((await request('/api/me', undefined, changedCookie)).status).toBe(200);
  expect((await request('/api/me', undefined, cookie)).status).toBe(401);
  await login(changed);
});
it('STACK-03: tenant/team/self checks and disabled existing sessions', async () => {
  const cookie = await login();
  await env.DB.prepare('UPDATE access_state SET must_change_password=0').run();
  expect((await request('/api/tenants/fake-a/teams/team-a/staff/staff-a/probe', undefined, cookie)).status).toBe(200);
  for (const path of ['fake-b/teams/team-a/staff/staff-a', 'fake-a/teams/team-b/staff/staff-a', 'fake-a/teams/team-a/staff/staff-b']) {
    expect((await request('/api/tenants/' + path + '/probe', undefined, cookie)).status).toBe(403);
  }
  await env.DB.prepare('UPDATE access_state SET enabled=0').run();
  expect((await request('/api/me', undefined, cookie)).status).toBe(403);
});
it('STACK-03: reset via private fake mailbox, single use and session revocation', async () => {
  const cookie = await login();
  expect((await request('/api/auth/request-password-reset', {email: 'staff@example.invalid', redirectTo: base + '/reset'})).status).toBe(200);
  expect(mailbox).toHaveLength(1);
  const token = new URL(mailbox[0].url).pathname.split('/').pop();
  const newPassword = initial();
  expect((await request('/api/auth/reset-password', {token, newPassword})).status).toBe(200);
  expect((await request('/api/auth/reset-password', {token, newPassword: initial()})).ok).toBe(false);
  expect((await request('/api/me', undefined, cookie)).status).toBe(401);
  expect((await request('/api/me', undefined, await login(newPassword))).status).toBe(200);
});
it('STACK-03: expired reset token and foreign origin are rejected', async () => {
  await request('/api/auth/request-password-reset', {email: 'staff@example.invalid', redirectTo: base + '/reset'});
  const token = new URL(mailbox[0].url).pathname.split('/').pop();
  await env.DB.prepare('UPDATE verification SET expiresAt=0').run();
  expect((await request('/api/auth/reset-password', {token, newPassword: initial()})).ok).toBe(false);
  const response = await app.request(base + '/api/password', {method: 'POST', headers: {origin: 'https://evil.invalid', cookie: await login(), 'content-type': 'application/json'}, body: JSON.stringify({currentPassword: password, newPassword: initial()})}, env);
  expect(response.status).toBe(403);
});
it('STACK-03: logout invalidates existing cookie', async () => {
  const cookie = await login();
  expect((await request('/api/auth/sign-out', {}, cookie)).status).toBe(200);
  expect((await request('/api/me', undefined, cookie)).status).toBe(401);
});

it('TS-AUTH-01: wrong password and unknown identity cannot create an authenticated session', async () => {
  const before = await env.DB.prepare('SELECT count(*) AS n FROM session').first('n');
  for (const email of ['staff@example.invalid', 'unknown@example.invalid']) {
    const response = await request('/api/auth/sign-in/email', {email, password: initial()});
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await env.DB.prepare('SELECT count(*) AS n FROM session').first('n')).toBe(before);
  }
  expect((await request('/api/me')).status).toBe(401);
  expect((await request('/api/context')).status).toBe(401);
});

it('TS-AUTH-01: a once-valid cookie is refused after its server session expires; fresh login still works', async () => {
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(userId).run();
  const expiredCookie = await login();
  expect((await request('/api/me', undefined, expiredCookie)).status).toBe(200);
  expect((await request('/api/context', undefined, expiredCookie)).status).toBe(200);
  await env.DB.prepare('UPDATE session SET expiresAt=? WHERE userId=?').bind(Date.now() - 60_000, userId).run();
  expect((await request('/api/me', undefined, expiredCookie)).status).toBe(401);
  expect((await request('/api/context', undefined, expiredCookie)).status).toBe(401);
  await expect((await request('/api/auth/get-session', undefined, expiredCookie)).json()).resolves.toBeNull();
  const freshCookie = await login();
  expect(freshCookie).not.toBe(expiredCookie);
  expect((await request('/api/me', undefined, freshCookie)).status).toBe(200);
  expect((await request('/api/context', undefined, freshCookie)).status).toBe(200);
  expect((await request('/api/me', undefined, expiredCookie)).status).toBe(401);
});
