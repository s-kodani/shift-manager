import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { runAuthProbes, runD1Probes } from '../../apps/api/src/poc-probes';
import { runProductProbes } from '../../apps/api/src/product-probes';
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
it('remote D1 probe runner is executable on the same workerd/D1 binding', async () => {
  expect((await runD1Probes(env.DB)).every(r => r.passed)).toBe(true);
});
it('remote auth probe runner handles session rotation and reset with native D1', async () => {
  expect((await runAuthProbes(env)).every(r => r.passed)).toBe(true);
});
it('remote product probe runner verifies product provisioning and disables all generated accounts', async () => {
  expect((await runProductProbes(env)).every((r) => r.passed)).toBe(true);
  expect(await env.DB.prepare(`SELECT count(*) n FROM access_state a JOIN company_admin m ON m.user_id=a.user_id WHERE a.enabled=1`).first('n')).toBe(0);
  expect(await env.DB.prepare(`SELECT count(*) n FROM access_state a JOIN staff s ON s.user_id=a.user_id WHERE a.enabled=1`).first('n')).toBe(0);
});
