import { Hono } from "hono";
import { dispatchRevalidations } from "./publication-revalidation";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { revokeTeamAdmin } from "./team-admin";
import { changeStaffStatus, staffLifecycleInput } from "./staff-lifecycle";
import {
  type ApiEnv,
  ProductError,
  companyRole,
  teamRole,
  requireManager,
  createTeamInput,
  createStaffInput,
  settingsInput,
  grantInput,
  createTeam,
  createStaff,
  saveCalendarSettings,
  grantTeamAdmin,
  resolveCalendarSettings,
  month,
} from "./product";

export function productRoutes() {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    ) {
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => c.json({ error: "INPUT_TOO_LARGE" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof ProductError)
      return c.json({ error: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "INVALID_INPUT" }, 400);
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  });
  app.get("/context", async (c) => {
    const user = c.get("identity").userId;
    const companies = await c.env.DB.prepare(
      `SELECT c.id,c.name,c.revision FROM company c WHERE
      EXISTS (SELECT 1 FROM company_admin a WHERE a.company_id=c.id AND a.user_id=?) OR
      EXISTS (SELECT 1 FROM team_member m WHERE m.company_id=c.id AND m.user_id=?) ORDER BY c.id`,
    )
      .bind(user, user)
      .all<{ id: string; name: string; revision: number }>();
    const memberships = [];
    for (const company of companies.results) {
      const role = await companyRole(c.env.DB, company.id, user);
      const teams = await c.env.DB.prepare(
        `SELECT t.id,t.name,m.role,m.staff_id FROM team t
        LEFT JOIN team_member m ON m.company_id=t.company_id AND m.team_id=t.id AND m.user_id=?
        WHERE t.company_id=? AND (?='company_admin' OR m.user_id IS NOT NULL) ORDER BY t.id`,
      )
        .bind(user, company.id, role)
        .all();
      memberships.push({ ...company, role, teams: teams.results });
    }
    return c.json({ userId: user, companies: memberships });
  });
  app.post("/companies/:company/teams", async (c) => {
    return c.json(
      await createTeam(
        c.env.DB,
        c.req.param("company"),
        c.get("identity").userId,
        createTeamInput.parse(await c.req.json()),
      ),
      200,
    );
  });
  app.post("/companies/:company/teams/:team/staff", async (c) => {
    return c.json(
      await createStaff(
        c.env.DB,
        c.req.param("company"),
        c.req.param("team"),
        c.get("identity").userId,
        createStaffInput.parse(await c.req.json()),
      ),
      200,
    );
  });
  app.get("/companies/:company/teams/:team/staff", async (c) => {
    const { company, team } = c.req.param();
    await requireManager(c.env.DB, company, team, c.get("identity").userId);
    const rows = await c.env.DB.prepare(
      `SELECT s.id,s.staff_number,s.name,s.user_id,s.status,m.role,
      CASE WHEN s.user_id=? OR EXISTS(SELECT 1 FROM company_admin a WHERE a.user_id=s.user_id)
        OR EXISTS(SELECT 1 FROM team_member other WHERE other.user_id=s.user_id AND (other.company_id!=s.company_id OR other.team_id!=s.team_id))
        THEN 0 ELSE 1 END AS can_manage_status FROM staff s
      LEFT JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.user_id=s.user_id
      WHERE s.company_id=? AND s.team_id=? AND s.status!='deleted' ORDER BY s.staff_number`,
    )
      .bind(c.get("identity").userId, company, team)
      .all();
    return c.json({ staff: rows.results });
  });
  app.get("/companies/:company/teams/:team/staff/:staff", async (c) => {
    const { company, team, staff } = c.req.param();
    const user = c.get("identity").userId;
    const role = await teamRole(c.env.DB, company, team, user);
    if (!role) throw new ProductError("FORBIDDEN", 403);
    const row = await c.env.DB.prepare(
      `SELECT id,staff_number,name,user_id FROM staff WHERE company_id=? AND team_id=? AND id=?
      AND (?!='staff' OR user_id=?)`,
    )
      .bind(company, team, staff, role, user)
      .first();
    if (!row) throw new ProductError("NOT_FOUND", 404);
    return c.json(row);
  });
  app.post("/companies/:company/teams/:team/staff/:staff/status", async (c) => {
    const { company, team, staff } = c.req.param();
    return c.json(await changeStaffStatus(c.env.DB, company, team, staff,
      c.get("identity").userId, staffLifecycleInput.parse(await c.req.json())));
  });
  app.post("/companies/:company/teams/:team/admins", async (c) => {
    return c.json(
      await grantTeamAdmin(
        c.env.DB,
        c.req.param("company"),
        c.req.param("team"),
        c.get("identity").userId,
        grantInput.parse(await c.req.json()),
      ),
    );
  });
  app.post("/companies/:company/teams/:team/admins/revoke", async (c) => {
    return c.json(
      await revokeTeamAdmin(
        c.env.DB,
        c.req.param("company"),
        c.req.param("team"),
        c.get("identity").userId,
        grantInput.parse(await c.req.json()),
      ),
    );
  });
  app.post("/companies/:company/calendar-settings", async (c) => {
    const result = await saveCalendarSettings(
      c.env.DB,
      c.req.param("company"),
      c.get("identity").userId,
      settingsInput.parse(await c.req.json()),
    );
    await dispatchRevalidations(
      c.env.DB,
      c.env.COMPUTE_QUEUE,
      c.req.param("company"),
    );
    return c.json(result);
  });
  app.get("/companies/:company/calendar-settings/:month", async (c) => {
    const company = c.req.param("company");
    if (!(await companyRole(c.env.DB, company, c.get("identity").userId)))
      throw new ProductError("FORBIDDEN", 403);
    return c.json({
      version: await resolveCalendarSettings(
        c.env.DB,
        company,
        month.parse(c.req.param("month")),
      ),
    });
  });
  return app;
}
