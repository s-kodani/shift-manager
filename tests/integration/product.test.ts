import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/index';
import {
  provisionCompany, createTeam, createStaff, saveCalendarSettings, grantTeamAdmin, resolveCalendarSettings,
} from '../../apps/api/src/product';

const app = createApp();
const base = env.AUTH_BASE_URL;
const op = (revision: number) => ({ operationId: crypto.randomUUID(), expectedRevision: revision });
const settings = { weekStart: 1, deadlineDay: 20, halfDayDivider: 720, roleRounding: 'ceil' as const };
let a: Awaited<ReturnType<typeof provisionCompany>>;
let b: typeof a;
let team: string;
let otherTeam: string;
let bTeam: string;
let staff: Awaited<ReturnType<typeof createStaff>>;
let staffUser: string;
let otherStaff: typeof staff;
let email: string;
let adminEmail: string;

async function request(path: string, cookie?: string, body?: object, origin = base) {
  return app.request(base + path, {
    method: body ? 'POST' : 'GET', headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);
}
async function login(address: string, password: string) {
  const response = await request('/api/auth/sign-in/email', undefined, { email: address, password });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0];
}
const path = (suffix = '') => `/api/companies/${a.companyId}/teams/${team}${suffix}`;
const count = (table: string) => env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE company_id=?`).bind(a.companyId).first('n');
const revision = () => env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(a.companyId).first<number>('revision');

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  adminEmail = `${crypto.randomUUID()}@example.invalid`;
  email = `${crypto.randomUUID()}@example.invalid`;
  a = await provisionCompany(env.DB, { name: '架空企業A', adminName: '架空企業管理者', adminEmail });
  b = await provisionCompany(env.DB, { name: '架空企業B', adminName: '架空別企業管理者', adminEmail: `${crypto.randomUUID()}@example.invalid` });
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id IN (?,?)').bind(a.userId, b.userId).run();
  team = (await createTeam(env.DB, a.companyId, a.userId, { ...op(0), name: '電話チーム' })).teamId;
  otherTeam = (await createTeam(env.DB, a.companyId, a.userId, { ...op(1), name: '事務チーム' })).teamId;
  bTeam = (await createTeam(env.DB, b.companyId, b.userId, { ...op(0), name: '別企業チーム' })).teamId;
  staff = await createStaff(env.DB, a.companyId, team, a.userId, { ...op(2), name: '架空スタッフ', email, staffNumber: '0001' });
  staffUser = (await env.DB.prepare('SELECT user_id FROM staff WHERE company_id=? AND id=?').bind(a.companyId, staff.staffId).first<string>('user_id'))!;
  otherStaff = await createStaff(env.DB, a.companyId, otherTeam, a.userId, { ...op(3), name: '架空別チームスタッフ', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0002' });
});

it.each(['user','account','access','company','admin','audit'])(
  'provision company silent %s omission rolls back credentials and company before exposing a password',async fault=>{
    const counts=async()=>env.DB.prepare(`SELECT (SELECT count(*) FROM user) users,(SELECT count(*) FROM account) accounts,
      (SELECT count(*) FROM access_state) access,(SELECT count(*) FROM company) companies,
      (SELECT count(*) FROM company_admin) admins,(SELECT count(*) FROM product_audit) audits`).first();
    const before=await counts(),input={name:'架空の原子登録企業',adminName:'架空登録管理者',adminEmail:crypto.randomUUID()+'@example.invalid'};
    const table={user:'user',account:'account',access:'access_state',company:'company',admin:'company_admin',audit:'product_audit'}[fault];
    await env.DB.prepare(`CREATE TRIGGER provision_silent_omission BEFORE INSERT ON ${table} BEGIN SELECT RAISE(IGNORE); END`).run();
    try{await expect(provisionCompany(env.DB,input)).rejects.toThrow();expect(await counts()).toEqual(before);}
    finally{await env.DB.prepare('DROP TRIGGER provision_silent_omission').run();}
    const created=await provisionCompany(env.DB,input);expect(created.initialPassword).toBeTruthy();
    expect(await env.DB.prepare('SELECT enabled,must_change_password FROM access_state WHERE user_id=?').bind(created.userId).first()).toEqual({enabled:1,must_change_password:1});
  },
);
it.each([
  ...['audit','team','revision'].map(fault=>({kind:'team',fault})),
  ...['audit','staff','account','access','membership','revision'].map(fault=>({kind:'staff',fault})),
  ...['audit','settings','revision'].map(fault=>({kind:'calendar',fault})),
  ...['audit','role','revision'].map(fault=>({kind:'grant',fault})),
])('product $kind silent $fault omission refuses the entire operation and repairs the same ID',async({kind,fault})=>{
  const r=(await revision())!,c=op(r),nextStaff={...c,name:'架空追加本人',email:crypto.randomUUID()+'@example.invalid',staffNumber:'0003'};
  const write=()=>kind==='team'?createTeam(env.DB,a.companyId,a.userId,{...c,name:'架空追加チーム'}):kind==='staff'?createStaff(env.DB,a.companyId,team,a.userId,nextStaff):kind==='calendar'?saveCalendarSettings(env.DB,a.companyId,a.userId,{...c,effectiveFrom:'2026-10',settings}):grantTeamAdmin(env.DB,a.companyId,team,a.userId,{...c,userId:staffUser});
  const counts=async()=>env.DB.prepare(`SELECT (SELECT count(*) FROM user) users,(SELECT count(*) FROM account) accounts,
    (SELECT count(*) FROM access_state) access,(SELECT count(*) FROM team WHERE company_id=?) teams,
    (SELECT count(*) FROM staff WHERE company_id=?) staff,(SELECT count(*) FROM team_member WHERE company_id=?) members,
    (SELECT count(*) FROM calendar_settings_version WHERE company_id=?) calendars`).bind(a.companyId,a.companyId,a.companyId,a.companyId).first();
  const before=await counts(),kindName={team:'create_team',staff:'create_staff',calendar:'calendar_settings',grant:'grant_team_admin'}[kind];
  const target=fault==='audit'?`BEFORE INSERT ON product_audit WHEN NEW.kind='${kindName}'`:fault==='revision'?'BEFORE UPDATE ON company':fault==='role'?'BEFORE UPDATE ON team_member':`BEFORE INSERT ON ${{team:'team',staff:'staff',account:'account',access:'access_state',membership:'team_member',settings:'calendar_settings_version'}[fault]}`;
  await env.DB.prepare(`CREATE TRIGGER product_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(write()).rejects.toThrow();expect(await revision()).toBe(r);expect(await counts()).toEqual(before);
    for(const table of ['product_operation','product_audit'])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(a.companyId,c.operationId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT role FROM team_member WHERE company_id=? AND team_id=? AND user_id=?').bind(a.companyId,team,staffUser).first('role')).toBe('staff');
  }finally{await env.DB.prepare('DROP TRIGGER product_silent_omission').run();}
  expect(await write()).toMatchObject({replayed:false});expect(await write()).toMatchObject({replayed:true});expect(await revision()).toBe(r+1);
  expect(await env.DB.prepare('SELECT count(*) AS n FROM product_audit WHERE company_id=? AND id=?').bind(a.companyId,c.operationId).first('n')).toBe(1);
});

