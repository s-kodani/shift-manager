import { z } from 'zod';
import type { ResetDelivery } from './auth';

// REST endpoint is fixed: configuration cannot redirect a secret to another host.
const endpoint = 'https://api.resend.com/emails';
const senderSchema = z.email().max(254);
type MailSettings = Pick<Env, 'AUTH_BASE_URL' | 'MAIL_DELIVERY' | 'RESET_EMAIL_FROM' | 'RESEND_API_KEY'>;
export class ResetDeliveryFailure extends Error {
  constructor(public providerStatus: number) { super('RESET_DELIVERY_FAILED'); }
}

export function resetDeliveryConfigured(env: MailSettings): boolean {
  return env.MAIL_DELIVERY === 'resend' && !!env.RESEND_API_KEY &&
    senderSchema.safeParse(env.RESET_EMAIL_FROM).success &&
    z.url().safeParse(env.AUTH_BASE_URL).success && new URL(env.AUTH_BASE_URL).protocol === 'https:';
}

export function resendResetDelivery(
  env: MailSettings,
  transport: typeof fetch = fetch,
): ResetDelivery {
  return async ({ email, url }) => {
    if (!resetDeliveryConfigured(env)) {
      throw new Error('RESET_DELIVERY_NOT_CONFIGURED');
    }
    if (!senderSchema.safeParse(email).success) throw new Error('RESET_RECIPIENT_INVALID');
    const base = new URL(env.AUTH_BASE_URL);
    const source = new URL(url);
    if (base.protocol !== 'https:' || source.origin !== base.origin || source.username || source.password ||
        !/^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/.test(source.pathname)) {
      throw new Error('RESET_LINK_INVALID');
    }
    // Send a direct UI link. The reset POST still checks expiry and single use.
    const link = new URL('/reset', base);
    link.hash = new URLSearchParams({token: source.pathname.split('/').pop()!}).toString();
    const payload = JSON.stringify({
      from: env.RESET_EMAIL_FROM,
      to: [email],
      subject: 'シフト管理：パスワード再設定',
      text: `パスワードを再設定するには、15分以内に次のリンクを開いてください。\n${link.href}\n\n心当たりがない場合、このメールは無視してください。`,
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const key = 'password-reset/' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await transport(endpoint, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json', 'idempotency-key': key },
          body: payload,
        });
      } catch {
        if (attempt === 0) continue;
        throw new ResetDeliveryFailure(0);
      }
      // Provider bodies can contain recipient/token data; never read or log them.
      await response.body?.cancel();
      if (response.ok) return;
      if (attempt === 0 && response.status >= 500) continue;
      throw new ResetDeliveryFailure(response.status);
    }
  };
}
