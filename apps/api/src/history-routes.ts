import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiEnv, ProductError } from "./product";
import { historyCommand } from "./history-contract";
import { inputMonth } from "./input-versions";
import { saveHistory, readHistory } from "./work-history";
import { dispatchRevalidations } from "./publication-revalidation";
export function historyRoutes() {
  const app = new Hono<ApiEnv>(),
    base = "/companies/:company/inputs/teams/:team/history";
  app.use(base + "*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    )
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    await next();
  });
  app.use(
    base + "*",
    bodyLimit({
      maxSize: 2_000_000,
      onError: (c) => c.json({ error: "INPUT_TOO_LARGE" }, 413),
    }),
  );
  app.onError((e, c) => {
    if (e instanceof ProductError) return c.json({ error: e.code }, e.status);
    if (e instanceof z.ZodError || e instanceof SyntaxError)
      return c.json({ error: "INVALID_INPUT" }, 400);
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  });
  const scope = (p: Record<string, string>) => ({
    company: z.string().uuid().parse(p.company),
    team: z.string().uuid().parse(p.team),
  });
  app.post(base, async (c) => {
    const { company, team } = scope(c.req.param());
    const result = await saveHistory(
      c.env.DB,
      company,
      team,
      c.get("identity").userId,
      historyCommand.parse(await c.req.json()),
    );
    await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
    return c.json(result);
  });
  app.get(base + "/:month", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readHistory(
        c.env.DB,
        c.env.INPUTS,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.param("month")),
      ),
    );
  });
  return app;
}
