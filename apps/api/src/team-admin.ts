import { z } from "zod";
import { grantInput, ProductError, requireManager } from "./product";

type Database = Pick<D1Database, "prepare" | "batch">;

export async function revokeTeamAdmin(
  db: Database,
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof grantInput>,
) {
  const input = grantInput.parse(data);
  await requireManager(db, company, null, user);
  const fingerprint = JSON.stringify({
    user,
    team,
    kind: "revoke_team_admin",
    input,
  });
  const replay = async () => {
    const rows = await db
      .prepare(
        `SELECT fingerprint FROM team_admin_revocation WHERE company_id=? AND id=?
      UNION ALL SELECT fingerprint FROM product_operation WHERE company_id=? AND id=?`,
      )
      .bind(company, input.operationId, company, input.operationId)
      .all<{ fingerprint: string }>();
    if (rows.results.some((row) => row.fingerprint !== fingerprint))
      throw new ProductError("OPERATION_ID_CONFLICT");
    return rows.results.length > 0;
  };
  const response = (replayed: boolean) => ({
    revision: input.expectedRevision + 1,
    replayed,
  });
  if (await replay()) return response(true);
  try {
    // The trigger checks live authorization, target membership and revision
    // inside this same batch, then applies the role/revision. Audit failure
    // rolls back the command and both updates as well.
    await db.batch([
      db
        .prepare(
          `INSERT INTO team_admin_revocation(company_id,id,actor_id,team_id,target_user_id,expected_revision,fingerprint)
        VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          company,
          input.operationId,
          user,
          team,
          input.userId,
          input.expectedRevision,
          fingerprint,
        ),
      db
        .prepare(
          `INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at)
        VALUES (?,?,?,'revoke_team_admin',?,?)`,
        )
        .bind(
          company,
          input.operationId,
          user,
          input.expectedRevision + 1,
          Date.now(),
        ),
      db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM team_admin_revocation r
        JOIN company c ON c.id=r.company_id JOIN product_audit a ON a.company_id=r.company_id AND a.id=r.id
        JOIN team_member m ON m.company_id=r.company_id AND m.team_id=r.team_id AND m.user_id=r.target_user_id
        WHERE r.company_id=? AND r.id=? AND r.team_id=? AND r.actor_id=? AND r.target_user_id=?
          AND r.expected_revision=? AND r.fingerprint=? AND c.revision=r.expected_revision+1 AND m.role='staff'
          AND a.kind='revoke_team_admin' AND a.actor_id=r.actor_id AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS revocation_saved`)
        .bind(company,input.operationId,team,user,input.userId,input.expectedRevision,fingerprint),
    ]);
    return response(false);
  } catch (error) {
    if (await replay()) {
      await requireManager(db, company, null, user);
      return response(true);
    }
    const message = String(error);
    if (message.includes("PRODUCT_FORBIDDEN"))
      throw new ProductError("FORBIDDEN", 403);
    if (message.includes("PRODUCT_VERSION_CONFLICT"))
      throw new ProductError("VERSION_CONFLICT");
    if (
      message.includes("PRODUCT_INVALID_REFERENCE") ||
      message.includes("FOREIGN KEY constraint")
    )
      throw new ProductError("INVALID_REFERENCE", 400);
    if (message.includes("UNIQUE constraint"))
      throw new ProductError("OPERATION_ID_CONFLICT");
    throw error;
  }
}
