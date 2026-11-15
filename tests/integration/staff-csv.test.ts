import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { inputFixture } from "../../apps/api/src/input-probes";
import {
  applyStaffCsv,
  buildStaffCsvPreview,
  readStaffCsvReceipt,
} from "../../apps/api/src/staff-csv";
import { staffCsvColumns } from "../../apps/api/src/staff-csv-contract";
import {
  resolveVersion,
  type InputDatabase,
} from "../../apps/api/src/input-versions";
import {
  createInputSnapshot,
  readInputSnapshot,
} from "../../apps/api/src/input-snapshots";
import {
  createTeam,
  createStaff,
  grantTeamAdmin,
} from "../../apps/api/src/product";
import { createApp } from "../../apps/api/src/index";
import { createJob } from "../../apps/api/src/compute-jobs";
import { executeJob } from "../../apps/api/src/compute-execution";
import { publishSchedule } from "../../apps/api/src/schedule-publications";
import { sha256 } from "../../apps/api/src/input-snapshots";

let f: Awaited<ReturnType<typeof inputFixture>>;
const company = () => f.company.companyId,
  user = () => f.company.userId;
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(company())
    .first<number>("revision"))!;
const encode = (s: unknown) => '"' + String(s).replaceAll('"', '""') + '"';
const row = (overrides: Record<string, string> = {}) => {
  const p = f.profile;
  const cells: Record<string, string> = {
    staff_number: "0001",
    name: "架空更新スタッフ",
    email: `${crypto.randomUUID()}@example.invalid`,
    employment_type_id: f.employment,
    weekdays: p.contract.weekdays.join(";"),
    start: "10:00",
    end: "17:00",
    daily_max: String(p.rule.dailyMax),
    weekly_max: String(p.rule.weeklyMax),
    monthly_min: String(p.rule.monthlyMin),
    monthly_max: String(p.rule.monthlyMax),
    min_days: String(p.rule.minDays),
    min_off: String(p.rule.minOff),
    max_consecutive: String(p.rule.maxConsecutive),
    skills: JSON.stringify(p.skills),
    role_ids: JSON.stringify(p.roleIds),
    ...overrides,
  };
  return staffCsvColumns.map((c) => encode(cells[c])).join(",");
};
const file = (...rows: string[]) =>
  staffCsvColumns.join(",") + "\n" + rows.join("\n");
const command = async (csv: string) => ({
  month: "2026-10",
  expectedRevision: await revision(),
  csv,
});
const preview = async (csv: string, actor = user(), team = f.team) =>
  buildStaffCsvPreview(env.DB, company(), team, actor, await command(csv));
const applyCommand = async (csv: string) => {
  const c = await command(csv);
  return {
    ...c,
    operationId: crypto.randomUUID(),
    previewSha256: (
      await buildStaffCsvPreview(env.DB, company(), f.team, user(), c)
    ).preview.previewSha256,
  };
};
const apply = (
  c: Awaited<ReturnType<typeof applyCommand>>,
  db: InputDatabase = env.DB,
  actor = user(),
) => applyStaffCsv(db, company(), f.team, actor, c);
const oldPerson = () =>
  env.DB.prepare(
    "SELECT s.id,s.user_id,s.name,u.email FROM staff s JOIN user u ON u.id=s.user_id WHERE s.company_id=? AND s.id=?",
  )
    .bind(company(), f.staff.staffId)
    .first<{ id: string; user_id: string; name: string; email: string }>();
const absent = async (id: string) => {
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM staff_csv_operation WHERE company_id=? AND id=?",
    )
      .bind(company(), id)
      .first(),
  ).toBeNull();
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM product_audit WHERE company_id=? AND id=?",
    )
      .bind(company(), id)
      .first(),
  ).toBeNull();
};
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
});

