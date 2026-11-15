import { z } from 'zod';

const commandSchema = z.object({
  id: z.string().min(1), tenant: z.string().min(1), team: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(), inputVersion: z.number().int().nonnegative(),
  kind: z.enum(['publish', 'cancel']), actor: z.string().min(1),
}).strict();
export type AtomicCommand = z.infer<typeof commandSchema>;

// Storage PoC only: caller must perform product validation before invoking this.
// No public publish/cancel API is exposed until the full checker exists.
export async function applyAtomic(db: D1Database, input: AtomicCommand) {
  const c = commandSchema.parse(input);
  const fingerprint = JSON.stringify(c);
  const previous = await db.prepare('SELECT fingerprint FROM operation WHERE id = ?').bind(c.id)
    .first<{ fingerprint: string }>();
  if (previous) return previous.fingerprint === fingerprint ? 'replayed' : 'conflict';
  const statements = [
    db.prepare(`INSERT INTO operation(id, tenant_id, team_id, expected_version, input_version, kind, actor, fingerprint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.id, c.tenant, c.team, c.expectedVersion, c.inputVersion, c.kind, c.actor, fingerprint),
    db.prepare(`INSERT INTO revision(operation_id, before_state)
      SELECT ?, json_object('version', version, 'published', published, 'cancelled', cancelled)
      FROM schedule WHERE tenant_id = ? AND team_id = ?`).bind(c.id, c.tenant, c.team),
    db.prepare(`UPDATE schedule SET version = version + 1,
      published = CASE WHEN ? = 'publish' THEN 1 ELSE published END,
      cancelled = CASE WHEN ? = 'cancel' THEN 1 ELSE cancelled END
      WHERE tenant_id = ? AND team_id = ?`).bind(c.kind, c.kind, c.tenant, c.team),
    db.prepare(`UPDATE participation SET active = 0 WHERE tenant_id = ? AND team_id = ? AND ? = 'cancel'`)
      .bind(c.tenant, c.team, c.kind),
    db.prepare('INSERT INTO audit(operation_id, actor) VALUES (?, ?)').bind(c.id, c.actor),
    db.prepare('INSERT INTO outbox(operation_id, kind) VALUES (?, ?)').bind(c.id, c.kind),
  ];
  try {
    await db.batch(statements);
    return 'applied';
  } catch (error) {
    // Concurrent identical retries may race past the initial read.
    const committed = await db.prepare('SELECT fingerprint FROM operation WHERE id = ?').bind(c.id)
      .first<{ fingerprint: string }>();
    if (committed) return committed.fingerprint === fingerprint ? 'replayed' : 'conflict';
    if (String(error).includes('VERSION_CONFLICT')) return 'conflict';
    throw error;
  }
}
