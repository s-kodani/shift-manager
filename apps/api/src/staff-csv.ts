import { z } from "zod";
import { CsvError, parseCsv } from "./csv";
import {
  credentials,
  createStaffInput,
  ProductError,
  requireManager,
} from "./product";
import { contractOptions } from "./input-catalogs";
import { staffContract, storedTeamConfig } from "./input-contracts";
import {
  requiredVersion,
  resolveVersion,
  validateResourcePayload,
  type InputDatabase,
} from "./input-versions";
import { sha256 } from "./input-snapshots";
import {
  staffCsvColumns,
  staffCsvCommand,
  staffCsvApply,
  staffCsvPreview,
  staffCsvReceipt,
  type StaffCsvPreview,
  type StaffCsvReceipt,
} from "./staff-csv-contract";

const hash = (v: unknown) =>
  sha256(new TextEncoder().encode(JSON.stringify(v)));
const time = (s: string) => {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/.test(s))
    throw new ProductError("CSV_INVALID_TIME", 400);
  const [h, m] = s.split(":").map(Number);
  if (m % 30 !== 0) throw new ProductError("CSV_TIME_NOT_ALIGNED", 400);
  return h * 60 + m;
};
const integer = (s: string) => {
  if (!/^\d{1,6}$/.test(s)) throw new ProductError("CSV_INVALID_INTEGER", 400);
  return Number(s);
};
type StaffRow = {
  id: string;
  team_id: string;
  staff_number: string;
  user_id: string;
  email: string;
  name: string;
  shared: number;
  status: string;
};
const fingerprint = (
  company: string,
  team: string,
  user: string,
  c: z.infer<typeof staffCsvApply>,
  csvSha256: string,
) =>
  JSON.stringify({
    company,
    team,
    user,
    month: c.month,
    expectedRevision: c.expectedRevision,
    csvSha256,
    previewSha256: c.previewSha256,
  });

