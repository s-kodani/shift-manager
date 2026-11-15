import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';
import { mutation } from './operation-contract';
export { mutation } from './operation-contract';

export type Identity = { userId: string; mustChange: boolean };
export type ApiEnv = { Bindings: Env; Variables: { identity: Identity; backgroundWork:(work:(env:Env)=>Promise<unknown>)=>Promise<unknown> } };
const label = z.string().trim().min(1).max(120);
const identifier = z.string().uuid();
export const month = z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/).refine((value) => Number(value.slice(0, 4)) > 0);
export { calendarSettings } from './calendar-contract';
import { calendarSettings } from './calendar-contract';
export const createTeamInput = mutation.extend({ name: label }).strict();
export const createStaffInput = mutation.extend({
  name: label, email: z.email().max(254).transform((email) => email.toLowerCase()),
  staffNumber: z.string().trim().min(1).max(64),
}).strict();
export const settingsInput = mutation.extend({ effectiveFrom: month, settings: calendarSettings }).strict();
export const grantInput = mutation.extend({ userId: identifier }).strict();

export class ProductError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 503 = 409) { super(code); }
}
type Database = Pick<D1Database, 'prepare' | 'batch'>;
type Role = 'company_admin' | 'team_admin' | 'staff';
export async function companyRole(db: Database, company: string, user: string): Promise<Role | null> {
  if (await db.prepare('SELECT 1 FROM company_admin WHERE company_id=? AND user_id=?').bind(company, user).first()) return 'company_admin';
  const member = await db.prepare(`SELECT role FROM team_member WHERE company_id=? AND user_id=?
    ORDER BY CASE role WHEN 'team_admin' THEN 0 ELSE 1 END LIMIT 1`).bind(company, user).first<{ role: Role }>();
  return member?.role ?? null;
}
export async function teamRole(db: Database, company: string, team: string, user: string): Promise<Role | null> {
  if (!await db.prepare('SELECT 1 FROM team WHERE company_id=? AND id=?').bind(company, team).first()) return null;
  if (await db.prepare('SELECT 1 FROM company_admin WHERE company_id=? AND user_id=?').bind(company, user).first()) return 'company_admin';
  return (await db.prepare('SELECT role FROM team_member WHERE company_id=? AND team_id=? AND user_id=?')
    .bind(company, team, user).first<{ role: Role }>())?.role ?? null;
}
export async function requireManager(db: Database, company: string, team: string | null, user: string) {
  const access = await db.prepare('SELECT enabled,must_change_password FROM access_state WHERE user_id=?')
    .bind(user).first<{ enabled: number; must_change_password: number }>();
  if (!access?.enabled || access.must_change_password) throw new ProductError('FORBIDDEN', 403);
  const role = team === null ? await companyRole(db, company, user) : await teamRole(db, company, team, user);
  if (role !== 'company_admin' && !(team !== null && role === 'team_admin')) throw new ProductError('FORBIDDEN', 403);
}

function newPassword() { return `Initial-${crypto.randomUUID()}-${crypto.randomUUID()}`; }
// Better Auth 1.7.7's native SQLite adapter serializes dates as ISO strings.
// Keep this isolated and exercise real sign-in/change-password on every upgrade.
export async function credentials(db: Database, email: string, name: string) {
  const userId = crypto.randomUUID();
  const password = newPassword();
  const encoded = await hashPassword(password);
  const now = new Date().toISOString();
  return { userId, password, statements: [
    db.prepare(`INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,role,banned)
      VALUES (?,?,?,0,?,?,'user',0)`).bind(userId, name, email, now, now),
    db.prepare(`INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt)
      VALUES (?,?,'credential',?,?,?,?)`).bind(crypto.randomUUID(), userId, userId, encoded, now, now),
    db.prepare('INSERT INTO access_state(user_id,enabled,must_change_password) VALUES (?,1,1)').bind(userId),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM user u
      JOIN account a ON a.userId=u.id JOIN access_state s ON s.user_id=u.id
      WHERE u.id=? AND u.name=? AND u.email=? AND u.emailVerified=0 AND u.role='user' AND u.banned=0
        AND a.accountId=u.id AND a.providerId='credential' AND a.password=?
        AND s.enabled=1 AND s.must_change_password=1
    ) THEN 1 ELSE abs(-9223372036854775808) END AS credentials_saved`).bind(userId,name,email,encoded),
  ] };
}

// Service-operator entry point only. There is deliberately no public HTTP route.
// The operator gains no ongoing access to the company's staff data.
export async function provisionCompany(db: Database, input: { name: string; adminName: string; adminEmail: string }) {
  const parsed = z.object({ name: label, adminName: label, adminEmail: z.email().max(254).transform((s) => s.toLowerCase()) }).strict().parse(input);
  const companyId = crypto.randomUUID();
  const account = await credentials(db, parsed.adminEmail, parsed.adminName);
  const auditId=crypto.randomUUID();
  await db.batch([
    ...account.statements,
    db.prepare('INSERT INTO company(id,name) VALUES (?,?)').bind(companyId, parsed.name),
    db.prepare('INSERT INTO company_admin(company_id,user_id) VALUES (?,?)').bind(companyId, account.userId),
    db.prepare(`INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at)
      VALUES (?,?,NULL,'operator_provision_company',0,?)`).bind(companyId, auditId, Date.now()),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM company c
      JOIN company_admin m ON m.company_id=c.id JOIN product_audit a ON a.company_id=c.id
      WHERE c.id=? AND c.name=? AND c.revision=0 AND m.user_id=? AND a.id=?
        AND a.kind='operator_provision_company' AND a.actor_id IS NULL AND a.revision=0
    ) THEN 1 ELSE abs(-9223372036854775808) END AS company_saved`).bind(companyId,parsed.name,account.userId,auditId),
  ]);
  return { companyId, userId: account.userId, initialPassword: account.password, revision: 0 };
}

