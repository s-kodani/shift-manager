import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiEnv, ProductError } from "./product";
import { inputMonth } from "./input-versions";
import { publicationCsv } from "./publication-csv";
import { publicationCommand } from "./publication-contract";
import { readPublishedFixed, releaseFixed } from "./published-fixed";
import { releasePublishedFixed } from "./published-fixed-contract";
import {noticeCursorQuery,historyCursorQuery} from './publication-browse-contract';
import {
  dispatchRevalidations,
  revalidationHistory,
  readRevalidation,
  retryRevalidation,
} from "./publication-revalidation";
import {
  revalidationRetry,
  revalidationMessage,
} from "./revalidation-contract";
import {
  publishSchedule,
  readPublication,
  readPublicationHead,
  publicationHistory,
  publicationNotices,
  readPublicationNotice,
} from "./schedule-publications";

export function publicationRoutes() {
  const app = new Hono<ApiEnv>(),
    base = "/companies/:company/schedules/teams/:team/publications";
  app.use(base, async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    )
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    await next();
  });
  app.use(
    base,
    bodyLimit({
      maxSize: 4096,
      onError: (c) => c.json({ error: "INPUT_TOO_LARGE" }, 413),
    }),
  );
  app.use(base + "/*", async (c, next) => {
    c.header("cache-control", "no-store");
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("origin") !== c.env.AUTH_BASE_URL
    )
      return c.json({ error: "INVALID_ORIGIN" }, 403);
    await next();
  });
  app.use(
    base + "/*",
    bodyLimit({
      maxSize: 4096,
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
  const scope = (params: Record<string, string>) => ({
    company: z.string().uuid().parse(params.company),
    team: z.string().uuid().parse(params.team),
  });
  app.post(base, async (c) => {
    const { company, team } = scope(c.req.param());
    const result = await publishSchedule(
      c.env,
      company,
      team,
      c.get("identity").userId,
      publicationCommand.parse(await c.req.json()),
      (command) =>
        c.env.SOLVER.getByName(`company:${company}:team:${team}`).checkDraft(
          command,
        ),
    );
    await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
    return c.json(result);
  });
  app.get(base + "/validations/:validation", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readRevalidation(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("validation")),
      ),
    );
  });
  app.get(base + "/:publication/fixed", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readPublishedFixed(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("publication")),
      ),
    );
  });
  app.post(base + "/:publication/fixed/release", async (c) => {
    const { company, team } = scope(c.req.param());
    const data = releasePublishedFixed.parse(await c.req.json());
    if (data.publicationId !== c.req.param("publication"))
      return c.json({ error: "INVALID_INPUT" }, 400);
    const result = await releaseFixed(
      c.env,
      company,
      team,
      c.get("identity").userId,
      data,
    );
    await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
    return c.json(result);
  });
  app.get(base + "/:publication/validations", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await revalidationHistory(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("publication")),
      ),
    );
  });
  app.post(base + "/revalidation/:request/retry", async (c) => {
    const { company, team } = scope(c.req.param());
    const result = await retryRevalidation(
      c.env.DB,
      company,
      team,
      c.get("identity").userId,
      revalidationMessage.shape.requestId.parse(c.req.param("request")),
      revalidationRetry.parse(await c.req.json()),
    );
    await dispatchRevalidations(c.env.DB, c.env.COMPUTE_QUEUE, company);
    return c.json(result);
  });
  app.get(base, async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readPublicationHead(
        c.env,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.query("month")),
      ),
    );
  });
  app.get(base + "/export", async (c) => {
    const { company, team } = scope(c.req.param());
    const exported = await publicationCsv(
      c.env,
      company,
      team,
      c.get("identity").userId,
      inputMonth.parse(c.req.query("month")),
    );
    c.header("content-type", "text/csv; charset=utf-8");
    c.header(
      "content-disposition",
      `attachment; filename="${exported.filename}"`,
    );
    c.header("x-content-type-options", "nosniff");
    return c.body(exported.csv);
  });
  app.get(base + "/history", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await publicationHistory(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.query("month")),
        historyCursorQuery(c.req.query()),
      ),
    );
  });
  app.get(base + "/notices", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await publicationNotices(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        noticeCursorQuery(c.req.query()),
      ),
    );
  });
  app.post(base + "/notices/:publication/read", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readPublicationNotice(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("publication")),
      ),
    );
  });
  app.get(base + "/:publication", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readPublication(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("publication")),
      ),
    );
  });
  return app;
}
