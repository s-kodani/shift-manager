// Private fictional PoC only; product entry points never import this module.
import { createApp } from "./index";
import { inputFixture } from "./input-probes";
import { boundedBytes } from "./compute-jobs";
import { sha256 } from "./input-snapshots";
import { ProductError } from "./product";
import { z } from "zod";
import { planning } from "./input-contracts";
import { demandCsvPreview, demandCsvReceipt } from "./demand-csv-contract";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";

export async function runCsvAssetProbes(env: Env) {
  if (env.ENVIRONMENT !== "poc") throw new ProductError("FORBIDDEN", 403);
  const app = createApp(),
    results: { name: string; passed: true }[] = [];
  const ensure = (ok: unknown) => {
    if (!ok) throw new Error("CSV_ASSET_PROBE_FAILED");
  };
  const record = (name: string) => results.push({ name, passed: true });
  const assets: { path: string; bytes: number; sha256: string }[] = [];
  const page = await app.request(env.AUTH_BASE_URL + "/app", {}, env);
  ensure(
    page.status === 200 && page.headers.get("cache-control") === "no-store",
  );
  const htmlBytes = await boundedBytes(page.body, 64_000);
  const html = new TextDecoder().decode(htmlBytes);
  assets.push({
    path: "/app",
    bytes: htmlBytes.byteLength,
    sha256: await sha256(htmlBytes),
  });
  const js = html.match(
    /src="(\/app-assets\/assets\/[A-Za-z0-9_.-]+\.js)"/,
  )?.[1];
  const css = html.match(
    /href="(\/app-assets\/assets\/[A-Za-z0-9_.-]+\.css)"/,
  )?.[1];
  ensure(
    js &&
      css &&
      page.headers
        .get("content-security-policy")
        ?.includes("script-src 'self'"),
  );
  for (const path of [js!, css!]) {
    const response = await app.request(env.AUTH_BASE_URL + path, {}, env);
    ensure(
      response.status === 200 &&
        response.headers.get("x-content-type-options") === "nosniff",
    );
    const bytes = await boundedBytes(response.body, 5_000_000);
    assets.push({ path, bytes: bytes.byteLength, sha256: await sha256(bytes) });
  }
  record("compiled_product_html_css_and_js_available_through_asset_binding");

  const planSchema = z.object({
    version: z.object({
      id: z.string().uuid(),
      revision: z.number().int(),
      payload: planning,
    }),
  });
  const contextSchema = z.object({
    companies: z.array(
      z.object({ id: z.string().uuid(), revision: z.number().int() }),
    ),
  });
  const f = await inputFixture(env.DB, env.INPUTS),
    company = f.company.companyId;
  const prefix = `/api/companies/${company}/inputs/teams/${f.team}`;
  let cookie = "";
  const request = async (path: string, body?: object, expected = 200) => {
    const response = await app.request(
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
    const next = response.headers.get("set-cookie")?.split(";")[0];
    if (next) cookie = next;
    if (
      response.status !== expected ||
      response.headers.get("cache-control") !== "no-store"
    )
      throw new Error(
        `CSV_ASSET_PROBE_FAILED:${path}:${response.status}:${response.headers.get("cache-control")}`,
      );
    const value: unknown = await response.json();
    return value;
  };
  const csv =
    "\ufeffdate,start,end,task_id,direct,calculated\r\n2026-10-01,10:00,10:30,phone,0,2.75\r\n2026-10-02,10:30,11:00,phone,,1.25\r\n2026-10-02,10:07,10:37,phone,1,\r\n";
  const command = { month: "2026-10", expectedRevision: f.revision, csv };
  let cleanup: { enabled: number; sessions: number; passwords: number } | null =
    null;
  try {
    await env.DB.prepare(
      "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
    )
      .bind(f.company.userId)
      .run();
    await request("/api/auth/sign-in/email", {
      email: f.email,
      password: f.company.initialPassword,
    });
    const denied = z
      .object({ error: z.string() })
      .parse(await request(prefix + "/demand-csv/preview", command, 403));
    ensure(denied.error === "PASSWORD_CHANGE_REQUIRED");
    await request("/api/password", {
      currentPassword: f.company.initialPassword,
      newPassword: `Fictional-${crypto.randomUUID()}-Aa1!`,
    });
    record("real_auth_initial_password_gate_then_change");
    const original = planSchema.parse(
      await request(prefix + "/planning/2026-10"),
    ).version.payload;
    const p = demandCsvPreview.parse(
      await request(prefix + "/demand-csv/preview", command),
    );
    ensure(
      p.added === 1 &&
        p.replaced === 1 &&
        p.rows.filter((r: { errors: unknown[] }) => r.errors.length).length ===
          1,
    );
    const aborted = planSchema.parse(
      await request(prefix + "/planning/2026-10"),
    );
    ensure(
      aborted.version.revision === f.revision - 1 &&
        JSON.stringify(aborted.version.payload) === JSON.stringify(original),
    );
    ensure(
      contextSchema
        .parse(await request("/api/context"))
        .companies.find((c: { id: string }) => c.id === company)?.revision ===
        f.revision,
    );
    record("preview_and_abort_preserve_planning_and_input_revision");
    const apply = {
      ...command,
      operationId: crypto.randomUUID(),
      previewSha256: p.previewSha256,
    };
    const receipt = demandCsvReceipt.parse(
      await request(prefix + "/demand-csv/apply", apply),
    );
    ensure(
      receipt.importedRows === 2 &&
        receipt.rejectedRows === 1 &&
        receipt.revision === f.revision + 1,
    );
    ensure(
      JSON.stringify(receipt.errors) ===
        JSON.stringify([
          { line: 4, errors: [{ column: "end", code: "INVALID_DEMAND_SLOT" }] },
        ]),
    );
    const saved = planSchema.parse(
      await request(prefix + "/planning/2026-10"),
    ).version;
    ensure(saved.payload.demand.length === 3 && saved.id === apply.operationId);
    ensure(
      JSON.stringify(saved.payload.events) ===
        JSON.stringify(original.events) &&
        JSON.stringify(saved.payload.roleRequirements) ===
          JSON.stringify(original.roleRequirements),
    );
    ensure(
      saved.payload.demand[0].direct === 0 &&
        saved.payload.demand[0].calculated === 275,
    );
    ensure(
      saved.payload.demand[2].direct === null &&
        saved.payload.demand[2].calculated === 125,
    );
    record("valid_rows_atomically_apply_exact_counts_and_rejected_diagnostics");
    const replay = demandCsvReceipt.parse(
      await request(prefix + "/demand-csv/apply", apply),
    );
    const reread = await request(
      prefix + "/demand-csv/receipts/" + apply.operationId,
    );
    ensure(
      replay.replayed && JSON.stringify(reread) === JSON.stringify(receipt),
    );
    await request(
      prefix + "/demand-csv/apply",
      { ...apply, csv: csv + "\n" },
      409,
    );
    ensure(
      contextSchema
        .parse(await request("/api/context"))
        .companies.find((c: { id: string }) => c.id === company)?.revision ===
        receipt.revision,
    );
    record("same_operation_replays_and_changed_intent_is_rejected");
    const snapshotId = crypto.randomUUID();
    await request(prefix + "/snapshots", {
      operationId: snapshotId,
      expectedRevision: receipt.revision,
      month: "2026-10",
    });
    const frozen = z
      .object({
        snapshot: z.object({
          input_revision: z.number().int(),
          lineage: z.string(),
        }),
        input: optimizerInputSchema,
        stale: z.boolean(),
        registrationStatus: z.string(),
      })
      .parse(await request(prefix + "/snapshots/" + snapshotId));
    ensure(
      frozen.snapshot.input_revision === receipt.revision &&
        !frozen.stale &&
        frozen.registrationStatus === "STRUCTURALLY_VALID",
    );
    ensure(
      frozen.input.demand[0].direct === 0 &&
        frozen.input.demand[0].calculated === 275 &&
        frozen.input.demand[2].calculated === 125,
    );
    ensure(
      z
        .array(z.object({ kind: z.string(), version: z.string() }))
        .parse(JSON.parse(frozen.snapshot.lineage))
        .some((v) => v.kind === "planning" && v.version === apply.operationId),
    );
    record("R2_snapshot_consumes_csv_planning_lineage");
  } finally {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE access_state SET enabled=0 WHERE user_id IN (?,?)",
      ).bind(f.company.userId, f.staffUser),
      env.DB.prepare("DELETE FROM session WHERE userId IN (?,?)").bind(
        f.company.userId,
        f.staffUser,
      ),
      env.DB.prepare(
        "UPDATE account SET password=NULL WHERE userId IN (?,?)",
      ).bind(f.company.userId, f.staffUser),
    ]);
    cleanup = await env.DB.prepare(
      `SELECT
      (SELECT count(*) FROM access_state WHERE enabled=1 AND user_id IN (?,?)) AS enabled,
      (SELECT count(*) FROM session WHERE userId IN (?,?)) AS sessions,
      (SELECT count(*) FROM account WHERE password IS NOT NULL AND userId IN (?,?)) AS passwords`,
    )
      .bind(
        f.company.userId,
        f.staffUser,
        f.company.userId,
        f.staffUser,
        f.company.userId,
        f.staffUser,
      )
      .first();
    ensure(
      cleanup && !cleanup.enabled && !cleanup.sessions && !cleanup.passwords,
    );
  }
  record("fictional_accounts_sessions_and_passwords_disabled");
  return { scope: "private-fictional-csv-assets", results, assets, cleanup };
}
