import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type ApiEnv, ProductError } from "./product";
import { inputMonth } from "./input-versions";
import { leaveSubmission, leaveRejection, leaveCursor } from "./leave-contract";
import {
  submitLeave,
  rejectLeave,
  readLeave,
  listLeaves,
  leaveIntakeContext,
  leaveNotices,
  readLeaveNotice,
} from "./leave-intake";

import {
  cancellationCheckCommand,
  cancellationRpcResult,
  cancellationCommitCommand,
} from "./cancellation-contract";
import {
  commitLeaveCancellation,
  inspectLeaveCancellation,
} from "./leave-cancellation";
import {
  buildCancellationCandidate,
  assertCancellationCurrent,
} from "./cancellation-candidate";

export function leaveRoutes() {
  const app = new Hono<ApiEnv>(),
    base = "/companies/:company/schedules/teams/:team/leave";
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
      maxSize: 8192,
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
  const cursor = (query: Record<string, string>) =>
    query.cursorTime === undefined && query.cursorId === undefined
      ? undefined
      : leaveCursor.parse({
          recordedAt: Number(query.cursorTime),
          id: query.cursorId,
        });
  app.get(base + "/context", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await leaveIntakeContext(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.query("month")),
      ),
    );
  });
  app.get(base + "/notices", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await leaveNotices(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        cursor(c.req.query()),
      ),
    );
  });
  app.post(base + "/notices/:event/read", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readLeaveNotice(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("event")),
      ),
    );
  });
  app.get(base, async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await listLeaves(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        inputMonth.parse(c.req.query("month")),
        cursor(c.req.query()),
      ),
    );
  });
  app.post(base, async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await submitLeave(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        leaveSubmission.parse(await c.req.json()),
      ),
    );
  });
  app.get(base + "/:request", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await readLeave(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("request")),
      ),
    );
  });
  app.post(base + "/:request/cancellation-check", async (c) => {
    const { company, team } = scope(c.req.param());
    const command = {
      ...cancellationCheckCommand.parse(await c.req.json()),
      companyId: company,
      teamId: team,
      userId: c.get("identity").userId,
      requestId: z.string().uuid().parse(c.req.param("request")),
    };
    const before = await buildCancellationCandidate(c.env, command);
    const encoded = await c.env.SOLVER.getByName(
      `company:${company}:team:${team}`,
    ).checkCancellation(command);
    const response = cancellationRpcResult.parse(JSON.parse(encoded));
    if (!response.ok) throw new ProductError(response.error, response.status);
    const result = response.result;
    // The DO returns only after confirmed termination. Re-check authorization
    // and all source identities after that final external wait as well.
    await assertCancellationCurrent(c.env, before);
    if (result.candidateSha256 !== before.candidateSha256)
      throw new ProductError("VERSION_CONFLICT");
    return c.json(result);
  });
  app.post(base + "/:request/reject", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await rejectLeave(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("request")),
        leaveRejection.parse(await c.req.json()),
      ),
    );
  });
  app.post(base + "/:request/cancellation-commit", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await commitLeaveCancellation(
        c.env,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("request")),
        cancellationCommitCommand.parse(await c.req.json()),
        async (command) => {
          const encoded = await c.env.SOLVER.getByName(
            `company:${company}:team:${team}`,
          ).checkCancellation(command);
          const result = cancellationRpcResult.parse(JSON.parse(encoded));
          if (!result.ok) throw new ProductError(result.error, result.status);
          return result.result;
        },
      ),
    );
  });
  app.get(base + "/:request/cancellation-operations/:operation", async (c) => {
    const { company, team } = scope(c.req.param());
    return c.json(
      await inspectLeaveCancellation(
        c.env.DB,
        company,
        team,
        c.get("identity").userId,
        z.string().uuid().parse(c.req.param("request")),
        z.string().uuid().parse(c.req.param("operation")),
      ),
    );
  });
  return app;
}
