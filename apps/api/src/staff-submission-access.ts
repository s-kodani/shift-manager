import { ProductError } from './product';
import type { InputDatabase } from './input-versions';

// Never accept a staff ID from a self-service command.
export async function ownSubmissionStaff(db: InputDatabase, company: string, team: string, user: string) {
  const staff = await db.prepare(`SELECT s.id FROM staff s
    JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
    JOIN access_state a ON a.user_id=s.user_id AND a.enabled=1 AND a.must_change_password=0
    WHERE s.company_id=? AND s.team_id=? AND s.user_id=?`).bind(company, team, user).first<string>('id');
  if (!staff) throw new ProductError('FORBIDDEN', 403);
  return staff;
}
