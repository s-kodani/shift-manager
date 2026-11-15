import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

describe('dependency security boundaries', () => {
  it('runs API wildcard middleware for encoded line terminators and ordinary paths', async () => {
    const app = new Hono();
    let calls = 0;
    app.use('/api/*', async (c, next) => {
      calls++;
      if (c.req.header('x-test-authorized') !== 'yes') return c.text('denied', 401);
      await next();
    });
    app.get('/api/resource/:id', c => c.text(c.req.param('id')));
    for (const value of ['sentinel', '%0A', '%0D', '%E2%80%A8', '%E2%80%A9']) {
      calls = 0;
      expect((await app.request('/api/missing/' + value)).status).toBe(401);
      expect(calls).toBe(1);
    }
    const valid = await app.request('/api/resource/legitimate', { headers: { 'x-test-authorized': 'yes' } });
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe('legitimate');
  });

  it('rejects oversized collections before validating each element', () => {
    let visited = 0;
    const schema = z.array(z.number().superRefine(() => { visited++; })).max(2);
    expect(schema.safeParse([1, 2]).success).toBe(true);
    expect(visited).toBe(2);
    visited = 0;
    const oversized = schema.safeParse([1, 2, 3, 4, 5]);
    expect(oversized.success).toBe(false);
    expect(oversized.error?.issues[0]?.code).toBe('too_big');
    expect(visited).toBe(0);
  });
});
