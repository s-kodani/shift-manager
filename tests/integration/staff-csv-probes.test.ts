import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { runStaffCsvProbes, inspectStaffCsvProbe, cleanupStaffCsvProbe } from "../../apps/api/src/staff-csv-probes";
import { inputFixture } from "../../apps/api/src/input-probes";
import poc from "../../apps/api/src/poc-worker";

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
const bindings = () => ({ ...env, ENVIRONMENT: "poc" });
it("private staff CSV probe checks real auth, D1 rollback and concurrent API delivery, R2 lineage, then prevents reuse", async () => {
  const probeId = crypto.randomUUID(), report = await runStaffCsvProbes(bindings(), { probeId, mode: "suite" });
  expect(report.results).toHaveLength(9);
  expect(report.results.every(r => r.passed)).toBe(true);
  expect(report.importedRows).toBe(2);
  expect(report.cleanup).toMatchObject({ probeId, enabled: 0, sessions: 0, passwords: 0, receipts: 3 });
  await expect(runStaffCsvProbes(bindings(), { probeId, mode: "suite" })).rejects.toThrow("PROBE_ALREADY_EXISTS");
  expect(await cleanupStaffCsvProbe(bindings(), probeId)).toEqual(await inspectStaffCsvProbe(bindings(), probeId));
  for (const path of ["staff-csv", "staff-csv-status", "staff-csv-cleanup"]) {
    expect((await poc.fetch(new Request(`https://private.invalid/__poc/${path}`, { method: "POST", body: JSON.stringify({ probeId }) }), env)).status).toBe(403);
  }
  await expect(runStaffCsvProbes({ ...env, ENVIRONMENT: "local" }, { probeId: crypto.randomUUID(), mode: "suite" })).rejects.toThrow("FORBIDDEN");
});
it("100 new rows use the product API and leave no active owned credentials", async () => {
  const report = await runStaffCsvProbes(bindings(), { probeId: crypto.randomUUID(), mode: "capacity" });
  expect(report.importedRows).toBe(100);
  expect(report.results).toHaveLength(2);
  expect(report.cleanup).toMatchObject({ enabled: 0, sessions: 0, passwords: 0, receipts: 1 });
  expect(report.applyMilliseconds).toBeGreaterThan(0);
}, 60000);
it("failure after committed imports cleans only the owned probe; an unrelated tenant retains access", async () => {
  const unrelated = await inputFixture(env.DB, env.INPUTS), probeId = crypto.randomUUID();
  const bucket = new Proxy(env.INPUTS, { get(target, key) {
    if (key === "put") return () => Promise.reject(new Error("INJECTED_R2_WRITE_FAILURE"));
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  await expect(runStaffCsvProbes({ ...bindings(), INPUTS: bucket }, { probeId, mode: "suite" })).rejects.toThrow("INJECTED_R2_WRITE_FAILURE");
  expect(await inspectStaffCsvProbe(bindings(), probeId)).toMatchObject({ enabled: 0, sessions: 0, passwords: 0, receipts: 3 });
  expect(await env.DB.prepare("SELECT enabled FROM access_state WHERE user_id=?").bind(unrelated.company.userId).first("enabled")).toBe(1);
  expect(await env.DB.prepare("SELECT password FROM account WHERE userId=?").bind(unrelated.company.userId).first("password")).not.toBeNull();
});
it("authenticated observation requires a bounded UUID command and keeps errors private and uncacheable", async () => {
  const post = (path: string, body: string) => poc.fetch(new Request("https://private.invalid/__poc/" + path, { method: "POST", headers: { authorization: `Bearer ${env.POC_TOKEN}` }, body }), bindings() as Cloudflare.PocEnv);
  for (const [body, status] of [["{}", 400], ["not-json", 400], ["x".repeat(1025), 413]] as const) {
    const r = await post("staff-csv-status", body);
    expect(r.status).toBe(status); expect(r.headers.get("cache-control")).toBe("no-store");
  }
  const probeId = crypto.randomUUID(), r = await post("staff-csv-status", JSON.stringify({ probeId }));
  expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ probeId, companies: [], enabled: 0, sessions: 0, passwords: 0 });
});
