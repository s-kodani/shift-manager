import { z } from 'zod';
import { createAuth } from './auth';
import { resendResetDelivery, resetDeliveryConfigured, ResetDeliveryFailure } from './reset-mail';

export const mailProbeInput = z.object({recipient: z.email().max(254)}).strict();
export const mailProbeStatus = z.object({probeId: z.string().uuid(), cleanup: z.boolean()}).strict();
export class ResetMailProbeFailure extends Error {
  constructor(public providerStatus: number | null) { super('RESET_MAIL_PROBE_FAILED'); }
}

export function mailProbeConfiguration(env: Env) {
  let keyHeaderValid = false;
  try { new Headers({authorization: `Bearer ${env.RESEND_API_KEY}`}); keyHeaderValid = true; } catch { /* No secret or transport error text is exposed. */ }
  return {keyPresent: !!env.RESEND_API_KEY, keyHeaderValid, keyFormatValid: /^re_[A-Za-z0-9_-]+$/.test(env.RESEND_API_KEY ?? ''),
    testSender: env.RESET_EMAIL_FROM || 'onboarding@resend.dev', productDelivery: env.MAIL_DELIVERY};
}

export async function inspectMailTransport() {
  // Read-only native fetch without an API key, recipient, or message body.
  const transport: typeof fetch = fetch;
  try {
    const response = await transport('https://api.resend.com', {redirect:'manual',signal:AbortSignal.timeout(5000)});
    await response.body?.cancel();
    return {responseReceived:true,status:response.status};
  } catch(error) {
    const message=error instanceof Error?error.message:'';
    return {responseReceived:false,illegalInvocation:/illegal invocation/i.test(message),redirectError:/redirect/i.test(message),timeout:error instanceof Error&&error.name==='TimeoutError'};
  }
}

export async function cleanupExpiredMailProbes(db: D1Database) {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value IN (SELECT user_id FROM reset_delivery_probe WHERE expires_at<=?)").bind(now),
    db.prepare('DELETE FROM user WHERE id IN (SELECT user_id FROM reset_delivery_probe WHERE expires_at<=?)').bind(now),
  ]);
}

export async function startMailProbe(env: Env, data: z.infer<typeof mailProbeInput>, transport: typeof fetch = fetch) {
  const {recipient} = mailProbeInput.parse(data);
  await cleanupExpiredMailProbes(env.DB);
  // This authorized one-off probe overrides only its own sender/delivery. The
  // product's mail mode remains explicitly configured, without storing contacts.
  const configured = {...env, MAIL_DELIVERY: 'resend', RESET_EMAIL_FROM: env.RESET_EMAIL_FROM || 'onboarding@resend.dev'};
  if (!resetDeliveryConfigured(configured)) throw new Error('RESET_DELIVERY_NOT_CONFIGURED');
  const deliver = resendResetDelivery(configured, transport);
  let accepted = false;
  let providerStatus: number | null = null;
  const auth = createAuth(configured, async ({url}) => {
    try { await deliver({email: recipient, url}); accepted = true; }
    catch (error) { if (error instanceof ResetDeliveryFailure) providerStatus = error.providerStatus; throw error; }
  });
  const probeId = crypto.randomUUID();
  const email = `resend-probe-${probeId}@example.invalid`;
  const user = await auth.api.createUser({body: {email, name: 'Fictional Resend Probe', password: `Fictional-${crypto.randomUUID()}-${crypto.randomUUID()}`}});
  const userId = user.user.id;
  const expiresAt = Date.now() + 15 * 60 * 1000;
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO access_state(user_id,enabled,must_change_password) VALUES (?,1,1)').bind(userId),
      env.DB.prepare('INSERT INTO reset_delivery_probe(id,user_id,expires_at) VALUES (?,?,?)').bind(probeId,userId,expiresAt),
    ]);
    await auth.api.requestPasswordReset({body: {email, redirectTo: env.AUTH_BASE_URL + '/reset'}});
    // Better Auth deliberately gives an account-independent success response,
    // including delivery failures. That response is not evidence of acceptance.
    if (!accepted) throw new Error('RESET_DELIVERY_FAILED');
    return {probeId, accepted: true, expiresAt, recipientStored: false};
  } catch {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value=?").bind(userId),
      env.DB.prepare('DELETE FROM user WHERE id=?').bind(userId),
    ]);
    throw new ResetMailProbeFailure(providerStatus);
  }
}

export async function inspectMailProbe(db: D1Database, data: z.infer<typeof mailProbeStatus>) {
  const {probeId, cleanup} = mailProbeStatus.parse(data);
  const row = await db.prepare(`SELECT p.user_id,p.expires_at,a.must_change_password
    FROM reset_delivery_probe p JOIN access_state a ON a.user_id=p.user_id WHERE p.id=?`)
    .bind(probeId).first<{user_id:string; expires_at:number; must_change_password:number}>();
  if (!row) return {exists: false, resetCompleted: false, cleaned: false};
  const resetCompleted = row.must_change_password === 0;
  if (cleanup || row.expires_at <= Date.now()) {
    await db.batch([
      db.prepare("DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value=?").bind(row.user_id),
      db.prepare('DELETE FROM user WHERE id=?').bind(row.user_id),
    ]);
  }
  return {exists: true, resetCompleted, cleaned: cleanup || row.expires_at <= Date.now()};
}
