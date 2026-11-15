import { Hono } from "hono";
import type { ApiEnv } from "./product";
const policy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export function appPages() {
  const app = new Hono<ApiEnv>();
  app.on(["GET", "HEAD"], ["/app", "/app-assets/assets/:file"], async (c) => {
    const path =
      c.req.path === "/app"
        ? "/index.html"
        : c.req.path.slice("/app-assets".length);
    if (
      path !== "/index.html" &&
      !/^\/assets\/[A-Za-z0-9_.-]+\.(js|css|png)$/.test(path)
    )
      return c.notFound();
    const url = new URL(c.req.url);
    url.pathname = path;
    url.search = "";
    const response = await c.env.ASSETS.fetch(
      new Request(url, { method: c.req.method }),
    );
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("content-security-policy", policy);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-robots-tag", "noindex, nofollow");
    headers.set(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    return new Response(response.body, { status: response.status, headers });
  });
  return app;
}