it('WP-01: native authentication responses never permit caching, including failed login and sign-out', async () => {
  const signed = await request('/api/auth/sign-in/email', undefined, {email:adminEmail,password:a.initialPassword});
  expect(signed.status).toBe(200);
  expect(signed.headers.get('cache-control')).toBe('no-store');
  const cookie=signed.headers.get('set-cookie')!.split(';')[0];
  const session=await request('/api/auth/get-session',cookie);
  expect(session.status).toBe(200);
  expect(session.headers.get('cache-control')).toBe('no-store');
  const failed=await request('/api/auth/sign-in/email',undefined,{email:adminEmail,password:'Fictional-invalid-password'});
  expect(failed.status).toBe(401);
  expect(failed.headers.get('cache-control')).toBe('no-store');
  const signedOut=await request('/api/auth/sign-out',cookie,{});
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.get('cache-control')).toBe('no-store');
});

it('WP-01: issued credentials use real Better Auth login, first change, and revocation', async () => {
  const cookie = await login(email, staff.initialPassword!);
  expect((await request('/api/access', cookie)).status).toBe(200);
  expect(await (await request('/api/access', cookie)).json()).toMatchObject({ mustChange: true });
  expect((await request('/api/context', cookie)).status).toBe(403);
  expect((await request(path('/staff/' + staff.staffId), cookie)).status).toBe(403);
  const changed = `Changed-${crypto.randomUUID()}`;
  const response = await request('/api/password', cookie, { currentPassword: staff.initialPassword, newPassword: changed });
  expect(response.status).toBe(200);
  const newCookie = response.headers.get('set-cookie')!.split(';')[0];
  expect((await request(path('/staff/' + staff.staffId), newCookie)).status).toBe(200);
  expect((await request('/api/context', cookie)).status).toBe(401);
  expect((await request('/api/context', await login(email, changed))).headers.get('cache-control')).toBe('no-store');
});
it('WP-01: company admin sees all company teams, but never another company', async () => {
  const cookie = await login(adminEmail, a.initialPassword);
  const context = await (await request('/api/context', cookie)).json() as { companies: { id: string; role: string; teams: unknown[] }[] };
  expect(context.companies).toHaveLength(1);
  expect(context.companies[0]).toMatchObject({ id: a.companyId, role: 'company_admin' });
  expect(context.companies[0].teams).toHaveLength(2);
  expect((await request(`/api/companies/${a.companyId}/teams/${otherTeam}/staff`, cookie)).status).toBe(200);
  expect((await request(`/api/companies/${b.companyId}/teams/${bTeam}/staff`, cookie)).status).toBe(403);
  expect((await request(`/api/companies/${b.companyId}/teams`, cookie, { ...op(1), name: '拒否' })).status).toBe(403);
});
it('WP-01: staff reads self only and cannot list staff, change settings, or promote self', async () => {
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(staffUser).run();
  const cookie = await login(email, staff.initialPassword!);
  expect((await request(path('/staff/' + staff.staffId), cookie)).status).toBe(200);
  expect((await request(path('/staff'), cookie)).status).toBe(403);
  expect((await request(`/api/companies/${a.companyId}/teams/${otherTeam}/staff/${otherStaff.staffId}`, cookie)).status).toBe(403);
  expect((await request(path('/admins'), cookie, { ...op(4), userId: staffUser })).status).toBe(403);
  expect((await request(`/api/companies/${a.companyId}/calendar-settings`, cookie, { ...op(4), effectiveFrom: '2026-10', settings })).status).toBe(403);
});
it('WP-01: team admin manages assigned team and cannot edit company settings or other teams', async () => {
  await grantTeamAdmin(env.DB, a.companyId, team, a.userId, { ...op(4), userId: staffUser });
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(staffUser).run();
  const cookie = await login(email, staff.initialPassword!);
  expect((await request(path('/staff'), cookie)).status).toBe(200);
  expect((await request(path('/staff'), cookie, { ...op(5), name: '架空追加', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0003' })).status).toBe(200);
  expect((await request(`/api/companies/${a.companyId}/teams/${otherTeam}/staff`, cookie)).status).toBe(403);
  expect((await request(`/api/companies/${a.companyId}/calendar-settings`, cookie, { ...op(6), effectiveFrom: '2026-10', settings })).status).toBe(403);
  expect((await request(path('/admins'), cookie, { ...op(6), userId: staffUser })).status).toBe(403);
});
it('WP-01/02: composite foreign keys prevent cross-company/team staff references', async () => {
  await expect(env.DB.prepare('INSERT INTO team_member VALUES (?,?,?,\'staff\',?)')
    .bind(b.companyId, bTeam, staffUser, staff.staffId).run()).rejects.toThrow('FOREIGN KEY');
  await expect(env.DB.prepare('INSERT INTO team_member VALUES (?,?,?,\'staff\',?)')
    .bind(a.companyId, otherTeam, staffUser, staff.staffId).run()).rejects.toThrow('FOREIGN KEY');
  await expect(grantTeamAdmin(env.DB, a.companyId, otherTeam, a.userId, { ...op(4), userId: staffUser })).rejects.toThrow('INVALID_REFERENCE');
});
it('WP-02/Q100: staff numbers preserve leading zeroes and are unique across company teams', async () => {
  const beforeUsers = await env.DB.prepare('SELECT count(*) n FROM user').first('n');
  await expect(createStaff(env.DB, a.companyId, otherTeam, a.userId, {
    ...op(4), name: '番号重複', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0001',
  })).rejects.toThrow('DUPLICATE_RESOURCE');
  expect(await revision()).toBe(4);
  expect(await env.DB.prepare('SELECT count(*) n FROM user').first('n')).toBe(beforeUsers);
  const separate = await createStaff(env.DB, b.companyId, bTeam, b.userId, {
    ...op(1), name: '別企業同番号', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0001',
  });
  expect(separate.initialPassword).toBeTruthy();
  expect(await env.DB.prepare('SELECT staff_number FROM staff WHERE company_id=? AND id=?').bind(a.companyId, staff.staffId).first('staff_number')).toBe('0001');
});
it('WP-02: stale versions cannot create an account, staff, operation, audit, or bump revision', async () => {
  const before = await env.DB.prepare('SELECT count(*) n FROM user').first('n');
  await expect(createStaff(env.DB, a.companyId, team, a.userId, {
    ...op(3), name: '古い入力', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0003',
  })).rejects.toThrow('VERSION_CONFLICT');
  expect(await revision()).toBe(4);
  expect(await count('staff')).toBe(2);
  expect(await count('product_operation')).toBe(4);
  expect(await count('product_audit')).toBe(5);
  expect(await env.DB.prepare('SELECT count(*) n FROM user').first('n')).toBe(before);
});
it('WP-02: parallel same-revision writers yield one winner and a consistent audit', async () => {
  const commands = [op(4), op(4)];
  const outcomes = await Promise.allSettled(commands.map((input) => createTeam(env.DB, a.companyId, a.userId, { ...input, name: '競合' })));
  expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failed = outcomes.find((r) => r.status === 'rejected');
  expect(failed).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
  expect(await revision()).toBe(5);
  expect(await count('team')).toBe(3);
  expect(await count('product_audit')).toBe(6);
});
it('WP-01/02: repeated staff operation is idempotent and never returns initial password again', async () => {
  const input = { ...op(4), name: '再送試験', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0003' };
  const results = await Promise.all([createStaff(env.DB, a.companyId, team, a.userId, input), createStaff(env.DB, a.companyId, team, a.userId, input)]);
  expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
  expect(results.filter((r) => r.initialPassword !== null)).toHaveLength(1);
  expect(await revision()).toBe(5);
  expect(await count('staff')).toBe(3);
  expect((await createStaff(env.DB, a.companyId, team, a.userId, input)).initialPassword).toBeNull();
  await expect(createStaff(env.DB, a.companyId, team, a.userId, { ...input, name: '変更して再送' })).rejects.toThrow('OPERATION_ID_CONFLICT');
});
it('WP-01/02: disabled or password-change-required actor is rejected by transactional guard', async () => {
  for (const state of [{ enabled: 0, mustChange: 0 }, { enabled: 1, mustChange: 1 }]) {
    await env.DB.prepare('UPDATE access_state SET enabled=?,must_change_password=? WHERE user_id=?').bind(state.enabled, state.mustChange, a.userId).run();
    await expect(createTeam(env.DB, a.companyId, a.userId, { ...op(4), name: '拒否' })).rejects.toThrow('FORBIDDEN');
    expect(await revision()).toBe(4);
  }
});
it('WP-02: audit failure rolls back credentials, memberships, staff, and revision together', async () => {
  const beforeUsers = await env.DB.prepare('SELECT count(*) n FROM user').first('n');
  await env.DB.prepare(`CREATE TRIGGER product_injected_failure BEFORE INSERT ON product_audit
    WHEN NEW.kind='create_staff' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`).run();
  try {
    await expect(createStaff(env.DB, a.companyId, team, a.userId, {
      ...op(4), name: '失敗試験', email: `${crypto.randomUUID()}@example.invalid`, staffNumber: '0003',
    })).rejects.toThrow('INJECTED_FAILURE');
    expect(await revision()).toBe(4);
    expect(await count('staff')).toBe(2);
    expect(await count('product_operation')).toBe(4);
    expect(await count('product_audit')).toBe(5);
    expect(await env.DB.prepare('SELECT count(*) n FROM user').first('n')).toBe(beforeUsers);
  } finally { await env.DB.prepare('DROP TRIGGER product_injected_failure').run(); }
});
it('WP-01/02: revocation between permission read and D1 batch is rejected inside the transaction', async () => {
  const database = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare('DELETE FROM company_admin WHERE company_id=? AND user_id=?').bind(a.companyId, a.userId).run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(createTeam(database, a.companyId, a.userId, { ...op(4), name: '権限失効' })).rejects.toThrow('FORBIDDEN');
  expect(await revision()).toBe(4);
  expect(await count('team')).toBe(2);
  expect(await count('product_operation')).toBe(4);
});
it('WP-01/02: removal of promotion target between read and batch cannot silently succeed', async () => {
  const database = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await env.DB.prepare('DELETE FROM team_member WHERE company_id=? AND team_id=? AND user_id=?').bind(a.companyId, team, staffUser).run();
      return env.DB.batch<T>(statements);
    },
  };
  await expect(grantTeamAdmin(database, a.companyId, team, a.userId, { ...op(4), userId: staffUser })).rejects.toThrow('INVALID_REFERENCE');
  expect(await revision()).toBe(4);
});
it('WP-02: operator provisioning also rolls back on final audit failure', async () => {
  const address = `${crypto.randomUUID()}@example.invalid`;
  await env.DB.prepare(`CREATE TRIGGER provision_injected_failure BEFORE INSERT ON product_audit
    WHEN NEW.kind='operator_provision_company' BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END`).run();
  try {
    await expect(provisionCompany(env.DB, { name: '架空失敗企業', adminName: '架空管理者', adminEmail: address })).rejects.toThrow('INJECTED_FAILURE');
    expect(await env.DB.prepare('SELECT id FROM user WHERE email=?').bind(address).first()).toBeNull();
  } finally { await env.DB.prepare('DROP TRIGGER provision_injected_failure').run(); }
});
it('WP-02: settings resolve by effective month, same-month latest revision, while old versions remain immutable', async () => {
  expect(await resolveCalendarSettings(env.DB, a.companyId, '2026-09')).toBeNull();
  const oct = await saveCalendarSettings(env.DB, a.companyId, a.userId, { ...op(4), effectiveFrom: '2026-10', settings });
  await saveCalendarSettings(env.DB, a.companyId, a.userId, { ...op(5), effectiveFrom: '2026-12', settings: { ...settings, weekStart: 0 } });
  expect((await resolveCalendarSettings(env.DB, a.companyId, '2026-11'))?.id).toBe(oct.settingsVersion);
  expect((await resolveCalendarSettings(env.DB, a.companyId, '2026-12'))?.settings.weekStart).toBe(0);
  await saveCalendarSettings(env.DB, a.companyId, a.userId, { ...op(6), effectiveFrom: '2026-10', settings: { ...settings, weekStart: 2 } });
  expect((await resolveCalendarSettings(env.DB, a.companyId, '2026-11'))?.settings.weekStart).toBe(2);
  expect((await resolveCalendarSettings(env.DB, a.companyId, '2026-12'))?.settings.weekStart).toBe(0);
  expect(await count('calendar_settings_version')).toBe(3);
  await expect(env.DB.prepare('UPDATE calendar_settings_version SET payload=? WHERE company_id=?').bind('{}', a.companyId).run()).rejects.toThrow('IMMUTABLE_SETTINGS_VERSION');
  await expect(env.DB.prepare('DELETE FROM calendar_settings_version WHERE company_id=?').bind(a.companyId).run()).rejects.toThrow('IMMUTABLE_SETTINGS_VERSION');
  await expect(env.DB.prepare('UPDATE product_operation SET fingerprint=? WHERE company_id=?').bind('{}', a.companyId).run()).rejects.toThrow('IMMUTABLE_OPERATION');
  await expect(env.DB.prepare('DELETE FROM product_audit WHERE company_id=?').bind(a.companyId).run()).rejects.toThrow('IMMUTABLE_AUDIT');
});
it('WP-01/02: malformed input, foreign origin, oversized body, and unknown fields are rejected', async () => {
  const cookie = await login(adminEmail, a.initialPassword);
  const endpoint = `/api/companies/${a.companyId}/calendar-settings`;
  for (const body of [
    { ...op(4), effectiveFrom: '2026-13', settings },
    { ...op(4), effectiveFrom: '2026-10', settings: { ...settings, halfDayDivider: 721 } },
    { ...op(4), effectiveFrom: '2026-10', settings, role: 'company_admin' },
    { ...op(4), effectiveFrom: '2026-10', settings: { ...settings, weekStart: 7 } },
  ]) expect((await request(endpoint, cookie, body)).status).toBe(400);
  expect((await request(endpoint, cookie, { ...op(4), effectiveFrom: '2026-10', settings }, 'https://foreign.invalid')).status).toBe(403);
  expect((await request(endpoint, cookie, { padding: 'x'.repeat(17000) })).status).toBe(413);
  const response = await app.request(base + endpoint, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{' }, env);
  expect(response.status).toBe(400);
  expect(await revision()).toBe(4);
});
