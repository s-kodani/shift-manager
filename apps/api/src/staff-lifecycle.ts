import { z } from "zod";
import { mutation, ProductError, requireManager } from "./product";

export const staffLifecycleInput = mutation.extend({
  status: z.enum(["active", "inactive", "deleted"]),
}).strict();
type Database = Pick<D1Database, "prepare" | "batch">;

export async function changeStaffStatus(db: Database, company: string, team: string,
  staff: string, user: string, data: z.infer<typeof staffLifecycleInput>) {
  const input = staffLifecycleInput.parse(data);
  await requireManager(db, company, team, user);
  const fingerprint = JSON.stringify({ company, team, staff, user, input });
  const replay = async () => {
    const row = await db.prepare("SELECT fingerprint FROM staff_lifecycle_operation WHERE company_id=? AND id=?")
      .bind(company, input.operationId).first<{ fingerprint: string }>();
    if (row && row.fingerprint !== fingerprint) throw new ProductError("OPERATION_ID_CONFLICT");
    return !!row;
  };
  const response = (replayed: boolean) => ({ revision: input.expectedRevision + 1, replayed });
  if (await replay()) return response(true);
  try {
    await db.batch([
      db.prepare(`INSERT INTO staff_lifecycle_operation(company_id,id,team_id,staff_id,actor_id,status,expected_revision,fingerprint)
        VALUES (?,?,?,?,?,?,?,?)`).bind(company,input.operationId,team,staff,user,input.status,input.expectedRevision,fingerprint),
      db.prepare(`INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)`)
        .bind(company,input.operationId,user,"staff:"+input.status,input.expectedRevision+1,Date.now()),
      // Assert every resulting value: a silent zero-row update must roll back
      // the status, access, revision and audit together.
      db.prepare(`SELECT CASE WHEN EXISTS (
        SELECT 1 FROM staff_lifecycle_operation o
        JOIN staff s ON s.company_id=o.company_id AND s.team_id=o.team_id AND s.id=o.staff_id
        JOIN access_state x ON x.user_id=s.user_id JOIN user u ON u.id=s.user_id
        JOIN company c ON c.id=o.company_id JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        WHERE o.company_id=? AND o.id=? AND o.fingerprint=? AND s.status=o.status
          AND x.enabled=CASE WHEN o.status='active' THEN 1 ELSE 0 END
          AND u.banned=CASE WHEN o.status='active' THEN 0 ELSE 1 END
          AND (o.status='active' OR NOT EXISTS(SELECT 1 FROM session WHERE userId=s.user_id))
          AND c.revision=o.expected_revision+1 AND a.actor_id=o.actor_id
          AND a.kind='staff:'||o.status AND a.revision=c.revision
      ) THEN 1 ELSE abs(-9223372036854775808) END AS staff_status_saved`)
        .bind(company,input.operationId,fingerprint),
    ]);
    return response(false);
  } catch (error) {
    if (await replay()) { await requireManager(db,company,team,user); return response(true); }
    const message = String(error);
    if (message.includes("PRODUCT_FORBIDDEN")) throw new ProductError("FORBIDDEN",403);
    if (message.includes("PRODUCT_VERSION_CONFLICT")) throw new ProductError("VERSION_CONFLICT");
    if (message.includes("STAFF_ACCOUNT_PROTECTED")) throw new ProductError("STAFF_ACCOUNT_PROTECTED");
    if (message.includes("STAFF_STATUS_CONFLICT")) throw new ProductError("STAFF_STATUS_CONFLICT");
    if (message.includes("PRODUCT_INVALID_REFERENCE") || message.includes("FOREIGN KEY constraint")) throw new ProductError("INVALID_REFERENCE",400);
    if (message.includes("OPERATION_ID_CONFLICT") || message.includes("UNIQUE constraint")) throw new ProductError("OPERATION_ID_CONFLICT");
    throw error;
  }
}