it("Q100/101: preview and abort are read-only; valid rows preserve identity and old versions while adding new accounts and exact contracts", async () => {
  const before = await oldPerson(),
    r = await revision(),
    hash = await env.DB.prepare(
      "SELECT password FROM account WHERE userId=? AND providerId='credential'",
    )
      .bind(f.staffUser)
      .first<string>("password");
  const text = file(
    row({ name: "架空更新,氏名\n二行" }),
    row({ staff_number: "0002" }),
    row({ staff_number: "0003", start: "10:07" }),
  );
  const p = await preview(text);
  expect(p.preview).toMatchObject({ added: 1, updated: 1, inputRevision: r });
  expect(p.preview.rows.map((r) => r.line)).toEqual([2, 4, 5]);
  expect(await oldPerson()).toEqual(before);
  expect(await revision()).toBe(r);
  const c = await applyCommand(text),
    result = await apply(c);
  expect(result.receipt).toMatchObject({
    revision: r + 3,
    added: 1,
    updated: 1,
    rejectedRows: 1,
    replayed: false,
  });
  expect(result.initialPasswords).toHaveLength(1);
  expect(result.receipt.rows[0].staffId).toBe(f.staff.staffId);
  expect((await oldPerson())!.user_id).toBe(before!.user_id);
  expect(
    await env.DB.prepare(
      "SELECT password FROM account WHERE userId=? AND providerId='credential'",
    )
      .bind(f.staffUser)
      .first("password"),
  ).toBe(hash);
  expect(
    JSON.parse(
      (await resolveVersion(
        env.DB,
        company(),
        "staff_contract",
        f.staff.staffId,
        "2026-10",
      ))!.payload,
    ),
  ).toEqual(f.profile);
  const s = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    company(),
    f.team,
    user(),
    {
      operationId: crypto.randomUUID(),
      month: "2026-10",
      expectedRevision: result.receipt.revision,
    },
  );
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    company(),
    f.team,
    user(),
    s.snapshot.id,
    true,
  );
  expect(frozen.input.staff).toHaveLength(2);
  expect(frozen.input.staff.map((s) => s.skills.map((k) => k.level))).toEqual([
    [1, 1],
    [1, 1],
  ]);
  expect(frozen.input.staff[0].rules).toHaveLength(3);
  for (const entry of result.receipt.rows)
    expect(
      JSON.parse(frozen.snapshot.lineage).some(
        (l: { version: string }) => l.version === entry.contractVersion,
      ),
    ).toBe(true);
  expect(
    JSON.stringify(
      await readStaffCsvReceipt(
        env.DB,
        company(),
        f.team,
        user(),
        c.operationId,
      ),
    ),
  ).not.toContain(result.initialPasswords[0].initialPassword);
});

