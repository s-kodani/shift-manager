import {settledMaintenanceWork} from './maintenance';
import { applyAtomic, type AtomicCommand } from './atomic';
import { createAuth } from './auth';
import { createApp } from './index';

export type ProbeResult = { case: string; passed: boolean };
const ensure = (condition: boolean, label: string) => { if (!condition) throw new Error(label); };

export async function runD1Probes(db: D1Database, team = crypto.randomUUID()): Promise<ProbeResult[]> {
  const tenant = 'fictional-poc';
  const id = () => crypto.randomUUID();
  const c = (operationId: string, kind: 'cancel' | 'publish' = 'cancel'): AtomicCommand => ({
    id: operationId, tenant, team, kind, expectedVersion: 1, inputVersion: 1, actor: 'fictional-admin',
  });
  const results: ProbeResult[] = [];
  const reset = async () => {
    await db.prepare('UPDATE schedule SET version=1,input_version=1,published=0,cancelled=0 WHERE tenant_id=? AND team_id=?').bind(tenant, team).run();
    await db.prepare('UPDATE participation SET active=1 WHERE tenant_id=? AND team_id=?').bind(tenant, team).run();
  };
  await db.batch([
    db.prepare('INSERT INTO schedule VALUES (?,?,1,1,0,0)').bind(tenant, team),
    db.prepare('INSERT INTO participation VALUES (?,?,1)').bind(tenant, team),
  ]);
  const state = () => db.prepare('SELECT version,cancelled FROM schedule WHERE tenant_id=? AND team_id=?').bind(tenant, team).first<{ version: number; cancelled: number }>();
  try {
    const zero = await db.batch([
      db.prepare('UPDATE schedule SET version=99 WHERE tenant_id=? AND team_id=? AND version=999').bind(tenant, team),
      db.prepare('UPDATE participation SET active=0 WHERE tenant_id=? AND team_id=?').bind(tenant, team),
    ]);
    ensure(zero[0].success && zero[0].meta.changes === 0 && zero[1].meta.changes === 1, 'ZERO_ROW');
    results.push({case: 'zero-row-success-and-later-write', passed: true});
    await reset();
    ensure(await applyAtomic(db, {...c(id()), inputVersion: 0}) === 'conflict', 'STALE_INPUT');
    ensure(await applyAtomic(db, {...c(id()), expectedVersion: 0}) === 'conflict', 'STALE_VERSION');
    ensure((await state())?.version === 1, 'CONFLICT_SIDE_EFFECT');
    results.push({case: 'guarded-stale-versions', passed: true});
    const one = c(id());
    ensure(await applyAtomic(db, one) === 'applied', 'COMMIT');
    ensure(await applyAtomic(db, one) === 'replayed', 'RETRY');
    for (const table of ['revision', 'audit', 'outbox']) {
      ensure(await db.prepare(`SELECT count(*) AS n FROM ${table} WHERE operation_id=?`).bind(one.id).first('n') === 1, 'SIDEEFFECT');
    }
    ensure(await db.prepare('SELECT active FROM participation WHERE tenant_id=? AND team_id=?').bind(tenant, team).first('active') === 0, 'PARTICIPATION');
    results.push({case: 'atomic-cancel-and-idempotency', passed: true});
    await reset();
    const parallel = await settledMaintenanceWork([applyAtomic(db, c(id(), 'publish')), applyAtomic(db, c(id()))]);
    ensure(parallel.sort().join(',') === 'applied,conflict', 'PARALLEL');
    results.push({case: 'parallel-publish-cancel-one-winner', passed: true});
    await reset();
    const failure = id();
    try {
      await db.batch([
        db.prepare('UPDATE schedule SET version=2,cancelled=1 WHERE tenant_id=? AND team_id=?').bind(tenant, team),
        db.prepare('UPDATE participation SET active=0 WHERE tenant_id=? AND team_id=?').bind(tenant, team),
        db.prepare('INSERT INTO outbox(operation_id,kind) VALUES (?,?)').bind(failure, 'cancel'), // missing operation FK
      ]);
      throw new Error('FAILURE_NOT_INJECTED');
    } catch (error) {
      ensure(String(error).includes('FOREIGN KEY'), 'EXPECTED_SQL_FAILURE');
    }
    ensure((await state())?.version === 1, 'ROLLBACK_VERSION');
    ensure(await db.prepare('SELECT active FROM participation WHERE tenant_id=? AND team_id=?').bind(tenant, team).first('active') === 1, 'ROLLBACK_PARTICIPATION');
    results.push({case: 'late-sql-failure-rollback', passed: true});
    return results;
  } finally {
    await db.batch([
      ...['outbox', 'audit', 'revision'].map(table => db.prepare(`DELETE FROM ${table} WHERE operation_id IN (SELECT id FROM operation WHERE tenant_id=? AND team_id=?)`).bind(tenant, team)),
      db.prepare('DELETE FROM operation WHERE tenant_id=? AND team_id=?').bind(tenant, team),
      db.prepare('DELETE FROM participation WHERE tenant_id=? AND team_id=?').bind(tenant, team),
      db.prepare('DELETE FROM schedule WHERE tenant_id=? AND team_id=?').bind(tenant, team),
    ]);
  }
}

