import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { runCsvAssetProbes } from "../../apps/api/src/csv-asset-probes";
import poc from "../../apps/api/src/poc-worker";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

it("private CSV/assets probe exercises authenticated API, exact D1/R2 data and disables all fixture credentials", async () => {
  const report = await runCsvAssetProbes({ ...env, ENVIRONMENT: "poc" });
  expect(report.results).toHaveLength(7);
  expect(report.results.every((r) => r.passed)).toBe(true);
  expect(report.assets).toHaveLength(3);
  expect(
    report.assets.every((a) => a.bytes > 0 && /^[a-f0-9]{64}$/.test(a.sha256)),
  ).toBe(true);
  expect(report.cleanup).toEqual({ enabled: 0, sessions: 0, passwords: 0 });
  // Business entry does not expose the PoC, and public PoC GET remains private.
  expect(
    (
      await poc.fetch(
        new Request("https://private.invalid/__poc/csv-assets"),
        env,
      )
    ).status,
  ).toBe(403);
  await expect(
    runCsvAssetProbes({ ...env, ENVIRONMENT: "local" }),
  ).rejects.toThrow("FORBIDDEN");
});

it("failed R2 snapshot write cleans credentials after valid CSV rows have committed", async () => {
  const receipts = (await env.DB.prepare(
    "SELECT count(*) AS n FROM demand_csv_receipt",
  ).first<number>("n"))!;
  const snapshots = await env.DB.prepare(
    "SELECT count(*) AS n FROM input_snapshot",
  ).first<number>("n");
  const bucket = new Proxy(env.INPUTS, {
    get(target, key) {
      if (key === "put")
        return () => Promise.reject(new Error("INJECTED_R2_WRITE_FAILURE"));
      const value = Reflect.get(target, key, target);
      return typeof value === "function" && key !== "constructor"
        ? value.bind(target)
        : value;
    },
  });
  await expect(
    runCsvAssetProbes({ ...env, ENVIRONMENT: "poc", INPUTS: bucket }),
  ).rejects.toThrow("/snapshots:500");
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM demand_csv_receipt").first(
      "n",
    ),
  ).toBe(receipts + 1);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM input_snapshot").first("n"),
  ).toBe(snapshots);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM access_state WHERE enabled=1",
    ).first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM session").first("n"),
  ).toBe(0);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM account WHERE password IS NOT NULL",
    ).first("n"),
  ).toBe(0);
});
