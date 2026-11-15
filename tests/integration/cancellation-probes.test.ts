import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import {
  runCancellationProbe,
  inspectCancellationProbe,
  cleanupExpiredCancellationProbes,
} from "../../apps/api/src/cancellation-probes";
import { inputFixture } from "../../apps/api/src/input-probes";
import { cancelJob } from "../../apps/api/src/compute-jobs";
import poc from "../../apps/api/src/poc-worker";
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
function bindings() {
  return {
    ...env,
    ENVIRONMENT: "poc",
    COMPUTE_QUEUE: { send: async () => {} },
    SOLVER: {
      getByName: () => ({
        executionState: async () => ({
          activeRpc: false,
          persistedFence: false,
          persistedCheckFence: false,
          processRunning: false,
        }),
      }),
    },
  } as unknown as Env;
}
const command = () => ({
  probeId: crypto.randomUUID(),
  action: "start" as const,
  adminPassword: "Fictional-" + crypto.randomUUID() + "-Aa1!",
  staffPassword: "Fictional-" + crypto.randomUUID() + "-Aa1!",
});
it("remote cancellation ownership precedes dispatch; phase, job, auth and immutable IDs remain observable; active jobs block scoped cleanup", async () => {
  const b = bindings(),
    c = command(),
    r = await runCancellationProbe(b, c);
  expect(r.stage).toBe("INITIAL_QUEUED");
  expect(r.jobs).toHaveLength(1);
  expect(r.results).toEqual([
    { name: "native_initial_password_gates_and_changes", passed: true },
  ]);
  expect(r).not.toHaveProperty("adminPassword");
  expect(r).not.toHaveProperty("staffPassword");
  await expect(runCancellationProbe(b, c)).rejects.toThrow(
    "PROBE_ALREADY_EXISTS",
  );
  await expect(
    runCancellationProbe(b, { ...c, action: "cleanup" }),
  ).rejects.toThrow("PROBE_BUSY");
  await expect(
    runCancellationProbe(b, { ...c, action: "publish" }),
  ).rejects.toThrow("PROBE_JOB_NOT_READY");
  expect((await inspectCancellationProbe(b, c.probeId)).busy).toBe(false);
  const o = await env.DB.prepare("SELECT * FROM cancellation_probe WHERE id=?")
    .bind(c.probeId)
    .first<{
      company_id: string;
      team_id: string;
      admin_user_id: string;
      metadata: string;
    }>();
  const ids = JSON.parse(o!.metadata).ids;
  await cancelJob(
    env.DB,
    o!.company_id,
    o!.team_id,
    o!.admin_user_id,
    ids.job,
    { operationId: crypto.randomUUID(), expectedAttempt: 0 },
  );
  const cleaned = await runCancellationProbe(b, {
    probeId: c.probeId,
    action: "cleanup",
  });
  expect(cleaned).toMatchObject({
    cleaned: true,
    credentials: { enabled: 0, sessions: 0, passwords: 0 },
  });
  expect((await inspectCancellationProbe(b, c.probeId)).jobs).toHaveLength(1);
});
it("an incomplete owned preparation can be cleaned without touching an unrelated company; a live phase lease cannot be swept", async () => {
  const unrelated = await inputFixture(env.DB, env.INPUTS),
    b = bindings(),
    c = command();
  const failed = new Proxy(env.INPUTS, {
    get(target, key) {
      if (key === "put") return () => Promise.reject(Error("OWNED_R2_FAILURE"));
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await expect(
    runCancellationProbe({ ...b, INPUTS: failed }, c),
  ).rejects.toThrow("OWNED_R2_FAILURE");
  const r = await inspectCancellationProbe(b, c.probeId);
  expect(r.busy).toBe(false);
  expect(r.stage).toBe("PREPARING");
  await env.DB.prepare(
    "UPDATE cancellation_probe SET expires_at=0,lease=? WHERE id=?",
  )
    .bind(crypto.randomUUID(), c.probeId)
    .run();
  await cleanupExpiredCancellationProbes(b);
  expect((await inspectCancellationProbe(b, c.probeId)).cleaned).toBe(false);
  await env.DB.prepare("UPDATE cancellation_probe SET lease=NULL WHERE id=?")
    .bind(c.probeId)
    .run();
  expect(
    await runCancellationProbe(b, { probeId: c.probeId, action: "cleanup" }),
  ).toMatchObject({
    cleaned: true,
    credentials: { enabled: 0, sessions: 0, passwords: 0 },
  });
  expect(
    await env.DB.prepare("SELECT enabled FROM access_state WHERE user_id=?")
      .bind(unrelated.company.userId)
      .first("enabled"),
  ).toBe(1);
});
it("private cancellation surface bounds input, validates commands, refuses product mode and retains bearer protection", async () => {
  const b = bindings() as Cloudflare.PocEnv;
  expect(
    (
      await poc.fetch(
        new Request("https://private.invalid/__poc/cancellation", {
          method: "POST",
          body: "{}",
        }),
        b,
      )
    ).status,
  ).toBe(403);
  for (const [body, status] of [
    ["{}", 400],
    ["invalid", 400],
    ["x".repeat(2049), 413],
  ] as const) {
    const r = await poc.fetch(
      new Request("https://private.invalid/__poc/cancellation", {
        method: "POST",
        headers: { authorization: "Bearer " + env.POC_TOKEN },
        body,
      }),
      b,
    );
    expect(r.status).toBe(status);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
  await expect(runCancellationProbe(env, command())).rejects.toThrow(
    "FORBIDDEN",
  );
  expect(
    (
      await poc.fetch(
        new Request("https://private.invalid/__poc/cancellation", {
          headers: { authorization: "Bearer " + env.POC_TOKEN },
        }),
        b,
      )
    ).status,
  ).toBe(404);
});