export async function runAuthProbes(env: Env): Promise<ProbeResult[]> {
  const mailbox: {email: string; url: string}[] = [];
  const auth = createAuth(env, async message => { mailbox.push(message); });
  const app = createApp(async message => { mailbox.push(message); });
  const email = `${crypto.randomUUID()}@example.invalid`;
  const password = `Fictional-${crypto.randomUUID()}`;
  const newPassword = `Fictional-${crypto.randomUUID()}`;
  const user = await auth.api.createUser({body: {name: 'Fictional Probe', email, password}});
  const uid = user.user.id;
  const result: ProbeResult[] = [];
  const req = (path: string, body?: object, cookie?: string) => app.request(env.AUTH_BASE_URL + path, {
    method: body ? 'POST' : 'GET', headers: {origin: env.AUTH_BASE_URL, 'content-type': 'application/json', ...(cookie ? {cookie} : {})},
    body: body ? JSON.stringify(body) : undefined,
  }, env);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO access_state VALUES (?,1,1)').bind(uid),
      env.DB.prepare("INSERT INTO membership VALUES (?,'fictional-a','fictional-team','staff','fictional-staff')").bind(uid),
    ]);
    ensure((await req('/api/auth/sign-up/email', {email: `${crypto.randomUUID()}@example.invalid`, name: 'Fake', password})).status === 404, 'SIGNUP_DISABLED');
    ensure((await req('/api/me')).status === 401, 'UNAUTHENTICATED');
    ensure((await req('/api/auth/sign-in/email', {email, password: 'wrong-password'})).status === 401, 'WRONG_PASSWORD');
    const login = await req('/api/auth/sign-in/email', {email, password});
    ensure(login.status === 200, 'SIGNIN');
    let cookie = login.headers.get('set-cookie')?.split(';')[0];
    ensure(!!cookie, 'SESSION_COOKIE');
    ensure((await req('/api/me', undefined, cookie)).status === 403, 'INITIAL_GATE');
    const changed = await req('/api/password', {currentPassword: password, newPassword}, cookie);
    ensure(changed.status === 200, 'CHANGE_PASSWORD');
    cookie = changed.headers.get('set-cookie')?.split(';')[0];
    ensure((await req('/api/me', undefined, cookie)).status === 200, 'GATE_RELEASED');
    result.push({case: 'D1-signin-and-first-password-gate', passed: true});
    const own = '/api/tenants/fictional-a/teams/fictional-team/staff/fictional-staff/probe';
    ensure((await req(own, undefined, cookie)).status === 200, 'OWN');
    for (const path of [own.replace('fictional-a/', 'fictional-b/'), own.replace('fictional-team/', 'other-team/'), own.replace('fictional-staff/', 'other-staff/')]) {
      ensure((await req(path, undefined, cookie)).status === 403, 'BOUNDARY');
    }
    result.push({case: 'tenant-team-self-isolation', passed: true});
    ensure((await req('/api/auth/request-password-reset', {email, redirectTo: env.AUTH_BASE_URL + '/reset'})).status === 200 && mailbox.length === 1, 'RESET_MAIL');
    const token = new URL(mailbox[0].url).pathname.split('/').pop();
    const resetPassword = `Fictional-${crypto.randomUUID()}`;
    ensure((await req('/api/auth/reset-password', {token, newPassword: resetPassword})).status === 200, 'RESET');
    ensure(!(await req('/api/auth/reset-password', {token, newPassword: password})).ok, 'TOKEN_REUSE');
    ensure((await req('/api/me', undefined, cookie)).status === 401, 'REVOKED');
    result.push({case: 'fake-mail-reset-single-use-and-session-revocation', passed: true});
    const after = await req('/api/auth/sign-in/email', {email, password: resetPassword});
    ensure(after.status === 200, 'RESET_SIGNIN');
    const afterCookie = after.headers.get('set-cookie')?.split(';')[0];
    await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(uid).run();
    ensure((await req('/api/me', undefined, afterCookie)).status === 403, 'DISABLED');
    result.push({case: 'disabled-user-existing-session-denied', passed: true});
    return result;
  } finally {
    mailbox.length = 0;
    await env.DB.prepare('DELETE FROM user WHERE id=?').bind(uid).run();
  }
}
