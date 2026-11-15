import { Hono } from 'hono';
import html from '../../web/reset.html';
import script from '../../web/reset.browser.js';
import type { ApiEnv } from './product';

const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Only these shared, non-sensitive images are public alongside the reset page.
// Other app assets still require the PoC's private browser access.
export const resetPagePaths = new Set(['/reset', '/reset.css', '/reset.browser.js',
  '/app-assets/assets/app-icon-32.png',
  '/app-assets/assets/app-icon-180.png',
  '/app-assets/assets/app-icon-192.png',
]);
export function resetPages() {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    if (!resetPagePaths.has(c.req.path)) { await next(); return; }
    // Assets return their own Response; apply policy after it has been installed.
    await next();
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', policy);
    c.header('x-content-type-options', 'nosniff');
    c.header('x-robots-tag', 'noindex, nofollow');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  });
  app.get('/reset', (c) => c.html(html));
  app.get('/reset.css', async (c) => {
    const url = new URL(c.req.url);
    url.pathname = '/assets/reset.css'; url.search = '';
    const response = await c.env.ASSETS.fetch(new Request(url));
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/css; charset=utf-8');
    headers.set('cache-control', 'no-store');
    return new Response(response.body, {status: response.status, headers});
  });
  app.get('/reset.browser.js', (c) => c.body(script, 200, {'content-type': 'text/javascript; charset=utf-8'}));
  return app;
}
