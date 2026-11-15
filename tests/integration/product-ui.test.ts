import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { createApp } from "../../apps/api/src/index";
import poc from "../../apps/api/src/poc-worker";
import local from "../../apps/api/src/local-ui-worker";
import { scaledCount, timeline } from "../../apps/web/product/view-model";
import { probeConfig } from "../../apps/api/src/input-probes";
import {
  cancellationOwnerKey,
  readCancellationOwner,
  persistCancellationOwner,
  clearCancellationOwner,
} from "../../apps/web/product/cancellation-owner";
it("cancellation UI preserves an uncertain operation through reload and cannot replace or clear it with another ID", () => {
  const values = new Map<string, string>(),
    store = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => {
        values.set(k, v);
      },
      removeItem: (k: string) => {
        values.delete(k);
      },
    };
  const key = cancellationOwnerKey(crypto.randomUUID(), crypto.randomUUID()),
    command = {
      operationId: crypto.randomUUID(),
      publicationId: crypto.randomUUID(),
      expectedRevision: 12,
      expectedRequestRevision: 1,
      expectedPublicationRevision: 3,
      acknowledgeShortage: true,
    };
  persistCancellationOwner(store, key, command);
  expect(readCancellationOwner(store, key)).toEqual(command);
  expect(() =>
    persistCancellationOwner(store, key, {
      ...command,
      operationId: crypto.randomUUID(),
    }),
  ).toThrow("未確認");
  expect(() => clearCancellationOwner(store, key, crypto.randomUUID())).toThrow(
    "識別",
  );
  expect(readCancellationOwner(store, key)).toEqual(command);
  clearCancellationOwner(store, key, command.operationId);
  expect(readCancellationOwner(store, key)).toBeNull();
  values.set(key, "invalid");
  expect(() => readCancellationOwner(store, key)).toThrow(
    "新しい操作を開始せず",
  );
  expect(() => persistCancellationOwner(store, key, command)).toThrow();
});
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
it("product UI: compiled HTML/assets are explicit, no-store and have no inline script permission", async () => {
  const app = createApp(),
    page = await app.request("/app", {}, env),
    html = await page.text();
  expect(page.status).toBe(200);
  expect(html).toContain('lang="ja"');
  expect(page.headers.get("cache-control")).toBe("no-store");
  expect(page.headers.get("content-security-policy")).toContain(
    "script-src 'self'",
  );
  expect(page.headers.get("content-security-policy")).not.toContain(
    "unsafe-inline",
  );
  const path = html.match(/src="([^"]+\.js)"/)![1];
  expect(path).toMatch(/^\/app-assets\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  const script = await app.request(path, {}, env);
  expect(script.status).toBe(200);
  expect(script.headers.get("x-content-type-options")).toBe("nosniff");
  for (const size of [32, 180, 192]) {
    const iconPath = `/app-assets/assets/app-icon-${size}.png`;
    const icon = await app.request(iconPath, {}, env);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(icon.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await icon.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dimensions = new DataView(bytes.buffer);
    expect(dimensions.getUint32(16)).toBe(size);
    expect(dimensions.getUint32(20)).toBe(size);
    const head = await app.request(iconPath, { method: "HEAD" }, env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  }
  expect(html).toContain('href="/app-assets/assets/app-icon-32.png"');
  expect(html).toContain('href="/app-assets/assets/app-icon-180.png"');
  for (const path of [
    "/index.html",
    "/assets/private.json",
    "/app-assets/assets/secret.json",
    "/app-assets/assets/missing.png",
    "/__local/fixture",
    "/__local/operational-fixture",
    "/__local/operational-check",
  ])
    expect((await app.request(path, {}, env)).status).toBe(404);
});
it("product UI: operational fixture/check remain token-protected and unavailable outside local loopback", async () => {
  for (const path of ["operational-fixture", "operational-check"])
  for(const [url,bindings] of [
    [`http://localhost:8787/__local/${path}`,{...env,ENVIRONMENT:"poc"}],
    [`https://external.invalid/__local/${path}`,{...env,ENVIRONMENT:"local"}],
    [`http://localhost:8787/__local/${path}`,{...env,ENVIRONMENT:"local"}],
  ] as const) {
    expect((await local.fetch(new Request(url,{method:"POST",body:"{}"}),bindings,{} as ExecutionContext)).status).toBe(403);
  }
});
it("product UI: PoC guard prevents app and asset access; local fixture cannot run against a remote environment", async () => {
  for (const path of ["/app", "/app-assets/assets/index-test.js"])
    expect(
      (await poc.fetch(new Request("https://private.invalid" + path), env))
        .status,
    ).toBe(403);
  expect(
    (
      await local.fetch(
        new Request("http://localhost:8787/__local/fixture", {
          method: "POST",
        }),
        { ...env, ENVIRONMENT: "poc" },
        {} as ExecutionContext,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await local.fetch(
        new Request("https://external.invalid/__local/fixture", {
          method: "POST",
        }),
        env,
        {} as ExecutionContext,
      )
    ).status,
  ).toBe(403);
});
it("product UI: direct zero differs from missing; precision is exact and never rounded", () => {
  expect(scaledCount("", 100)).toBeNull();
  expect(scaledCount("0", 100)).toBe(0);
  expect(scaledCount("0.29", 100)).toBe(29);
  expect(scaledCount("1.2", 10)).toBe(12);
  expect(() => scaledCount("0.291", 100)).toThrow("INVALID_PRECISION");
  expect(() => scaledCount("-1", 100)).toThrow();
});
it("product UI/Q125: an event does not reset task continuity; a later switch displays exactly seven preparation minutes", () => {
  const a = {
    staffId: "staff",
    date: "2026-10-01",
    shift: {
      start: 600,
      end: 780,
      workedMinutes: 180,
      break: null,
      cancelled: [],
    },
    blocks: [
      { start: 600, end: 630, taskId: "phone", roleId: null },
      { start: 660, end: 690, taskId: "phone", roleId: null },
      { start: 690, end: 720, taskId: "supervision", roleId: null },
    ],
    roleIntervals: [],
  };
  const input = {
    transitions: probeConfig.transitions,
    events: [
      {
        id: "training",
        date: a.date,
        staffIds: ["staff"],
        start: 630,
        end: 660,
        kind: "training" as const,
      },
    ],
  };
  expect(timeline(a, input)).toEqual([
    { start: 600, end: 630, kind: "task", title: "phone", roleId: null },
    { start: 630, end: 660, kind: "event", title: "研修" },
    { start: 660, end: 690, kind: "task", title: "phone", roleId: null },
    { start: 690, end: 697, kind: "prep", title: "準備・移動" },
    { start: 697, end: 720, kind: "task", title: "supervision", roleId: null },
  ]);
});
it("product UI: a 60-minute logical block is clipped to actual work around a 30-minute break", () => {
  const a = {
    staffId: "staff",
    date: "2026-10-01",
    shift: {
      start: 630,
      end: 720,
      break: [660, 690] as [number, number],
      cancelled: [],
    },
    blocks: [
      { start: 600, end: 660, taskId: "phone", roleId: null },
      { start: 660, end: 720, taskId: "phone", roleId: null },
    ],
  };
  expect(timeline(a, { transitions: [], events: [] })).toEqual([
    { start: 630, end: 660, kind: "task", title: "phone", roleId: null },
    { start: 660, end: 690, kind: "break", title: "休憩" },
    { start: 690, end: 720, kind: "task", title: "phone", roleId: null },
  ]);
});
