import { storedCompanyPolicy, employmentPolicy } from "./input-contracts";
import {
  inputMonth,
  resolveVersion,
  type InputDatabase,
} from "./input-versions";
import { calendarSettings, ProductError, requireManager } from "./product";

// Team managers may read company-wide contract choices, but their mutation
// routes and SQL guards remain restricted to company administrators.
export async function contractOptions(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  month: string,
) {
  inputMonth.parse(month);
  await requireManager(db, company, team, user);
  const revision = await db
    .prepare("SELECT revision FROM company WHERE id=?")
    .bind(company)
    .first<number>("revision");
  const policy = await resolveVersion(
    db,
    company,
    "company_policy",
    company,
    month,
  );
  const rows = await db
    .prepare(
      `SELECT entity_id,operation_id,effective_from,revision,payload FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY entity_id ORDER BY effective_from DESC,revision DESC) position
    FROM work_input_version WHERE company_id=? AND kind='employment_policy' AND effective_from<=?
  ) WHERE position=1 ORDER BY entity_id`,
    )
    .bind(company, month)
    .all<{
      entity_id: string;
      operation_id: string;
      effective_from: string;
      revision: number;
      payload: string;
    }>();
  const calendar = await db
    .prepare(
      `SELECT payload FROM calendar_settings_version
    WHERE company_id=? AND effective_from<=? ORDER BY effective_from DESC,revision DESC LIMIT 1`,
    )
    .bind(company, month)
    .first<{ payload: string }>();
  await requireManager(db, company, team, user);
  if (
    revision !==
    (await db
      .prepare("SELECT revision FROM company WHERE id=?")
      .bind(company)
      .first<number>("revision"))
  )
    throw new ProductError("VERSION_CONFLICT");
  return {
    revision,
    policy: policy
      ? storedCompanyPolicy.parse(JSON.parse(policy.payload))
      : null,
    roleRounding: calendar
      ? calendarSettings.parse(JSON.parse(calendar.payload)).roleRounding
      : null,
    employment: rows.results.map((row) => ({
      id: row.entity_id,
      version: row.operation_id,
      effectiveFrom: row.effective_from,
      revision: row.revision,
      payload: employmentPolicy.parse(JSON.parse(row.payload)),
    })),
  };
}