export async function buildStaffCsvPreview(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  value: z.infer<typeof staffCsvCommand>,
) {
  const c = staffCsvCommand.parse(value);
  await requireManager(db, company, team, user);
  const records = parseCsv(c.csv),
    header = records.shift();
  if (!header) throw new ProductError("CSV_EMPTY", 400);
  const names = header.cells.map((x) => x.trim());
  if (
    names.length !== staffCsvColumns.length ||
    new Set(names).size !== names.length ||
    staffCsvColumns.some((x) => !names.includes(x))
  )
    throw new CsvError("CSV_INVALID_HEADER", header.line, 1);
  if (!records.length) throw new ProductError("CSV_EMPTY_ROWS", 400);
  if (records.length > 100)
    throw new ProductError("STAFF_CSV_TOO_MANY_ROWS", 400);
  const indexes = Object.fromEntries(names.map((v, i) => [v, i]));
  const options = await contractOptions(db, company, team, user, c.month);
  if (options.revision !== c.expectedRevision)
    throw new ProductError("VERSION_CONFLICT");
  if (!options.policy) throw new ProductError("INPUT_NOT_CONFIGURED", 400);
  const configRow = requiredVersion(
    await resolveVersion(db, company, "team_config", team, c.month),
  );
  const config = storedTeamConfig.parse(JSON.parse(configRow.payload));
  const people = (
    await db
      .prepare(
        `SELECT s.id,s.team_id,s.staff_number,s.user_id,u.email,s.name,s.status,
 EXISTS(SELECT 1 FROM team_member m WHERE m.user_id=s.user_id AND (m.company_id!=s.company_id OR m.team_id!=s.team_id))
 OR EXISTS(SELECT 1 FROM company_admin a WHERE a.user_id=s.user_id AND a.company_id!=s.company_id) AS shared
 FROM staff s JOIN user u ON u.id=s.user_id WHERE s.company_id=?`,
      )
      .bind(company)
      .all<StaffRow>()
  ).results;
  const existing = new Map(people.map((p) => [p.staff_number, p]));
  const proposedEmails = records.map(
    (r) => r.cells[indexes.email]?.trim().toLowerCase() ?? "",
  );
  const owners = (
    await db
      .prepare(
        "SELECT id,email FROM user WHERE lower(email) IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(proposedEmails))
      .all<{ id: string; email: string }>()
  ).results;
  const emails = new Map(owners.map((o) => [o.email.toLowerCase(), o.id]));
  const numbers: string[] = [],
    emailValues: string[] = [];
  const rows: StaffCsvPreview["rows"] = records.map((r) => {
    const errors: StaffCsvPreview["rows"][number]["errors"] = [];
    const read = (key: (typeof staffCsvColumns)[number]) =>
      r.cells[indexes[key]]?.trim() ?? "";
    const staffNumber = read("staff_number"),
      email = read("email").toLowerCase();
    numbers.push(staffNumber);
    emailValues.push(email);
    if (r.cells.length !== names.length)
      return {
        line: r.line,
        person: null,
        action: null,
        errors: [{ column: "row", code: "CSV_COLUMN_COUNT" }],
      };
    const parse = <T>(column: string, fn: () => T): T | null => {
      try {
        return fn();
      } catch (e) {
        errors.push({
          column,
          code: e instanceof ProductError ? e.code : "INVALID_INPUT",
        });
        return null;
      }
    };
    const name = read("name");
    parse("staff_number", () =>
      createStaffInput.shape.staffNumber.parse(staffNumber),
    );
    parse("name", () => createStaffInput.shape.name.parse(name));
    parse("email", () => createStaffInput.shape.email.parse(email));
    const old = existing.get(staffNumber);
    if (old?.status === "deleted")
      errors.push({ column: "staff_number", code: "STAFF_DELETED" });
    if (old && old.team_id !== team)
      errors.push({ column: "staff_number", code: "STAFF_OUTSIDE_TEAM" });
    if (old?.shared)
      errors.push({
        column: "staff_number",
        code: "SHARED_ACCOUNT_REQUIRES_REVIEW",
      });
    if (emails.has(email) && emails.get(email) !== old?.user_id)
      errors.push({ column: "email", code: "EMAIL_IN_USE" });
    const start = parse("start", () => time(read("start"))),
      end = parse("end", () => time(read("end")));
    const weekdays = parse("weekdays", () =>
      read("weekdays").split(";").map(integer),
    );
    const keys = [
      ["daily_max", "dailyMax"],
      ["weekly_max", "weeklyMax"],
      ["monthly_min", "monthlyMin"],
      ["monthly_max", "monthlyMax"],
      ["min_days", "minDays"],
      ["min_off", "minOff"],
      ["max_consecutive", "maxConsecutive"],
    ] as const;
    const hasRule = keys.some(([key]) => read(key) !== "");
    const rule = hasRule
      ? Object.fromEntries(
          keys.map(([key, target]) => [
            target,
            parse(key, () => integer(read(key))),
          ]),
        )
      : null;
    const skills = parse("skills", () => JSON.parse(read("skills")) as unknown);
    const roleIds = parse(
      "role_ids",
      () => JSON.parse(read("role_ids")) as unknown,
    );
    const profile =
      start === null || end === null || weekdays === null
        ? null
        : parse("contract", () =>
            staffContract.parse({
              employmentTypeId: read("employment_type_id"),
              contract: { weekdays, start, end },
              rule,
              skills,
              roleIds,
            }),
          );
    if (profile) {
      const employment = options.employment.find(
        (e) => e.id === profile.employmentTypeId,
      );
      if (!employment)
        errors.push({
          column: "employment_type_id",
          code: "UNKNOWN_EMPLOYMENT_TYPE",
        });
      else
        parse("contract", () =>
          validateResourcePayload(
            {
              company,
              team,
              staff: old?.id ?? null,
              kind: "staff_contract",
              entity: old?.id ?? team,
            },
            c.month,
            profile,
            { policy: options.policy, config, employment: employment.payload },
          ),
        );
    }
    return {
      line: r.line,
      person: profile ? { staffNumber, name, email, profile } : null,
      action: old ? "UPDATE" : "ADD",
      errors,
    };
  });
  for (const [values, column, code] of [
    [numbers, "staff_number", "DUPLICATE_STAFF_NUMBER"],
    [emailValues, "email", "DUPLICATE_EMAIL"],
  ] as const) {
    const counts = new Map<string, number>();
    for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    rows.forEach((r, i) => {
      if ((counts.get(values[i]) ?? 0) > 1) r.errors.push({ column, code });
    });
  }
  for (const row of rows)
    if (row.errors.length) {
      row.person = null;
      row.action = null;
    }
  const csvSha256 = await sha256(new TextEncoder().encode(c.csv));
  const previewSha256 = await hash({
    company,
    team,
    user,
    csvSha256,
    month: c.month,
    revision: c.expectedRevision,
    configVersion: configRow.operation_id,
    employment: options.employment.map((e) => e.version),
    rows,
    identities: rows.map((r) =>
      r.person ? (existing.get(r.person.staffNumber) ?? null) : null,
    ),
  });
  await requireManager(db, company, team, user);
  if (
    c.expectedRevision !==
    (await db
      .prepare("SELECT revision FROM company WHERE id=?")
      .bind(company)
      .first<number>("revision"))
  )
    throw new ProductError("VERSION_CONFLICT");
  return {
    preview: staffCsvPreview.parse({
      month: c.month,
      inputRevision: c.expectedRevision,
      csvSha256,
      previewSha256,
      added: rows.filter((r) => r.action === "ADD").length,
      updated: rows.filter((r) => r.action === "UPDATE").length,
      rows,
    }),
    existing,
  };
}

export async function readStaffCsvReceipt(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  id: string,
  replayed = false,
) {
  await requireManager(db, company, team, user);
  const row = await db
    .prepare(
      "SELECT r.payload FROM staff_csv_receipt r JOIN staff_csv_operation o ON o.company_id=r.company_id AND o.id=r.operation_id WHERE r.company_id=? AND r.operation_id=? AND o.team_id=?",
    )
    .bind(company, id, team)
    .first<string>("payload");
  if (!row) throw new ProductError("NOT_FOUND", 404);
  await requireManager(db, company, team, user);
  return staffCsvReceipt.parse({ ...JSON.parse(row), replayed });
}
async function replay(
  db: InputDatabase,
  company: string,
  id: string,
  fp: string,
) {
  const old = await db
    .prepare(
      "SELECT fingerprint FROM staff_csv_operation WHERE company_id=? AND id=?",
    )
    .bind(company, id)
    .first<string>("fingerprint");
  if (old !== null && old !== fp)
    throw new ProductError("OPERATION_ID_CONFLICT");
  return old !== null;
}
export async function applyStaffCsv(
  db: InputDatabase,
  company: string,
  team: string,
  user: string,
  value: z.infer<typeof staffCsvApply>,
) {
  const c = staffCsvApply.parse(value);
  await requireManager(db, company, team, user);
  const csvSha = await sha256(new TextEncoder().encode(c.csv)),
    fp = fingerprint(company, team, user, c, csvSha);
  const prior = async () => ({
    receipt: await readStaffCsvReceipt(
      db,
      company,
      team,
      user,
      c.operationId,
      true,
    ),
    initialPasswords: [],
  });
  if (await replay(db, company, c.operationId, fp)) return prior();
  let built: Awaited<ReturnType<typeof buildStaffCsvPreview>>;
  try {
    built = await buildStaffCsvPreview(db, company, team, user, {
      month: c.month,
      expectedRevision: c.expectedRevision,
      csv: c.csv,
    });
  } catch (e) {
    if (await replay(db, company, c.operationId, fp)) return prior();
    throw e;
  }
  if (built.preview.previewSha256 !== c.previewSha256)
    throw new ProductError("CSV_PREVIEW_CHANGED");
  const valid = built.preview.rows.filter((r) => r.person && r.action);
  if (!valid.length) throw new ProductError("CSV_NO_VALID_ROWS", 400);
  const rows: StaffCsvReceipt["rows"] = [],
    initialPasswords: { staffNumber: string; initialPassword: string }[] = [],
    statements: D1PreparedStatement[] = [],
    expectedPeople: {staffId:string;userId:string;staffNumber:string;name:string;email:string;contractVersion:string;revision:number;profile:string;created:boolean;emailChanged:boolean}[] = [];
  const now = new Date().toISOString();
  for (const [i, row] of valid.entries()) {
    const person = row.person!,
      old = built.existing.get(person.staffNumber),
      staffId = old?.id ?? crypto.randomUUID(),
      contractVersion = crypto.randomUUID(),
      expected = c.expectedRevision + 1 + i;
    let userId = old?.user_id;
    if (old) {
      statements.push(
        db
          .prepare(
            "UPDATE staff SET name=? WHERE company_id=? AND team_id=? AND id=?",
          )
          .bind(person.name, company, team, staffId),
      );
      statements.push(
        db
          .prepare(
            "UPDATE user SET name=?,email=?,emailVerified=CASE WHEN lower(email)!=? THEN 0 ELSE emailVerified END,updatedAt=? WHERE id=?",
          )
          .bind(person.name, person.email, person.email, now, old.user_id),
      );
      if (old.email.toLowerCase() !== person.email)
        statements.push(
          db.prepare("DELETE FROM session WHERE userId=?").bind(old.user_id),
          db
            .prepare(
              "DELETE FROM verification WHERE identifier LIKE 'reset-password:%' AND value=?",
            )
            .bind(old.user_id),
        );
    } else {
      const account = await credentials(db, person.email, person.name);
      userId = account.userId;
      statements.push(
        ...account.statements,
        db
          .prepare(
            "INSERT INTO staff(company_id,team_id,id,staff_number,name,user_id) VALUES (?,?,?,?,?,?)",
          )
          .bind(
            company,
            team,
            staffId,
            person.staffNumber,
            person.name,
            account.userId,
          ),
        db
          .prepare(
            "INSERT INTO team_member(company_id,team_id,user_id,role,staff_id) VALUES (?,?,?,'staff',?)",
          )
          .bind(company, team, account.userId, staffId),
      );
      initialPasswords.push({
        staffNumber: person.staffNumber,
        initialPassword: account.password,
      });
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO input_operation(company_id,id,actor_id,team_id,staff_id,kind,entity_id,expected_revision,fingerprint) VALUES (?,?,?,?,?,'staff_contract',?,?,?)",
        )
        .bind(
          company,
          contractVersion,
          user,
          team,
          staffId,
          staffId,
          expected,
          JSON.stringify({ importId: c.operationId, line: row.line }),
        ),
      db
        .prepare(
          "INSERT INTO work_input_version(company_id,operation_id,team_id,staff_id,kind,entity_id,effective_from,revision,payload) VALUES (?,?,?,?,'staff_contract',?,?,?,?)",
        )
        .bind(
          company,
          contractVersion,
          team,
          staffId,
          staffId,
          c.month,
          expected + 1,
          JSON.stringify(person.profile),
        ),
    );
    rows.push({
      line: row.line,
      staffId,
      staffNumber: person.staffNumber,
      action: row.action!,
      contractVersion,
    });
    expectedPeople.push({staffId,userId:userId!,staffNumber:person.staffNumber,name:person.name,email:person.email,
      contractVersion,revision:expected+1,profile:JSON.stringify(person.profile),created:!old,
      emailChanged:!!old&&old.email.toLowerCase()!==person.email});
  }
  const receipt = staffCsvReceipt.parse({
    id: c.operationId,
    revision: c.expectedRevision + 1 + valid.length,
    month: c.month,
    added: built.preview.added,
    updated: built.preview.updated,
    rejectedRows: built.preview.rows.length - valid.length,
    replayed: false,
    rows,
    errors: built.preview.rows
      .filter((r) => r.errors.length)
      .map((r) => ({ line: r.line, errors: r.errors })),
  });
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO staff_csv_operation(company_id,id,team_id,actor_id,expected_revision,fingerprint) VALUES (?,?,?,?,?,?)",
        )
        .bind(company, c.operationId, team, user, c.expectedRevision, fp),
      ...statements,
      db
        .prepare(
          "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          company,
          c.operationId,
          user,
          "staff_csv",
          receipt.revision,
          Date.now(),
        ),
      db
        .prepare(
          "INSERT INTO staff_csv_receipt(company_id,operation_id,revision,payload) VALUES (?,?,?,?)",
        )
        .bind(
          company,
          c.operationId,
          receipt.revision,
          JSON.stringify(receipt),
        ),
      // A successful/zero-row SQL statement is not proof of a complete import.
      // Fail inside the same transaction, after audit and receipt, so identity,
      // authentication, contracts and revision cannot commit independently.
      db.prepare(`SELECT CASE WHEN EXISTS(
        SELECT 1 FROM staff_csv_operation o
        JOIN company c ON c.id=o.company_id
        JOIN product_audit a ON a.company_id=o.company_id AND a.id=o.id
        JOIN staff_csv_receipt r ON r.company_id=o.company_id AND r.operation_id=o.id
        WHERE o.company_id=? AND o.id=? AND o.team_id=? AND o.actor_id=? AND o.fingerprint=?
          AND c.revision=? AND a.kind='staff_csv' AND a.actor_id=o.actor_id AND a.revision=c.revision
          AND r.revision=c.revision AND r.payload=?
      ) AND NOT EXISTS(
        SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(
          SELECT 1 FROM staff s JOIN user u ON u.id=s.user_id
          JOIN work_input_version v ON v.company_id=s.company_id AND v.staff_id=s.id
          WHERE s.company_id=? AND s.team_id=? AND s.id=json_extract(j.value,'$.staffId')
            AND s.user_id=json_extract(j.value,'$.userId') AND s.staff_number=json_extract(j.value,'$.staffNumber')
            AND s.name=json_extract(j.value,'$.name') AND u.name=s.name AND u.email=json_extract(j.value,'$.email')
            AND v.operation_id=json_extract(j.value,'$.contractVersion') AND v.kind='staff_contract'
            AND v.team_id=s.team_id AND v.entity_id=s.id AND v.effective_from=?
            AND v.revision=json_extract(j.value,'$.revision') AND v.payload=json_extract(j.value,'$.profile')
            AND (json_extract(j.value,'$.emailChanged')=0 OR u.emailVerified=0)
        ) OR (json_extract(j.value,'$.created')=1 AND (
          NOT EXISTS(SELECT 1 FROM account WHERE userId=json_extract(j.value,'$.userId') AND providerId='credential' AND length(password)>0)
          OR NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=json_extract(j.value,'$.userId') AND enabled=1 AND must_change_password=1)
          OR NOT EXISTS(SELECT 1 FROM team_member WHERE company_id=? AND team_id=? AND user_id=json_extract(j.value,'$.userId') AND staff_id=json_extract(j.value,'$.staffId') AND role='staff')
        )) OR (json_extract(j.value,'$.emailChanged')=1 AND (
          EXISTS(SELECT 1 FROM session WHERE userId=json_extract(j.value,'$.userId'))
          OR EXISTS(SELECT 1 FROM verification WHERE identifier LIKE 'reset-password:%' AND value=json_extract(j.value,'$.userId'))
        ))
      ) THEN 1 ELSE abs(-9223372036854775808) END AS completed`)
        .bind(company,c.operationId,team,user,fp,receipt.revision,JSON.stringify(receipt),JSON.stringify(expectedPeople),company,team,c.month,company,team),
    ]);
  } catch (e) {
    if (await replay(db, company, c.operationId, fp)) return prior();
    const message = String(e);
    if (
      message.includes("CSV_FORBIDDEN") ||
      message.includes("INPUT_FORBIDDEN")
    )
      throw new ProductError("FORBIDDEN", 403);
    if (
      message.includes("CSV_VERSION_CONFLICT") ||
      message.includes("INPUT_VERSION_CONFLICT")
    )
      throw new ProductError("VERSION_CONFLICT");
    if (message.includes("UNIQUE constraint"))
      throw new ProductError("CSV_PREVIEW_CHANGED");
    throw e;
  }
  return { receipt, initialPasswords };
}
