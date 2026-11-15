import {SCHEDULE_JSON_LIMIT} from './schedule-serialization';
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiEnv, ProductError } from "./product";
import { inputMonth } from "./input-versions";
import { draftCommand } from "./draft-contract";
import {
  createDraftSnapshot,
  draftSnapshotCommand,
} from "./draft-recalculation";
import {
  DraftInvalidError,
  saveDraft,
  readDraft,
  readDraftHead,
} from "./schedule-drafts";

export function draftRoutes() {
  const app = new Hono<ApiEnv>(),
    base = "/companies/:company/schedules/teams/:team/drafts";
  app.use("/companies/:company/schedules/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    )
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    await next();
  });
  app.use(
    "/companies/:company/schedules/*",
    bodyLimit({
      maxSize: SCHEDULE_JSON_LIMIT,
      onError: (c) => c.json({ error: "INPUT_TOO_LARGE" }, 413),
    }),
  );
  app.onError((error, c) => {
    if (error instanceof DraftInvalidError)
      return c.json(
        { error: error.code, violations: error.violations },
        error.status,
      );
    if (error instanceof ProductError)
      return c.json({ error: error.code }, error.status);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: "INVALID_INPUT" }, 400);
    return c.json({ error: "INTERNAL_ERROR" }, 500);
  });
  const scope = (params: Record<string, string>) => ({
    company: z.string().uuid().parse(params.company),
    team: z.string().uuid().parse(params.team),
  });
  app.post(base, async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await saveDraft(
        c.env,
        company,
        team,
        c.get("identity").userId,
        draftCommand.parse(await c.req.json()),
        (command) =>
          c.env.SOLVER.getByName(`company:${company}:team:${team}`).checkDraft(
            command,
          ),
      ),
    );
  });
  app.get(base, async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readDraftHead(
        c.env,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.query("month")),
      ),
    );
  });
  app.get(base + "/:draft", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readDraft(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("draft")),
      ),
    );
  });
  app.post(base + "/:draft/snapshots", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await createDraftSnapshot(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("draft")),
        draftSnapshotCommand.parse(await c.req.json()),
      ),
    );
  });
  return app;
}
