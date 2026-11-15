import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it, vi } from 'vitest';
import { resendResetDelivery } from '../../apps/api/src/reset-mail';
import { createAuth } from '../../apps/api/src/auth';
import { createApp } from '../../apps/api/src/index';

const settings = {
  AUTH_BASE_URL: 'https://shift.example.invalid', MAIL_DELIVERY: 'resend',
  RESET_EMAIL_FROM: 'passwords@example.invalid', RESEND_API_KEY: 'fictional-test-api-key',
};
const message = { email: 'fictional-staff@example.invalid', url: settings.AUTH_BASE_URL + '/api/auth/reset-password/fictional-token?callbackURL=%2Freset' };

it('Resend: only the fixed endpoint receives a plain-text reset link and a hashed idempotency key', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"fictional-id"}'));
  const deliver = resendResetDelivery(settings, transport);
  await deliver(message);
  await deliver(message);
  const [url, request] = transport.mock.calls[0];
  expect(url).toBe('https://api.resend.com/emails');
  expect(request?.redirect).toBe('manual');
  expect(request?.signal).toBeInstanceOf(AbortSignal);
  const headers = new Headers(request?.headers);
  expect(headers.get('authorization')).toBe('Bearer fictional-test-api-key');
  expect(headers.get('idempotency-key')).toMatch(/^password-reset\/[a-f0-9]{64}$/);
  expect(new Headers(transport.mock.calls[1][1]?.headers).get('idempotency-key')).toBe(headers.get('idempotency-key'));
  const body = JSON.parse(String(request?.body));
  expect(body.to).toEqual([message.email]);
  expect(body.text).toContain('https://shift.example.invalid/reset#token=fictional-token');
  expect(body.text).not.toContain('callbackURL');
  expect(body.html).toBeUndefined();
});

it('Resend: misconfiguration and untrusted URLs fail before any external request', async () => {
  const transport = vi.fn<typeof fetch>();
  for (const config of [
    { ...settings, MAIL_DELIVERY: 'disabled' }, { ...settings, RESEND_API_KEY: '' },
    { ...settings, RESET_EMAIL_FROM: 'fake\r\nBcc: somebody@example.invalid' },
  ]) {
    await expect(resendResetDelivery(config, transport)(message)).rejects.toThrow('RESET_DELIVERY_NOT_CONFIGURED');
  }
  for (const url of ['https://evil.invalid/api/auth/reset-password/token',
                     settings.AUTH_BASE_URL + '/wrong/token',
                     'https://username:password@shift.example.invalid/api/auth/reset-password/token']) {
    await expect(resendResetDelivery(settings, transport)({ ...message, url })).rejects.toThrow('RESET_LINK_INVALID');
  }
  await expect(resendResetDelivery(settings, transport)({ ...message, email: 'bad\r\n@example.invalid' })).rejects.toThrow('RESET_RECIPIENT_INVALID');
  expect(transport).not.toHaveBeenCalled();
});

it('Resend: native Workers Request accepts the transport options and a redirect is refused', async () => {
  const request = new Request('https://api.resend.com/emails',{method:'POST',body:'{}',redirect:'manual',signal:AbortSignal.timeout(5000)});
  expect(request.redirect).toBe('manual');
  const transport=vi.fn<typeof fetch>().mockImplementation(async (url,options) => {
    new Request(url,options);
    return new Response(null,{status:302,headers:{location:'https://other.invalid/emails'}});
  });
  await expect(resendResetDelivery(settings,transport)(message)).rejects.toThrow('RESET_DELIVERY_FAILED');
  expect(transport).toHaveBeenCalledTimes(1);
});