it("real Better Auth email change preserves password and revokes old sessions and reset links; new accounts require first change", async () => {
  const old = (await oldPerson())!,
    app = createApp();
  const request = (path: string, body?: object, cookie = "") =>
    app.request(
      env.AUTH_BASE_URL + path,
      {
        method: body ? "POST" : "GET",
        headers: {
          origin: env.AUTH_BASE_URL,
          "content-type": "application/json",
          cookie,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      env,
    );
  const signed = await request("/api/auth/sign-in/email", {
    email: old.email,
    password: f.staff.initialPassword!,
  });
  expect(signed.status).toBe(200);
  const cookie = signed.headers.get("set-cookie")!.split(";")[0];
  await env.DB.prepare(
    "INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      "reset-password:fictional-old-link",
      f.staffUser,
      new Date(Date.now() + 60000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const nextEmail = `${crypto.randomUUID()}@example.invalid`;
  const result = await apply(
    await applyCommand(
      file(row({ email: nextEmail }), row({ staff_number: "0002" })),
    ),
  );
  expect((await request("/api/access", undefined, cookie)).status).toBe(401);
  expect(
    await env.DB.prepare("SELECT 1 FROM verification WHERE value=?")
      .bind(f.staffUser)
      .first(),
  ).toBeNull();
  expect(
    (
      await request("/api/auth/sign-in/email", {
        email: old.email,
        password: f.staff.initialPassword!,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request("/api/auth/sign-in/email", {
        email: nextEmail,
        password: f.staff.initialPassword!,
      })
    ).status,
  ).toBe(200);
  const newEmail = (await env.DB.prepare(
    "SELECT u.email FROM staff s JOIN user u ON u.id=s.user_id WHERE s.company_id=? AND s.staff_number=?",
  )
    .bind(company(), "0002")
    .first<string>("email"))!;
  const added = await request("/api/auth/sign-in/email", {
    email: newEmail,
    password: result.initialPasswords[0].initialPassword,
  });
  expect(added.status).toBe(200);
  const newCookie = added.headers.get("set-cookie")!.split(";")[0];
  expect((await request("/api/context", undefined, newCookie)).status).toBe(
    403,
  );
  expect(
    (
      await request(
        "/api/password",
        {
          currentPassword: result.initialPasswords[0].initialPassword,
          newPassword: "Fictional-Csv-new-password-Aa1!",
        },
        newCookie,
      )
    ).status,
  ).toBe(200);
  const relogin = await request("/api/auth/sign-in/email", {
    email: newEmail,
    password: "Fictional-Csv-new-password-Aa1!",
  });
  expect(relogin.status).toBe(200);
  expect(
    (
      await request(
        "/api/context",
        undefined,
        relogin.headers.get("set-cookie")!.split(";")[0],
      )
    ).status,
  ).toBe(200);
});

it("same operation replay and parallel delivery produce one account, no secret replay, immutable receipts and version conflicts", async () => {
  const c = await applyCommand(file(row({ staff_number: "0002" }))),
    r = await revision();
  const results = await Promise.all([apply(c), apply(c)]);
  expect(results.map((x) => x.receipt.replayed).sort()).toEqual([false, true]);
  expect(results.flatMap((x) => x.initialPasswords)).toHaveLength(1);
  expect(results[0].receipt.rows).toEqual(results[1].receipt.rows);
  expect(await revision()).toBe(r + 2);
  expect((await apply(c)).initialPasswords).toEqual([]);
  await expect(apply({ ...c, csv: c.csv + "\n" })).rejects.toThrow(
    "OPERATION_ID_CONFLICT",
  );
  await expect(
    apply({ ...c, operationId: crypto.randomUUID() }),
  ).rejects.toThrow("VERSION_CONFLICT");
  await expect(
    env.DB.prepare(
      "UPDATE staff_csv_receipt SET revision=1 WHERE company_id=? AND operation_id=?",
    )
      .bind(company(), c.operationId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_CSV_RECEIPT");
});

it("the 100-row boundary commits all new identities and contracts atomically and replays without credentials", async () => {
  const c = await applyCommand(
    file(
      ...Array.from({ length: 100 }, (_, i) =>
        row({ staff_number: `csv-${i + 1}` }),
      ),
    ),
  );
  const result = await apply(c);
  expect(result.receipt).toMatchObject({
    added: 100,
    updated: 0,
    rejectedRows: 0,
    revision: c.expectedRevision + 101,
  });
  expect(result.receipt.rows).toHaveLength(100);
  expect(result.initialPasswords).toHaveLength(100);
  expect(
    await env.DB.prepare(
      `SELECT count(*) AS n FROM staff s JOIN access_state a ON a.user_id=s.user_id
     JOIN account c ON c.userId=s.user_id AND c.providerId='credential'
     WHERE s.company_id=? AND s.staff_number LIKE 'csv-%'
     AND a.enabled=1 AND a.must_change_password=1 AND c.password IS NOT NULL`,
    )
      .bind(company())
      .first<number>("n"),
  ).toBe(100);
  expect((await apply(c)).initialPasswords).toEqual([]);
  expect(await revision()).toBe(c.expectedRevision + 101);
}, 60_000);

it("duplicate numbers/emails reject all involved rows; invalid references, rules, time and skills are diagnosed by line/column", async () => {
  const same = `${crypto.randomUUID()}@example.invalid`;
  const p = await preview(
    file(
      row({ staff_number: "0002", email: same }),
      row({ staff_number: "0002", email: same }),
      row({ staff_number: "0003", employment_type_id: crypto.randomUUID() }),
      row({ staff_number: "0004", skills: '[{"taskId":"missing","level":1}]' }),
      row({ staff_number: "0005", monthly_min: "13000" }),
      row({ staff_number: "0006", weekdays: "6" }),
      row({ staff_number: "0007", start: "10:07" }),
    ),
  );
  expect(p.preview.rows[0].errors.map((x) => x.code)).toEqual([
    "DUPLICATE_STAFF_NUMBER",
    "DUPLICATE_EMAIL",
  ]);
  expect(p.preview.rows[1].errors).toEqual(p.preview.rows[0].errors);
  expect(
    p.preview.rows.slice(2).map((r) => r.errors.map((e) => e.code)),
  ).toEqual([
    ["UNKNOWN_EMPLOYMENT_TYPE"],
    ["UNKNOWN_SKILL_OR_ROLE"],
    ["CONTRADICTORY_RULE"],
    ["CONTRADICTORY_CONTRACT"],
    ["CSV_TIME_NOT_ALIGNED"],
  ]);
  expect(p.preview.rows[6].errors[0].column).toBe("start");
  const c = await applyCommand(file(row({ start: "10:07" })));
  await expect(apply(c)).rejects.toThrow("CSV_NO_VALID_ROWS");
  await absent(c.operationId);
});

it("all blank personal rule means null, explicit zero stays zero, and earlier/future contract versions remain immutable", async () => {
  const earlier = await resolveVersion(
    env.DB,
    company(),
    "staff_contract",
    f.staff.staffId,
    "2026-10",
  );
  const rules = {
    daily_max: "",
    weekly_max: "",
    monthly_min: "",
    monthly_max: "",
    min_days: "",
    min_off: "",
    max_consecutive: "",
  };
  const c = await command(file(row(rules)));
  c.month = "2026-11";
  const p = await buildStaffCsvPreview(env.DB, company(), f.team, user(), c);
  expect(p.preview.rows[0].person!.profile.rule).toBeNull();
  await apply({
    ...c,
    operationId: crypto.randomUUID(),
    previewSha256: p.preview.previewSha256,
  });
  expect(
    await resolveVersion(
      env.DB,
      company(),
      "staff_contract",
      f.staff.staffId,
      "2026-10",
    ),
  ).toEqual(earlier);
  const zero = await preview(
    file(
      row({
        monthly_min: "0",
        min_days: "0",
        skills: '[{"taskId":"phone","level":0}]',
        role_ids: "[]",
      }),
    ),
  );
  expect(zero.preview.rows[0].person!.profile).toMatchObject({
    rule: { monthlyMin: 0, minDays: 0 },
    skills: [{ level: 0 }],
    roleIds: [],
  });
});

it("team scope and company staff number matching never select by email or modify another team/company", async () => {
  const otherTeam = (
    await createTeam(env.DB, company(), user(), {
      operationId: crypto.randomUUID(),
      expectedRevision: await revision(),
      name: "架空担当外",
    })
  ).teamId;
  await createStaff(env.DB, company(), otherTeam, user(), {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    name: "架空別チーム",
    staffNumber: "foreign",
    email: `${crypto.randomUUID()}@example.invalid`,
  });
  const p = await preview(
    file(
      row({ staff_number: "foreign" }),
      row({ staff_number: "different", email: (await oldPerson())!.email }),
    ),
  );
  expect(p.preview.rows.map((r) => r.errors[0].code)).toEqual([
    "STAFF_OUTSIDE_TEAM",
    "EMAIL_IN_USE",
  ]);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(preview(file(row()), f.staffUser)).rejects.toThrow("FORBIDDEN");
  await grantTeamAdmin(env.DB, company(), f.team, user(), {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    userId: f.staffUser,
  });
  const commandValue = await command(file(row({ staff_number: "0002" })));
  const c = {
    ...commandValue,
    operationId: crypto.randomUUID(),
    previewSha256: (
      await buildStaffCsvPreview(
        env.DB,
        company(),
        f.team,
        f.staffUser,
        commandValue,
      )
    ).preview.previewSha256,
  };
  expect((await apply(c, env.DB, f.staffUser)).receipt.added).toBe(1);
  await expect(
    readStaffCsvReceipt(env.DB, company(), otherTeam, user(), c.operationId),
  ).rejects.toThrow("NOT_FOUND");
});

it("audit failure rolls back identity, credentials, contracts, operation, receipt and revision; same command can retry after repair", async () => {
  const old = await oldPerson(),
    c = await applyCommand(file(row(), row({ staff_number: "0002" }))),
    r = await revision();
  const accounts = await env.DB.prepare(
    "SELECT count(*) AS n FROM account",
  ).first<number>("n");
  await env.DB.exec(
    "CREATE TRIGGER staff_csv_test_audit BEFORE INSERT ON product_audit WHEN NEW.kind='staff_csv' BEGIN SELECT RAISE(ABORT,'INJECTED_CSV_AUDIT_FAILURE'); END;",
  );
  try {
    await expect(apply(c)).rejects.toThrow("INJECTED_CSV_AUDIT_FAILURE");
  } finally {
    await env.DB.exec("DROP TRIGGER staff_csv_test_audit");
  }
  expect(await oldPerson()).toEqual(old);
  expect(await revision()).toBe(r);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM account").first("n"),
  ).toBe(accounts);
  await absent(c.operationId);
  expect((await apply(c)).receipt).toMatchObject({ added: 1, updated: 1 });
});

it("authorization lost immediately before batch refuses all writes, even after preparing new credential hashes", async () => {
  const c = await applyCommand(file(row({ staff_number: "0002" }))),
    r = await revision();
  const db = {
    prepare: (s: string) => env.DB.prepare(s),
    async batch<T>(s: D1PreparedStatement[]) {
      await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
        .bind(user())
        .run();
      return env.DB.batch<T>(s);
    },
  };
  await expect(apply(c, db)).rejects.toThrow("FORBIDDEN");
  expect(await revision()).toBe(r);
  await absent(c.operationId);
});

it.each(["audit", "receipt", "staff-name", "user-name", "account", "access", "membership"])(
  "CSV silent %s omission rolls back every imported identity/version and can retry the same operation",
  async fault => {
    const old = await oldPerson(), c = await applyCommand(file(row(), row({staff_number:"0002"}))), r = await revision();
    const counts = async () => env.DB.prepare(`SELECT
      (SELECT count(*) FROM user) users,(SELECT count(*) FROM account) accounts,
      (SELECT count(*) FROM staff WHERE company_id=?) staff,
      (SELECT count(*) FROM work_input_version WHERE company_id=?) versions`).bind(company(),company()).first();
    const before = await counts();
    const target = {
      audit: "BEFORE INSERT ON product_audit WHEN NEW.kind='staff_csv'",
      receipt: "BEFORE INSERT ON staff_csv_receipt",
      "staff-name": "BEFORE UPDATE ON staff",
      "user-name": "BEFORE UPDATE ON user",
      account: "BEFORE INSERT ON account",
      access: "BEFORE INSERT ON access_state",
      membership: "BEFORE INSERT ON team_member",
    }[fault]!;
    await env.DB.exec(`CREATE TRIGGER csv_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END;`);
    try {
      await expect(apply(c)).rejects.toThrow();
      expect(await oldPerson()).toEqual(old); expect(await revision()).toBe(r);
      expect(await counts()).toEqual(before); await absent(c.operationId);
    } finally { await env.DB.exec("DROP TRIGGER csv_silent_omission"); }
    expect((await apply(c)).receipt).toMatchObject({added:1,updated:1,replayed:false});
    expect((await apply(c)).initialPasswords).toEqual([]);
  },
);

it.each(["session", "verification"])("CSV silent %s revocation omission preserves old identity atomically until the same import is repaired", async fault => {
  const old=(await oldPerson())!, app=createApp();
  const login=await app.request(env.AUTH_BASE_URL+'/api/auth/sign-in/email',{
    method:'POST',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json'},
    body:JSON.stringify({email:old.email,password:f.staff.initialPassword}),
  },env);
  expect(login.status).toBe(200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0],tokenId=crypto.randomUUID(),now=new Date().toISOString();
  await env.DB.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .bind(tokenId,'reset-password:fictional-csv-revocation',f.staffUser,new Date(Date.now()+60000).toISOString(),now,now).run();
  const c=await applyCommand(file(row())),r=await revision();
  const sessions=await env.DB.prepare('SELECT count(*) AS n FROM session WHERE userId=?').bind(f.staffUser).first('n');
  await env.DB.exec(`CREATE TRIGGER csv_revocation_omission BEFORE DELETE ON ${fault} BEGIN SELECT RAISE(IGNORE); END;`);
  try {
    await expect(apply(c)).rejects.toThrow();expect(await oldPerson()).toEqual(old);expect(await revision()).toBe(r);await absent(c.operationId);
    expect(await env.DB.prepare('SELECT count(*) AS n FROM session WHERE userId=?').bind(f.staffUser).first('n')).toBe(sessions);
    expect(await env.DB.prepare('SELECT 1 FROM verification WHERE id=?').bind(tokenId).first()).not.toBeNull();
  } finally {await env.DB.exec('DROP TRIGGER csv_revocation_omission');}
  expect((await apply(c)).receipt).toMatchObject({updated:1,replayed:false});
  expect(await env.DB.prepare('SELECT 1 FROM verification WHERE id=?').bind(tokenId).first()).toBeNull();
  expect((await app.request(env.AUTH_BASE_URL+'/api/access',{headers:{cookie}},env)).status).toBe(401);
  expect((await apply(c)).initialPasswords).toEqual([]);
});

it("CSV file bounds, invalid previews and API origin/body/first-password gates reject without writes", async () => {
  await expect(
    preview(
      file(
        ...Array.from({ length: 101 }, (_, i) =>
          row({ staff_number: "n" + i }),
        ),
      ),
    ),
  ).rejects.toThrow("STAFF_CSV_TOO_MANY_ROWS");
  await expect(preview("bad\nrow")).rejects.toThrow("CSV_INVALID_HEADER");
  const c = await applyCommand(file(row()));
  await expect(apply({ ...c, previewSha256: "0".repeat(64) })).rejects.toThrow(
    "CSV_PREVIEW_CHANGED",
  );
  await absent(c.operationId);
  const app = createApp();
  const signed = await app.request(
    env.AUTH_BASE_URL + "/api/auth/sign-in/email",
    {
      method: "POST",
      headers: {
        origin: env.AUTH_BASE_URL,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: f.email,
        password: f.company.initialPassword,
      }),
    },
    env,
  );
  const cookie = signed.headers.get("set-cookie")!.split(";")[0];
  const url = `${env.AUTH_BASE_URL}/api/companies/${company()}/inputs/teams/${f.team}/staff-csv/preview`;
  const post = (body: string, origin = env.AUTH_BASE_URL) =>
    app.request(
      url,
      {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body,
      },
      env,
    );
  expect(
    (
      await post(
        JSON.stringify(await command(file(row()))),
        "https://foreign.invalid",
      )
    ).status,
  ).toBe(403);
  expect((await post("x".repeat(2_000_001))).status).toBe(413);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
  )
    .bind(user())
    .run();
  const denied = await post(JSON.stringify(await command(file(row()))));
  expect(denied.status).toBe(403);
  expect(denied.headers.get("cache-control")).toBe("no-store");
});

it("different operations on one revision have one winner; a late same-operation winner is reconciled without new credentials", async () => {
  const a = await applyCommand(file(row({ staff_number: "0002" }))),
    b = { ...a, operationId: crypto.randomUUID() };
  const outcomes = await Promise.allSettled([apply(a), apply(b)]);
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(await revision()).toBe(a.expectedRevision + 2);
  const c = await applyCommand(file(row({ staff_number: "0003" })));
  let injected = false;
  const db = {
    prepare(sql: string): D1PreparedStatement {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind")
              return (...args: unknown[]) => wrap(target.bind(...args));
            if (
              key === "first" &&
              sql === "SELECT revision FROM company WHERE id=?"
            )
              return async (
                ...args: Parameters<D1PreparedStatement["first"]>
              ) => {
                if (!injected) {
                  injected = true;
                  await apply(c);
                }
                return target.first(...args);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" && key !== "constructor"
              ? value.bind(target)
              : value;
          },
        });
      return wrap(env.DB.prepare(sql));
    },
    batch: <T>(s: D1PreparedStatement[]) => env.DB.batch<T>(s),
  };
  const replayed = await apply(c, db);
  expect(injected).toBe(true);
  expect(replayed.receipt.replayed).toBe(true);
  expect(replayed.initialPasswords).toEqual([]);
  expect(await revision()).toBe(c.expectedRevision + 2);
});

it("same staff number in another company remains a different person; foreign emails cannot be captured", async () => {
  const other = await inputFixture(env.DB, env.INPUTS);
  const before = await env.DB.prepare(
    "SELECT name,user_id FROM staff WHERE company_id=? AND id=?",
  )
    .bind(other.company.companyId, other.staff.staffId)
    .first();
  const email = (await env.DB.prepare("SELECT email FROM user WHERE id=?")
    .bind(other.staffUser)
    .first<string>("email"))!;
  const p = await preview(file(row({ email })));
  expect(p.preview.rows[0].errors).toContainEqual({
    column: "email",
    code: "EMAIL_IN_USE",
  });
  await apply(await applyCommand(file(row())));
  expect(
    await env.DB.prepare(
      "SELECT name,user_id FROM staff WHERE company_id=? AND id=?",
    )
      .bind(other.company.companyId, other.staff.staffId)
      .first(),
  ).toEqual(before);
  await expect(
    buildStaffCsvPreview(
      env.DB,
      other.company.companyId,
      other.team,
      user(),
      await command(file(row())),
    ),
  ).rejects.toThrow("FORBIDDEN");
});

it("contract imports queue Q118 checks atomically and preserve all published work and original certificates", async () => {
  const r = await revision(),
    sid = crypto.randomUUID();
  await createInputSnapshot(env.DB, env.INPUTS, company(), f.team, user(), {
    operationId: sid,
    expectedRevision: r,
    month: "2026-10",
  });
  const job = (
    await createJob(env.DB, env.INPUTS, company(), f.team, user(), {
      operationId: crypto.randomUUID(),
      snapshotId: sid,
      expectedRevision: r,
    })
  ).job;
  const assignments = Array.from({ length: 31 }, (_, i) => ({
    staffId: f.staff.staffId,
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    shift: null,
    blocks: [],
    roleIntervals: [],
  }));
  const certificate = {
    scope: "multi-task-v1" as const,
    status: "VERIFIED" as const,
    violations: [],
    missingHistory: [],
    generalShortage: 0,
    roleSameShortage: 0,
    roleRequirements: [],
  };
  await executeJob(
    env,
    { version: 1, companyId: company(), teamId: f.team, jobId: job.id },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments }
          : certificate,
      ),
    async () => {},
  );
  const pid = crypto.randomUUID();
  await publishSchedule(
    env,
    company(),
    f.team,
    user(),
    {
      operationId: pid,
      expectedRevision: r,
      expectedDraftRevision: 0,
      expectedPublicationRevision: 0,
      source: { kind: "job", id: job.id },
      acknowledgeShortage: false,
    },
    async (c) => {
      const frozen = await readInputSnapshot(
        env.DB,
        env.INPUTS,
        c.companyId,
        c.teamId,
        c.userId,
        c.snapshotId,
        true,
        true,
      );
      return {
        snapshotSha256: frozen.snapshot.sha256,
        inputSha256: await sha256(
          new TextEncoder().encode(
            JSON.stringify({
              ...frozen.input,
              locks: c.locks,
              exceptions: c.exceptions,
            }),
          ),
        ),
        validation: certificate,
      };
    },
  );
  const read = () =>
    env.DB.prepare(
      "SELECT * FROM schedule_publication_assignment WHERE company_id=? ORDER BY staff_id,date",
    )
      .bind(company())
      .all()
      .then((r) => r.results);
  const before = await read(),
    oldCertificate = await env.DB.prepare(
      "SELECT * FROM schedule_publication_version WHERE company_id=? AND id=?",
    )
      .bind(company(), pid)
      .first();
  const result = await apply(
    await applyCommand(
      file(row({ monthly_min: "180" }), row({ staff_number: "0002" })),
    ),
  );
  expect(await read()).toEqual(before);
  expect(
    await env.DB.prepare(
      "SELECT * FROM schedule_publication_version WHERE company_id=? AND id=?",
    )
      .bind(company(), pid)
      .first(),
  ).toEqual(oldCertificate);
  expect(
    await env.DB.prepare(
      "SELECT required_revision FROM publication_validation_head WHERE company_id=? AND team_id=? AND month=?",
    )
      .bind(company(), f.team, "2026-10")
      .first("required_revision"),
  ).toBe(result.receipt.revision);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM publication_revalidation_request WHERE company_id=? AND required_revision=? AND state='PENDING'",
    )
      .bind(company(), result.receipt.revision)
      .first("n"),
  ).toBe(1);
});

it('CSV reports a deleted staff number instead of updating or recreating the hidden staff',async()=>{
  const {changeStaffStatus}=await import('../../apps/api/src/staff-lifecycle');
  await changeStaffStatus(env.DB,company(),f.team,f.staff.staffId,user(),{operationId:crypto.randomUUID(),expectedRevision:await revision(),status:'deleted'});
  const before=await revision();
  const result=await preview(file(row()));
  expect(result.preview.rows[0].errors).toContainEqual({column:'staff_number',code:'STAFF_DELETED'});
  expect(result.preview.added+result.preview.updated).toBe(0);
  expect(await revision()).toBe(before);
});
