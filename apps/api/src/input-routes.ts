import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiEnv, ProductError, requireManager } from "./product";
import {
  type ResourceTarget,
  inputMonth,
  resourceMutation,
  resolveVersion,
  saveInputVersion,
} from "./input-versions";
import { readResource } from "./input-contracts";
import {
  snapshotCommand,
  createInputSnapshot,
  readInputSnapshot,
} from "./input-snapshots";
import { contractOptions } from "./input-catalogs";
import { readInputReadiness } from "./input-readiness";
import { readInputChanges } from "./input-changes";
import { inputChangesHttpQuery } from "./input-changes-contract";
import { dispatchRevalidations } from "./publication-revalidation";
import { CsvError } from "./csv";
import { demandCsvCommand, demandCsvApply } from "./demand-csv-contract";
import {
  buildDemandCsvPreview,
  applyDemandCsv,
  readDemandCsvReceipt,
} from "./demand-csv";
import { staffCsvCommand, staffCsvApply } from "./staff-csv-contract";
import {
  buildStaffCsvPreview,
  applyStaffCsv,
  readStaffCsvReceipt,
} from "./staff-csv";

export function inputRoutes() {
  const app = new Hono<ApiEnv>();
  // Scope middleware to input paths: unrelated product endpoints retain their
  // smaller 16 KiB limit. Authentication/first-change guards run in the parent.
  app.use("/companies/:company/inputs/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    )
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    await next();
  });
  app.use(
    "/companies/:company/inputs/*",
    bodyLimit({
      maxSize: 2_000_000,
      onError: (c) => c.json({ error: "INPUT_TOO_LARGE" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof CsvError)
      return c.json(
        { error: error.code, line: error.line, column: error.column },
        400,
      );
    if (error instanceof ProductError)
      return c.json({ error: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "INVALID_INPUT" }, 400);
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  });
  app.get("/companies/:company/inputs/teams/:team/readiness/:month", async c => {
    const company = z.string().uuid().parse(c.req.param("company"));
    const team = z.string().uuid().parse(c.req.param("team"));
    return c.json(await readInputReadiness(c.env, company, team, c.get("identity").userId, c.req.param("month")));
  });
  app.post(
    "/companies/:company/inputs/teams/:team/staff-csv/preview",
    async (c) => {
      const company = c.req.param("company"),
        team = c.req.param("team");
      return c.json(
        (
          await buildStaffCsvPreview(
            c.env.DB,
            company,
            team,
            c.get("identity").userId,
            staffCsvCommand.parse(await c.req.json()),
          )
        ).preview,
      );
    },
  );
  app.post(
    "/companies/:company/inputs/teams/:team/staff-csv/apply",
    async (c) => {
      const company = c.req.param("company"),
        team = c.req.param("team");
      const result = await applyStaffCsv(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        staffCsvApply.parse(await c.req.json()),
      );
      await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
      return c.json(result);
    },
  );
  app.get(
    "/companies/:company/inputs/teams/:team/staff-csv/receipts/:id",
    async (c) => {
      const company = c.req.param("company"),
        team = c.req.param("team"),
        id = c.req.param("id");
      return c.json(
        await readStaffCsvReceipt(
          c.env.DB,
          company,
          team,
          c.get("identity").userId,
          id,
        ),
      );
    },
  );
  const resources = [
    {
      path: "/companies/:company/inputs/company-policy",
      kind: "company_policy",
      scope: "company",
    },
    {
      path: "/companies/:company/inputs/employment/:entity",
      kind: "employment_policy",
      scope: "employment",
    },
    {
      path: "/companies/:company/inputs/teams/:team/config",
      kind: "team_config",
      scope: "team",
    },
    {
      path: "/companies/:company/inputs/teams/:team/planning",
      kind: "planning",
      scope: "team",
    },
    {
      path: "/companies/:company/inputs/teams/:team/staff/:staff/contract",
      kind: "staff_contract",
      scope: "staff",
    },
    {
      path: "/companies/:company/inputs/teams/:team/staff/:staff/month",
      kind: "staff_month",
      scope: "staff",
    },
  ] as const;
  const csvBase = "/companies/:company/inputs/teams/:team/demand-csv";
  app.get(csvBase + "/receipts/:id", async (c) =>
    c.json(
      await readDemandCsvReceipt(
        c.env.DB,
        z.string().uuid().parse(c.req.param("company")),
        z.string().uuid().parse(c.req.param("team")),
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("id")),
      ),
    ),
  );
  app.post(csvBase + "/preview", async (c) => {
    const company = z.string().uuid().parse(c.req.param("company")),
      team = z.string().uuid().parse(c.req.param("team"));
    const result = await buildDemandCsvPreview(
      c.env,
      company,
      team,
      c.get("identity").userId,
      demandCsvCommand.parse(await c.req.json()),
    );
    return c.json(result.preview);
  });
  app.post(csvBase + "/apply", async (c) => {
    const company = z.string().uuid().parse(c.req.param("company")),
      team = z.string().uuid().parse(c.req.param("team"));
    const result = await applyDemandCsv(
      c.env,
      company,
      team,
      c.get("identity").userId,
      demandCsvApply.parse(await c.req.json()),
    );
    await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
    return c.json(result);
  });
  app.get(
    "/companies/:company/inputs/teams/:team/contract-options/:month",
    async (c) => {
      const { company, team, month } = c.req.param();
      return c.json(
        await contractOptions(
          c.env.DB,
          z.string().uuid().parse(company),
          z.string().uuid().parse(team),
          c.get("identity").userId,
          inputMonth.parse(month),
        ),
      );
    },
  );
  for (const resource of resources) {
    const target = (params: Record<string, string>): ResourceTarget => {
      const company = z.string().uuid().parse(params.company);
      const team = ["team", "staff"].includes(resource.scope)
        ? z.string().uuid().parse(params.team)
        : null;
      const staff =
        resource.scope === "staff"
          ? z.string().uuid().parse(params.staff)
          : null;
      return {
        company,
        team,
        staff,
        kind: resource.kind,
        entity:
          staff ??
          team ??
          (resource.scope === "employment"
            ? z.string().uuid().parse(params.entity)
            : company),
      };
    };
    app.post(resource.path, async (c) => {
      const t = target(c.req.param()),
        result = await saveInputVersion(
          c.env.DB,
          t,
          c.get("identity").userId,
          resourceMutation.parse(await c.req.json()),
          c.env.INPUTS,
        );
      await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, t.company);
      return c.json(result);
    });
    app.get(resource.path + "/:month", async (c) => {
      const t = target(c.req.param());
      await requireManager(
        c.env.DB,
        t.company,
        t.team,
        c.get("identity").userId,
      );
      if (
        t.staff &&
        !(await c.env.DB.prepare(
          "SELECT 1 FROM staff WHERE company_id=? AND team_id=? AND id=?",
        )
          .bind(t.company, t.team, t.staff)
          .first())
      )
        throw new ProductError("NOT_FOUND", 404);
      const row = await resolveVersion(
        c.env.DB,
        t.company,
        t.kind,
        t.entity,
        inputMonth.parse(c.req.param("month")),
      );
      return c.json({
        version: row
          ? {
              id: row.operation_id,
              effectiveFrom: row.effective_from,
              revision: row.revision,
              payload: readResource(t.kind, JSON.parse(row.payload)),
            }
          : null,
      });
    });
  }
  app.post("/companies/:company/inputs/teams/:team/snapshots", async (c) => {
    const company = z.string().uuid().parse(c.req.param("company")),
      team = z.string().uuid().parse(c.req.param("team"));
    return c.json(
      await createInputSnapshot(
        c.env.DB,
        c.env.INPUTS,
        company,
        team,
        c.get("identity").userId,
        snapshotCommand.parse(await c.req.json()),
      ),
    );
  });
  app.get(
    "/companies/:company/inputs/teams/:team/snapshots/:snapshot",
    async (c) => {
      const company = z.string().uuid().parse(c.req.param("company")),
        team = z.string().uuid().parse(c.req.param("team")),
        id = z.string().uuid().parse(c.req.param("snapshot"));
      return c.json(
        await readInputSnapshot(
          c.env.DB,
          c.env.INPUTS,
          company,
          team,
          c.get("identity").userId,
          id,
        ),
      );
    },
  );
  app.get("/companies/:company/inputs/teams/:team/snapshots/:snapshot/changes", async c => {
    const params=c.req.param(), query=c.req.queries();
    if(Object.values(query).some(values=>values.length!==1))throw new ProductError('INVALID_INPUT',400);
    const parsed=inputChangesHttpQuery.parse(Object.fromEntries(Object.entries(query).map(([key,values])=>[key,values[0]])));
    return c.json(await readInputChanges(c.env,z.string().uuid().parse(params.company),
      z.string().uuid().parse(params.team),c.get('identity').userId,z.string().uuid().parse(params.snapshot),parsed));
  });
  return app;
}
