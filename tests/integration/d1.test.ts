import { env, applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, expect, it } from 'vitest';
import { applyAtomic, type AtomicCommand } from '../../apps/api/src/atomic';

beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  await env.DB.batch(['outbox', 'audit', 'revision', 'operation', 'participation', 'schedule']
    .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.DB.prepare("INSERT INTO schedule VALUES ('fake-a','fake-team',1,1,0,0)").run();
  await env.DB.prepare("INSERT INTO participation VALUES ('fake-a','fake-team',1)").run();
});
const command = (id: string, kind: 'publish' | 'cancel' = 'cancel'): AtomicCommand => ({
  id, kind, tenant: 'fake-a', team: 'fake-team', expectedVersion: 1, inputVersion: 1, actor: 'fake-admin',
});
const state = () => env.DB.prepare('SELECT * FROM schedule').first();

it('STACK-02: zero-row conditional UPDATE succeeds; later SQL still runs without a guard', async () => {
  const r = await env.DB.batch([
    env.DB.prepare('UPDATE schedule SET version = 99 WHERE version = 42'),
    env.DB.prepare('UPDATE participation SET active = 0'),
  ]);
  expect(r[0].success).toBe(true);
  expect(r[0].meta.changes).toBe(0);
  expect(await env.DB.prepare('SELECT active FROM participation').first('active')).toBe(0);
});
it('STACK-02: cancellation, participation, revision, audit, outbox commit together; retry is idempotent', async () => {
  expect(await applyAtomic(env.DB, command('one'))).toBe('applied');
  expect(await applyAtomic(env.DB, command('one'))).toBe('replayed');
  expect(await state()).toMatchObject({ version: 2, cancelled: 1 });
  expect(await env.DB.prepare('SELECT active FROM participation').first('active')).toBe(0);
  for (const table of ['revision', 'audit', 'outbox']) {
    expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(1);
  }
});
it('STACK-02: old versions and cross-company identifiers leave no side effects', async () => {
  expect(await applyAtomic(env.DB, { ...command('old'), inputVersion: 0 })).toBe('conflict');
  expect(await applyAtomic(env.DB, { ...command('wrong'), expectedVersion: 0 })).toBe('conflict');
  expect(await applyAtomic(env.DB, { ...command('other'), tenant: 'fake-b' })).toBe('conflict');
  expect(await state()).toMatchObject({ version: 1, cancelled: 0 });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM operation').first('n')).toBe(0);
});
it('STACK-02: parallel publish/cancel allows exactly one writer', async () => {
  const results = await Promise.all([applyAtomic(env.DB, command('publish', 'publish')), applyAtomic(env.DB, command('cancel'))]);
  expect(results.sort()).toEqual(['applied', 'conflict']);
  expect(await state()).toMatchObject({ version: 2 });
  expect(await env.DB.prepare('SELECT count(*) AS n FROM outbox').first('n')).toBe(1);
});
it('STACK-02: final SQL failure rolls back every preceding write', async () => {
  await env.DB.prepare("CREATE TRIGGER inject_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'INJECTED_FAILURE'); END").run();
  try {
    await expect(applyAtomic(env.DB, command('failure'))).rejects.toThrow('INJECTED_FAILURE');
    expect(await state()).toMatchObject({ version: 1, cancelled: 0 });
    expect(await env.DB.prepare('SELECT active FROM participation').first('active')).toBe(1);
    for (const table of ['operation', 'revision', 'audit', 'outbox']) {
      expect(await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
    }
  } finally { await env.DB.prepare('DROP TRIGGER inject_failure').run(); }
});
it('STACK-02: repeated ID with changed payload is rejected', async () => {
  await applyAtomic(env.DB, command('same'));
  expect(await applyAtomic(env.DB, command('same', 'publish'))).toBe('conflict');
});