it('Resend: server failure retries the identical operation; provider error contents stay private', async () => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response('fictional-sensitive-provider-body', { status: 503 }))
    .mockResolvedValueOnce(new Response('{"id":"fictional-id"}'));
  await resendResetDelivery(settings, transport)(message);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[0][1]?.body).toBe(transport.mock.calls[1][1]?.body);
  expect(new Headers(transport.mock.calls[0][1]?.headers).get('idempotency-key'))
    .toBe(new Headers(transport.mock.calls[1][1]?.headers).get('idempotency-key'));
  const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('fictional-sensitive-provider-body', { status: 429 }));
  await expect(resendResetDelivery(settings, denied)(message)).rejects.toThrow(/^RESET_DELIVERY_FAILED$/);
  expect(denied).toHaveBeenCalledTimes(1);
  const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('fictional-sensitive-network-message'));
  await expect(resendResetDelivery(settings, network)(message)).rejects.toThrow(/^RESET_DELIVERY_FAILED$/);
  expect(network).toHaveBeenCalledTimes(2);
});

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
it('Better Auth: real generated reset link is converted, and resetting revokes first-change state', async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"id":"fictional-id"}'));
  const configured = { ...env, ...settings };
  const auth = createAuth(configured, resendResetDelivery(configured, transport));
  const email = `fictional-${crypto.randomUUID()}@example.invalid`;
  const user = await auth.api.createUser({ body: { email, name: 'Fictional Staff', password: `Fake-password-${crypto.randomUUID()}` } });
  await env.DB.prepare('INSERT INTO access_state VALUES (?,1,1)').bind(user.user.id).run();
  const app = createApp(resendResetDelivery(configured, transport));
  const response = await app.request(settings.AUTH_BASE_URL + '/api/auth/request-password-reset', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: settings.AUTH_BASE_URL },
    body: JSON.stringify({ email, redirectTo: settings.AUTH_BASE_URL + '/reset' }),
  }, configured);
  expect(response.status).toBe(200);
  expect(transport).toHaveBeenCalledTimes(1);
  const text: string = JSON.parse(String(transport.mock.calls[0][1]?.body)).text;
  const link = new URL(text.split('\n')[1]);
  expect(link.pathname).toBe('/reset');
  const token = new URLSearchParams(link.hash.slice(1)).get('token');
  const reset = await app.request(settings.AUTH_BASE_URL + '/api/auth/reset-password', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: settings.AUTH_BASE_URL },
    body: JSON.stringify({ token, newPassword: `Fake-new-password-${crypto.randomUUID()}` }),
  }, configured);
  expect(reset.status).toBe(200);
  expect(await env.DB.prepare('SELECT must_change_password FROM access_state WHERE user_id=?').bind(user.user.id).first('must_change_password')).toBe(0);
});

it('reset delivery failure does not reveal whether an account exists', async () => {
  const email = `fictional-${crypto.randomUUID()}@example.invalid`;
  const configured = { ...env, ...settings };
  const auth = createAuth(configured);
  await auth.api.createUser({ body: { email, name: 'Fictional Staff', password: `Fake-password-${crypto.randomUUID()}` } });
  const app = createApp(async () => { throw new Error('RESET_DELIVERY_FAILED'); });
  async function request(recipient: string) {
    return app.request(settings.AUTH_BASE_URL + '/api/auth/request-password-reset', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: settings.AUTH_BASE_URL },
      body: JSON.stringify({ email: recipient, redirectTo: settings.AUTH_BASE_URL + '/reset' }),
    }, configured);
  }
  const existing = await request(email);
  const absent = await request('fictional-absent@example.invalid');
  expect(existing.status).toBe(200);
  expect(absent.status).toBe(200);
  expect(await existing.json()).toEqual(await absent.json());
  const unconfigured = await createApp().request(env.AUTH_BASE_URL + '/api/auth/request-password-reset', {
    method: 'POST', headers: { 'content-type': 'application/json', origin: env.AUTH_BASE_URL },
    body: JSON.stringify({ email: 'fictional-absent@example.invalid', redirectTo: env.AUTH_BASE_URL + '/reset' }),
  }, env);
  expect(unconfigured.status).toBe(503);
});
