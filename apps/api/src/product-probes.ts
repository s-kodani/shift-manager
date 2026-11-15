import {settledMaintenanceWork} from './maintenance';
import { createApp } from './index';
import { provisionCompany, resolveCalendarSettings } from './product';
import type { ProbeResult } from './poc-probes';

// Dedicated, bearer-protected synthetic PoC only. No personal data or mail.
// Immutable histories remain; all generated accounts are disabled on exit.
export async function runProductProbes(env: Env): Promise<ProbeResult[]> {
  const app = createApp();
  const id = () => crypto.randomUUID();
  const email = `${id()}@example.invalid`;
  const company = await provisionCompany(env.DB, { name: 'Fictional product probe', adminName: 'Fictional operator-issued admin', adminEmail: email });
  const results: ProbeResult[] = [];
  const ensure = (condition: boolean) => { if (!condition) throw new Error('PRODUCT_PROBE_ASSERTION'); };
  const req = (path: string, cookie?: string, body?: object) => app.request(env.AUTH_BASE_URL + path, {
    method: body ? 'POST' : 'GET', headers: { origin: env.AUTH_BASE_URL, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);
  const cookieOf = (response: Response) => response.headers.get('set-cookie')?.split(';')[0];
  const prefix = `/api/companies/${company.companyId}`;
  try {
    const signedIn = await req('/api/auth/sign-in/email', undefined, { email, password: company.initialPassword });
    ensure(signedIn.status === 200);
    let cookie = cookieOf(signedIn);
    ensure(!!cookie && (await req('/api/context', cookie)).status === 403);
    ensure((await req('/api/access', cookie)).status === 200);
    const changed = await req('/api/password', cookie, { currentPassword: company.initialPassword, newPassword: `Changed-${id()}` });
    ensure(changed.status === 200);
    cookie = cookieOf(changed);
    ensure(!!cookie && (await req('/api/context', cookie)).status === 200);
    results.push({ case: 'product-issued-account-first-change', passed: true });

    const teamId = id();
    const otherTeam = id();
    ensure((await req(prefix + '/teams', cookie, { operationId: teamId, expectedRevision: 0, name: 'Fictional phone' })).status === 200);
    ensure((await req(prefix + '/teams', cookie, { operationId: otherTeam, expectedRevision: 1, name: 'Fictional backoffice' })).status === 200);
    ensure((await req(`${prefix}/teams/${otherTeam}/staff`, cookie)).status === 200);
    ensure((await req(`/api/companies/${id()}/teams/${teamId}/staff`, cookie)).status === 403);
    results.push({ case: 'company-admin-all-company-teams-isolation', passed: true });

    const staffId = id();
    const staffEmail = `${id()}@example.invalid`;
    const staffInput = { operationId: staffId, expectedRevision: 2, name: 'Fictional member', email: staffEmail, staffNumber: '0001' };
    const created = await req(`${prefix}/teams/${teamId}/staff`, cookie, staffInput);
    ensure(created.status === 200);
    const issued = await created.json() as { initialPassword: string };
    const retry = await (await req(`${prefix}/teams/${teamId}/staff`, cookie, staffInput)).json() as { initialPassword: string | null; replayed: boolean };
    ensure(retry.replayed && retry.initialPassword === null);
    const staffLogin = await req('/api/auth/sign-in/email', undefined, { email: staffEmail, password: issued.initialPassword });
    ensure(staffLogin.status === 200);
    const staffChanged = await req('/api/password', cookieOf(staffLogin), { currentPassword: issued.initialPassword, newPassword: `Changed-${id()}` });
    ensure(staffChanged.status === 200);
    const staffCookie = cookieOf(staffChanged);
    ensure((await req(`${prefix}/teams/${teamId}/staff/${staffId}`, staffCookie)).status === 200);
    ensure((await req(`${prefix}/teams/${teamId}/staff`, staffCookie)).status === 403);
    ensure((await req(`${prefix}/teams/${otherTeam}/staff/${staffId}`, staffCookie)).status === 403);
    results.push({ case: 'staff-self-boundary-and-no-password-replay', passed: true });

    const staleEmail = `${id()}@example.invalid`;
    ensure((await req(`${prefix}/teams/${teamId}/staff`, cookie, { ...staffInput, operationId: id(), expectedRevision: 1, email: staleEmail, staffNumber: '0002' })).status === 409);
    ensure(await env.DB.prepare('SELECT id FROM user WHERE email=?').bind(staleEmail).first() === null);
    results.push({ case: 'stale-version-account-and-resource-rollback', passed: true });
    const parallel = await settledMaintenanceWork([0, 1].map((i) => req(prefix + '/teams', cookie, { operationId: id(), expectedRevision: 3, name: `Fictional concurrent ${i}` })));
    ensure(parallel.map((r) => r.status).sort().join(',') === '200,409');
    results.push({ case: 'product-parallel-writers-one-winner', passed: true });

    const calendar = { weekStart: 1, deadlineDay: 20, halfDayDivider: 720, roleRounding: 'ceil' };
    const oct = id();
    ensure((await req(prefix + '/calendar-settings', cookie, { operationId: oct, expectedRevision: 4, effectiveFrom: '2026-10', settings: calendar })).status === 200);
    ensure((await req(prefix + '/calendar-settings', cookie, { operationId: id(), expectedRevision: 5, effectiveFrom: '2026-12', settings: { ...calendar, weekStart: 0 } })).status === 200);
    ensure((await resolveCalendarSettings(env.DB, company.companyId, '2026-11'))?.id === oct);
    ensure((await resolveCalendarSettings(env.DB, company.companyId, '2026-12'))?.settings.weekStart === 0);
    try {
      await env.DB.prepare('UPDATE calendar_settings_version SET payload=? WHERE company_id=?').bind('{}', company.companyId).run();
      throw new Error('MUTATION_SUCCEEDED');
    } catch (error) { ensure(String(error).includes('IMMUTABLE_SETTINGS_VERSION')); }
    results.push({ case: 'effective-month-and-immutable-settings', passed: true });
    try {
      await env.DB.batch([
        env.DB.prepare('UPDATE company SET revision=999 WHERE id=?').bind(company.companyId),
        env.DB.prepare("INSERT INTO product_audit VALUES (?,?,?,'fictional-injected-failure',999,?)")
          .bind(company.companyId, id(), id(), Date.now()),
      ]);
      throw new Error('FAILURE_NOT_INJECTED');
    } catch (error) { ensure(String(error).includes('FOREIGN KEY')); }
    ensure(await env.DB.prepare('SELECT revision FROM company WHERE id=?').bind(company.companyId).first('revision') === 6);
    results.push({ case: 'product-late-audit-failure-rollback', passed: true });
    return results;
  } finally {
    await env.DB.batch([
      env.DB.prepare(`UPDATE access_state SET enabled=0 WHERE user_id=? OR user_id IN (SELECT user_id FROM staff WHERE company_id=?)`)
        .bind(company.userId, company.companyId),
      env.DB.prepare('DELETE FROM session WHERE userId=? OR userId IN (SELECT user_id FROM staff WHERE company_id=?)')
        .bind(company.userId, company.companyId),
    ]);
  }
}