type Command = { company: string; team: string | null; user: string; operationId: string; expectedRevision: number;
  kind: 'create_team' | 'create_staff' | 'calendar_settings' | 'grant_team_admin'; fingerprint: string; targetUser: string | null };
async function replay(db: Database, c: Command) {
  const old = await db.prepare('SELECT fingerprint FROM product_operation WHERE company_id=? AND id=?')
    .bind(c.company, c.operationId).first<{ fingerprint: string }>();
  if (old && old.fingerprint !== c.fingerprint) throw new ProductError('OPERATION_ID_CONFLICT');
  return !!old;
}
function command(company: string, team: string | null, user: string, kind: Command['kind'], input: z.infer<typeof mutation> & object): Command {
  return { company, team, user, kind, ...input, fingerprint: JSON.stringify({ user, team, kind, input }),
    targetUser: kind === 'grant_team_admin' && 'userId' in input && typeof input.userId === 'string' ? input.userId : null };
}
async function commit(db: Database, c: Command, statements: D1PreparedStatement[],completion:D1PreparedStatement[] = []) {
  try {
    await db.batch([
      db.prepare(`INSERT INTO product_operation(company_id,id,actor_id,team_id,expected_revision,kind,target_user_id,fingerprint)
        VALUES (?,?,?,?,?,?,?,?)`).bind(c.company, c.operationId, c.user, c.team, c.expectedRevision, c.kind, c.targetUser, c.fingerprint),
      ...statements,
      db.prepare(`INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)`)
        .bind(c.company, c.operationId, c.user, c.kind, c.expectedRevision + 1, Date.now()),
      ...completion,
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM product_operation o
        JOIN company c ON c.id=o.company_id JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        WHERE o.company_id=? AND o.id=? AND o.actor_id=? AND o.team_id IS ? AND o.target_user_id IS ?
          AND o.kind=? AND o.expected_revision=? AND o.fingerprint=? AND c.revision=o.expected_revision+1
          AND a.kind=o.kind AND a.actor_id=o.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS operation_saved`)
        .bind(c.company,c.operationId,c.user,c.team,c.targetUser,c.kind,c.expectedRevision,c.fingerprint),
    ]);
    return false;
  } catch (error) {
    if (await replay(db, c)) {
      await requireManager(db, c.company, c.kind === 'create_staff' ? c.team : null, c.user);
      return true;
    }
    const message = String(error);
    if (message.includes('PRODUCT_FORBIDDEN')) throw new ProductError('FORBIDDEN', 403);
    if (message.includes('PRODUCT_VERSION_CONFLICT')) throw new ProductError('VERSION_CONFLICT');
    if (message.includes('PRODUCT_INVALID_REFERENCE')) throw new ProductError('INVALID_REFERENCE', 400);
    if (message.includes('UNIQUE constraint')) throw new ProductError('DUPLICATE_RESOURCE');
    if (message.includes('FOREIGN KEY constraint')) throw new ProductError('INVALID_REFERENCE', 400);
    throw error;
  }
}
export async function createTeam(db: Database, company: string, user: string, data: z.infer<typeof createTeamInput>) {
  const input = createTeamInput.parse(data);
  await requireManager(db, company, null, user);
  const c = command(company, null, user, 'create_team', input);
  // Operation ID is also the stable resource ID, so retries need no saved secret.
  const replayed = await replay(db, c) || await commit(db, c, [
    db.prepare('INSERT INTO team(company_id,id,name) VALUES (?,?,?)').bind(company, input.operationId, input.name),
  ],[
    db.prepare('SELECT CASE WHEN EXISTS(SELECT 1 FROM team WHERE company_id=? AND id=? AND name=?) THEN 1 ELSE abs(-9223372036854775808) END AS team_saved').bind(company,input.operationId,input.name),
  ]);
  return { teamId: input.operationId, revision: input.expectedRevision + 1, replayed };
}
export async function createStaff(db: Database, company: string, team: string, user: string, data: z.infer<typeof createStaffInput>) {
  const input = createStaffInput.parse(data);
  await requireManager(db, company, team, user);
  const c = command(company, team, user, 'create_staff', input);
  if (await replay(db, c)) return { staffId: input.operationId, initialPassword: null, revision: input.expectedRevision + 1, replayed: true };
  const account = await credentials(db, input.email, input.name);
  const replayed = await commit(db, c, [
    ...account.statements,
    db.prepare('INSERT INTO staff(company_id,team_id,id,staff_number,name,user_id) VALUES (?,?,?,?,?,?)')
      .bind(company, team, input.operationId, input.staffNumber, input.name, account.userId),
    db.prepare("INSERT INTO team_member(company_id,team_id,user_id,role,staff_id) VALUES (?,?,?,'staff',?)")
      .bind(company, team, account.userId, input.operationId),
  ],[
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM staff s JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id
      WHERE s.company_id=? AND s.team_id=? AND s.id=? AND s.staff_number=? AND s.name=? AND s.user_id=?
        AND m.user_id=s.user_id AND m.role='staff'
    ) THEN 1 ELSE abs(-9223372036854775808) END AS staff_saved`).bind(company,team,input.operationId,input.staffNumber,input.name,account.userId),
  ]);
  return { staffId: input.operationId, initialPassword: replayed ? null : account.password, revision: input.expectedRevision + 1, replayed };
}
export async function saveCalendarSettings(db: Database, company: string, user: string, data: z.infer<typeof settingsInput>) {
  const input = settingsInput.parse(data);
  await requireManager(db, company, null, user);
  const c = command(company, null, user, 'calendar_settings', input);
  const replayed = await replay(db, c) || await commit(db, c, [
    db.prepare(`INSERT INTO calendar_settings_version(company_id,operation_id,effective_from,revision,payload)
      VALUES (?,?,?,?,?)`).bind(company, input.operationId, input.effectiveFrom, input.expectedRevision + 1, JSON.stringify(input.settings)),
  ],[
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM calendar_settings_version
      WHERE company_id=? AND operation_id=? AND effective_from=? AND revision=? AND payload=?)
      THEN 1 ELSE abs(-9223372036854775808) END AS calendar_saved`).bind(company,input.operationId,input.effectiveFrom,input.expectedRevision+1,JSON.stringify(input.settings)),
  ]);
  return { settingsVersion: input.operationId, revision: input.expectedRevision + 1, replayed };
}
export async function grantTeamAdmin(db: Database, company: string, team: string, user: string, data: z.infer<typeof grantInput>) {
  const input = grantInput.parse(data);
  await requireManager(db, company, null, user);
  // Only an existing member of this exact team can be promoted by this endpoint.
  if (!await db.prepare('SELECT 1 FROM team_member WHERE company_id=? AND team_id=? AND user_id=?')
    .bind(company, team, input.userId).first()) throw new ProductError('INVALID_REFERENCE', 400);
  const c = command(company, team, user, 'grant_team_admin', input);
  const replayed = await replay(db, c) || await commit(db, c, [
    db.prepare("UPDATE team_member SET role='team_admin' WHERE company_id=? AND team_id=? AND user_id=?")
      .bind(company, team, input.userId),
  ],[
    db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM team_member WHERE company_id=? AND team_id=? AND user_id=? AND role='team_admin') THEN 1 ELSE abs(-9223372036854775808) END AS role_saved").bind(company,team,input.userId),
  ]);
  return { revision: input.expectedRevision + 1, replayed };
}
export async function resolveCalendarSettings(db: Database, company: string, targetMonth: string) {
  month.parse(targetMonth);
  const row = await db.prepare(`SELECT operation_id, effective_from, revision, payload FROM calendar_settings_version
    WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC, revision DESC LIMIT 1`)
    .bind(company, targetMonth).first<{ operation_id: string; effective_from: string; revision: number; payload: string }>();
  return row ? { id: row.operation_id, effectiveFrom: row.effective_from, revision: row.revision, settings: calendarSettings.parse(JSON.parse(row.payload)) } : null;
}
