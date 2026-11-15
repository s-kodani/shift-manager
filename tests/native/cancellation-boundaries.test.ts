import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it } from "vitest";
import { inputFixture } from "../../apps/api/src/input-probes";
import {
  createInputSnapshot,
  readInputSnapshot,
  sha256,
} from "../../apps/api/src/input-snapshots";
import { createJob } from "../../apps/api/src/compute-jobs";
import { executeJob } from "../../apps/api/src/compute-execution";
import {
  publishSchedule,
  readPublicationHead,
  publicationEvidence,
} from "../../apps/api/src/schedule-publications";
import { saveHistory, readHistory } from "../../apps/api/src/work-history";
import { saveInputVersion } from "../../apps/api/src/input-versions";
import {
  saveDraft,
  type DraftVerifier,
} from "../../apps/api/src/schedule-drafts";
import {
  submitLeave,
  readLeave,
  leaveNotices,
} from "../../apps/api/src/leave-intake";
import { checkCancellationCandidate } from "../../apps/api/src/cancellation-check";
import { commitLeaveCancellation } from "../../apps/api/src/leave-cancellation";
import { releaseFixed } from "../../apps/api/src/published-fixed";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../packages/contracts/optimizer-input.generated";
import type { CancellationCandidateCommand } from "../../apps/api/src/cancellation-contract";
import { publicationDocument } from "../../apps/api/src/publication-contract";
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import {saveCalendarSettings} from '../../apps/api/src/product';

// Deterministic hand-counted two-day schedule, independently validated by native Python.
// The solver seed is controlled; every original/publication/cancellation certificate is real.
const month = "2026-10";
let f: Awaited<ReturnType<typeof inputFixture>>,
  publicationId: string,
  jobId: string;
let checkerCalls = 0,
  terminationAcknowledgements = 0,
  breakKind: "fixed" | "auto" = "fixed";
const company = () => f.company.companyId,
  manager = () => f.company.userId;
const revision = async () =>
  (await env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(company())
    .first<number>("revision"))!;
async function save(
  kind: "company_policy" | "employment_policy" | "staff_contract",
  payload: unknown,
  entity?: string,
) {
  const personal = kind === "staff_contract";
  return saveInputVersion(
    env.DB,
    {
      company: company(),
      team: personal ? f.team : null,
      staff: personal ? f.staff.staffId : null,
      kind,
      entity: entity ?? (personal ? f.staff.staffId : company()),
    },
    manager(),
    {
      operationId: crypto.randomUUID(),
      expectedRevision: await revision(),
      effectiveFrom: month,
      payload,
    },
    env.INPUTS,
  );
}
async function transport(path: string, payload: unknown) {
  checkerCalls++;
  const base = (env as unknown as { CANCELLATION_NATIVE_CHECK_URL: string })
    .CANCELLATION_NATIVE_CHECK_URL;
  const checker = (env as unknown as { NATIVE_CHECKER: Fetcher })
    .NATIVE_CHECKER;
  return checker.fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
}
const check: DraftVerifier = async (c) => {
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
  const input = optimizerInputSchema.parse({
    ...frozen.input,
    locks: c.locks,
    exceptions: c.exceptions,
  });
  const r = await transport("/check", { input, assignments: c.assignments });
  expect(r.status).toBe(200);
  return {
    snapshotSha256: frozen.snapshot.sha256,
    inputSha256: await sha256(new TextEncoder().encode(JSON.stringify(input))),
    validation: await r.json(),
  };
};
const verify = (c: CancellationCandidateCommand) =>
  checkCancellationCandidate(env, c, transport, async () => {
    // RPC process fencing is covered elsewhere; this harness keeps one owned checker alive.
    terminationAcknowledgements++;
  });
const assignments = () =>
  optimizerAssignmentsSchema.parse(
    Array.from({ length: 31 }, (_, n) => ({
      staffId: f.staff.staffId,
      date: `${month}-${String(n + 1).padStart(2, "0")}`,
      shift:
        n < 2
          ? {
              patternId: "day",
              start: 600,
              end: 1020,
              breakKind,
              break: [780, 840],
              workedMinutes: 360,
              cancelled: [],
            }
          : null,
      blocks:
        n < 2
          ? Array.from({ length: 14 }, (_, i) => 600 + i * 30)
              .filter(
                (start) =>
                  ![780, 810].includes(start) && !f.plan.events.some((e) =>
                    e.date === `${month}-${String(n + 1).padStart(2, "0")}` && e.staffIds.includes(f.staff.staffId) && e.start < start + 30 && start < e.end),
              )
              .map((start) => ({
                start,
                end: start + 30,
                taskId: "phone",
                roleId: null,
              }))
          : [],
      roleIntervals: [],
    })),
  );
const head = async () =>
  publicationDocument.parse(
    (await readPublicationHead(env, company(), f.team, manager(), month))
      .publication,
  );
async function submit(
  part: "AM" | "PM" | "FULL",
  kind: "LEAVE_REQUEST" | "ABSENCE_REQUEST" | "ABSENCE_FACT" = "LEAVE_REQUEST",
) {
  const h = await head();
  const requestId = crypto.randomUUID();
  await submitLeave(
    env.DB,
    company(),
    f.team,
    kind === "ABSENCE_FACT" ? manager() : f.staffUser,
    {
      operationId: requestId,
      staffId: f.staff.staffId,
      date: month + "-01",
      part,
      kind,
      reason: "架空の境界受入",
      publicationId: h.publicationId,
      expectedPublicationRevision: h.publicationRevision,
    },
  );
  return requestId;
}
async function command() {
  const h = await head();
  return {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    expectedRequestRevision: 1,
    publicationId: h.publicationId,
    expectedPublicationRevision: h.publicationRevision,
    acknowledgeShortage: true,
  };
}
async function commit(id: string) {
  return commitLeaveCancellation(
    env,
    company(),
    f.team,
    manager(),
    id,
    await command(),
    verify,
  );
}
async function preflight(id: string) {
  const { acknowledgeShortage: _, ...c } = await command();
  return verify({
    ...c,
    companyId: company(),
    teamId: f.team,
    userId: manager(),
    requestId: id,
  });
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
async function seedJob() {
  const snapshotId = crypto.randomUUID(),
    r = await revision();
  await createInputSnapshot(env.DB, env.INPUTS, company(), f.team, manager(), {
    operationId: snapshotId,
    expectedRevision: r,
    month,
  });
  const id = (
    await createJob(env.DB, env.INPUTS, company(), f.team, manager(), {
      operationId: crypto.randomUUID(),
      snapshotId,
      expectedRevision: r,
    })
  ).job.id;
  await executeJob(
    env,
    { version: 1, companyId: company(), teamId: f.team, jobId: id },
    async (path, payload) =>
      path === "/solve"
        ? Response.json({
            ...payload,
            solverStatus: "FEASIBLE",
            assignments: assignments(),
          })
        : transport(path, payload),
    async () => {},
  );
  return id;
}
async function setup(kind: "fixed" | "auto" = "fixed", partialEvent?: "training" | "meeting") {
  breakKind = kind;
  f = await inputFixture(env.DB, env.INPUTS);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const history = await readHistory(
    env.DB,
    env.INPUTS,
    company(),
    f.team,
    manager(),
    month,
  );
  await saveHistory(env.DB, company(), f.team, manager(), {
    operationId: crypto.randomUUID(),
    expectedRevision: await revision(),
    month,
    records: history.missing.map((x) => ({
      ...x,
      workedMinutes: 0,
      evidence: "架空の確認済み月境界休日",
    })),
  });
  if (kind === "auto") {
    const { probeConfig } = await import("../../apps/api/src/input-probes");
    await saveInputVersion(
      env.DB,
      {
        company: company(),
        team: f.team,
        staff: null,
        kind: "team_config",
        entity: f.team,
      },
      manager(),
      {
        operationId: crypto.randomUUID(),
        expectedRevision: await revision(),
        effectiveFrom: month,
        payload: {
          ...probeConfig,
          patterns: [{ id: "day", start: 600, end: 1020, breakKind: "auto" }],
        },
      },
      env.INPUTS,
    );
  }
  if (partialEvent) {
    f.plan.events = [{ ...f.plan.events[0], start: 690, end: 750, kind: partialEvent }];
    await saveInputVersion(env.DB, {
      company: company(), team: f.team, staff: null, kind: "planning", entity: f.team,
    }, manager(), {
      operationId: crypto.randomUUID(), expectedRevision: await revision(),
      effectiveFrom: month, payload: f.plan,
    }, env.INPUTS);
  }
  const r = await revision();
  jobId = await seedJob();
  publicationId = crypto.randomUUID();
  await publishSchedule(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: publicationId,
      expectedRevision: r,
      expectedDraftRevision: 0,
      expectedPublicationRevision: 0,
      source: { kind: "job", id: jobId },
      acknowledgeShortage: true,
    },
    check,
  );
  expect((await head()).validation.status).toBe("VERIFIED");
  checkerCalls = 0;
  terminationAcknowledgements = 0;
}
beforeEach(async () => {
  await setup();
});

it.each(["training", "meeting"] as const)(
  "native partial %s removal refuses cancellation until manager prepares and separately publishes assigned work",
  async (kind) => {
    await setup("fixed", kind);
    const original = await head(), id = await submit("AM"), r = await revision();
    const proof = await preflight(id);
    expect(proof.validation.status).toBe("INVALID");
    expect(proof.validation.violations.some((v) => v.startsWith("WAITING:"))).toBe(true);
    expect(proof.removedParticipations).toHaveLength(1);
    await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
    expect(await head()).toEqual(original);
    expect(await revision()).toBe(r);
    expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("PENDING");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM planning_participation_removal WHERE company_id=?").bind(company()).first("n")).toBe(0);
    expect((await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices.filter((n) => n.kind === "APPROVED")).toHaveLength(0);

    // Explicit manager planning edit, validated draft, then separate publication.
    // The checker never invents assignments; cancellation remains pending throughout.
    f.plan.events = [];
    await saveInputVersion(env.DB, {
      company: company(), team: f.team, staff: null, kind: "planning", entity: f.team,
    }, manager(), {
      operationId: crypto.randomUUID(), expectedRevision: await revision(),
      effectiveFrom: month, payload: f.plan,
    }, env.INPUTS);
    expect(await head()).toEqual(original);
    const preparedRevision = await revision(), preparedJob = await seedJob(), draftId = crypto.randomUUID();
    const filled = assignments();
    await saveDraft(env, company(), f.team, manager(), {
      operationId: draftId, expectedRevision: preparedRevision, expectedDraftRevision: 0,
      sourceJobId: preparedJob, assignments: filled, locks: [], exceptions: [],
    }, check);
    expect(await head()).toEqual(original);
    await publishSchedule(env, company(), f.team, manager(), {
      operationId: crypto.randomUUID(), expectedRevision: preparedRevision,
      expectedDraftRevision: 1, expectedPublicationRevision: 1,
      source: { kind: "draft", id: draftId }, acknowledgeShortage: true,
    }, check);
    const prepared = await head();
    expect(prepared.publicationRevision).toBe(2);
    expect(prepared.assignments.map((a) => a.shift)).toEqual(original.assignments.map((a) => a.shift));
    expect(prepared.assignments[0].blocks.some((b) => b.start === 720 && b.end === 750)).toBe(true);
    expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("PENDING");
    const rechecked = await preflight(id);
    expect(rechecked.validation.status).toBe("VERIFIED");
    expect(rechecked.publicationId).toBe(prepared.publicationId);
    expect((await commit(id)).status).toBe("APPROVED");
    const current = await head();
    expect(current.publicationRevision).toBe(3);
    expect(current.assignments[0].shift).toEqual({ ...original.assignments[0].shift, cancelled: [[600, 720]], workedMinutes: 240 });
    expect(current.assignments.slice(1)).toEqual(prepared.assignments.slice(1));
    expect(current.validation.status).toBe("VERIFIED");
    expect((await leaveNotices(env.DB, company(), f.team, f.staffUser)).notices.filter((n) => n.kind === "APPROVED")).toHaveLength(1);
  },
);

it.each([
  { part: "AM" as const, worked: 240, cancelled: [600, 720], removed: 1 },
  { part: "PM" as const, worked: 120, cancelled: [720, 1020], removed: 0 },
])(
  "native fixed-rest $part cancellation preserves original times and counts overlap once",
  async ({ part, worked, cancelled, removed }) => {
    const original = await head(),
      id = await submit(part);
    const result = await commit(id),
      current = await head();
    expect(result.status).toBe("APPROVED");
    expect(current.assignments[0].shift).toEqual({
      ...original.assignments[0].shift,
      cancelled: [cancelled],
      workedMinutes: worked,
    });
    expect(current.assignments.slice(1)).toEqual(original.assignments.slice(1));
    expect(current.validation.status).toBe("VERIFIED");
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM planning_participation_removal WHERE company_id=?",
      )
        .bind(company())
        .first("n"),
    ).toBe(removed);
    expect(checkerCalls).toBeGreaterThan(0);
    expect(terminationAcknowledgements).toBe(1);
    const stored = await publicationEvidence(
      env,
      company(),
      f.team,
      publicationId,
    );
    expect(stored.document).toEqual(original);
    const notices = await leaveNotices(env.DB, company(), f.team, f.staffUser);
    expect(notices.notices.filter((n) => n.kind === "APPROVED")).toHaveLength(
      1,
    );
  },
);

it.each([
  { part: 'AM' as const, worked: 240, cancelled: [600, 720] },
  { part: 'FULL' as const, worked: 0, cancelled: [600, 1020] },
])('TS-OPS-08 native: self absence request $part requires manager approval and immediately cancels only its published work',async({part,worked,cancelled})=>{
  const original=await head(),r=await revision(),id=await submit(part,'ABSENCE_REQUEST');
  expect((await readLeave(env.DB,company(),f.team,f.staffUser,id)).record).toMatchObject({
    kind:'ABSENCE_REQUEST',status:'PENDING',staffId:f.staff.staffId,
  });
  expect(await env.DB.prepare('SELECT actor_id FROM leave_record WHERE company_id=? AND id=?').bind(company(),id).first('actor_id')).toBe(f.staffUser);
  expect(await revision()).toBe(r);expect(await head()).toEqual(original);
  const c=await command();
  await expect(commitLeaveCancellation(env,company(),f.team,f.staffUser,id,c,verify)).rejects.toThrow('FORBIDDEN');
  expect(checkerCalls).toBe(0);
  expect((await preflight(id)).validation.status).toBe('VERIFIED');
  expect(await commitLeaveCancellation(env,company(),f.team,manager(),id,c,verify)).toMatchObject({status:'APPROVED',replayed:false,publicationRevision:2});
  const current=await head();
  expect(current.assignments[0].shift).toEqual({...original.assignments[0].shift,cancelled:[cancelled],workedMinutes:worked});
  expect(current.assignments.slice(1)).toEqual(original.assignments.slice(1));
  expect(current.validation.status).toBe('VERIFIED');
  expect(await publicationEvidence(env,company(),f.team,publicationId)).toMatchObject({document:original});
  expect((await readLeave(env.DB,company(),f.team,f.staffUser,id)).record.status).toBe('APPROVED');
  expect(await env.DB.prepare('SELECT count(*) AS n FROM planning_participation_removal WHERE company_id=?').bind(company()).first('n')).toBe(1);
  const effects=await cancellationEffects(),calls=checkerCalls;
  expect(await commitLeaveCancellation(env,company(),f.team,manager(),id,c,verify)).toMatchObject({status:'APPROVED',replayed:true,publicationRevision:2});
  expect(checkerCalls).toBe(calls);expect(await cancellationEffects()).toEqual(effects);
  expect((await leaveNotices(env.DB,company(),f.team,f.staffUser)).notices.filter(n=>n.kind==='APPROVED')).toHaveLength(1);
});

it('native cancellation preserves compressed certificate integrity without changing checker decisions',async()=>{
 const id=await submit('AM'),padding='fictional'.repeat(10_000);
 await commitLeaveCancellation(env,company(),f.team,manager(),id,await command(),async(candidate)=>{const result=await verify(candidate);return {...result,validation:{...result.validation,padding}};});
 const current=await head();expect(current.assignments[0].shift?.workedMinutes).toBe(240);
 expect(current.validation.padding).toBe(padding);
 const r=await env.DB.prepare('SELECT object_key FROM schedule_publication_version WHERE company_id=? AND id=?').bind(company(),current.publicationId).first<{object_key:string}>();
 expect(isCompressedSchedule(new Uint8Array(await(await env.INPUTS.get(r!.object_key))!.arrayBuffer()))).toBe(true);
});
it("native successive AM and PM cancellations union once and exclude the entire day", async () => {
  const am = await submit("AM"),
    pm = await submit("PM", "ABSENCE_FACT");
  await commit(am);
  expect((await head()).assignments[0].shift?.workedMinutes).toBe(240);
  await commit(pm);
  const current = await head();
  expect(current.assignments[0].shift).toMatchObject({
    workedMinutes: 0,
    cancelled: [[600, 1020]],
    breakKind: "fixed",
    break: [780, 840],
  });
  expect(
    (await readLeave(env.DB, company(), f.team, manager(), pm)).record.status,
  ).toBe("CANCELLATION_CONFIRMED");
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM planning_participation_removal WHERE company_id=?",
    )
      .bind(company())
      .first("n"),
  ).toBe(1);
});

it.each(["company_policy", "employment_policy", "staff_contract"] as const)(
  "native %s minimum hours remains mandatory after cancellation and fact recording",
  async (source) => {
    const original = await head();
    if (source === "staff_contract")
      await save(source, {
        ...f.profile,
        rule: { ...f.profile.rule, monthlyMin: 720 },
      });
    else {
      const { probePolicy, probeEmployment } =
        await import("../../apps/api/src/input-probes");
      const payload =
        source === "company_policy" ? probePolicy : probeEmployment;
      await save(
        source,
        { ...payload, rule: { ...payload.rule, monthlyMin: 720 } },
        source === "employment_policy" ? f.employment : undefined,
      );
    }
    const r = await revision(),
      id = await submit("AM", "ABSENCE_FACT"),
      proof = await preflight(id);
    expect(
      proof.validation.violations.some((v) => v.startsWith("MONTHLY_HOURS")),
    ).toBe(true);
    await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
    expect(await revision()).toBe(r);
    expect(await head()).toEqual(original);
    expect(
      (await readLeave(env.DB, company(), f.team, manager(), id)).record.status,
    ).toBe("REPORTED");
  },
);

it.each(["company_policy", "employment_policy", "staff_contract"] as const)(
  "native %s minimum days count a remaining half day, then reject full cancellation",
  async (source) => {
    if (source === "staff_contract")
      await save(source, {
        ...f.profile,
        rule: { ...f.profile.rule, minDays: 2 },
      });
    else {
      const { probePolicy, probeEmployment } =
        await import("../../apps/api/src/input-probes");
      const payload =
        source === "company_policy" ? probePolicy : probeEmployment;
      await save(
        source,
        { ...payload, rule: { ...payload.rule, minDays: 2 } },
        source === "employment_policy" ? f.employment : undefined,
      );
    }
    const am = await submit("AM"),
      pm = await submit("PM");
    await commit(am);
    const original = await head(),
      r = await revision();
    const proof = await preflight(pm);
    expect(
      proof.validation.violations.some((v) => v.startsWith("MONTHLY_DAYS")),
    ).toBe(true);
    await expect(commit(pm)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
    expect(await revision()).toBe(r);
    expect(await head()).toEqual(original);
    expect(
      (await readLeave(env.DB, company(), f.team, manager(), pm)).record.status,
    ).toBe("PENDING");
  },
);

it("native explicit fixed parts block before transport, partial release still blocks, all release enables real approval", async () => {
  jobId = await seedJob();
  const draftId = crypto.randomUUID(),
    r = await revision();
  await saveDraft(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: draftId,
      expectedRevision: r,
      expectedDraftRevision: 0,
      sourceJobId: jobId,
      assignments: assignments(),
      locks: [
        {
          id: crypto.randomUUID(),
          staffId: f.staff.staffId,
          date: month + "-01",
          parts: ["pattern", "time", "break"],
          shift: assignments()[0].shift,
        },
      ],
      exceptions: [],
    },
    check,
  );
  await publishSchedule(
    env,
    company(),
    f.team,
    manager(),
    {
      operationId: crypto.randomUUID(),
      expectedRevision: r,
      expectedDraftRevision: 1,
      expectedPublicationRevision: 1,
      source: { kind: "draft", id: draftId },
      acknowledgeShortage: true,
    },
    check,
  );
  const id = await submit("AM");
  checkerCalls = 0;
  await expect(commit(id)).rejects.toThrow("LEAVE_FIXED_RELEASE_REQUIRED");
  expect(checkerCalls).toBe(0);
  const release = async (parts: ("pattern" | "time" | "break")[]) => {
    const h = await head();
    await releaseFixed(env, company(), f.team, manager(), {
      operationId: crypto.randomUUID(),
      expectedRevision: await revision(),
      publicationId: h.publicationId,
      expectedPublicationRevision: h.publicationRevision,
      staffId: f.staff.staffId,
      date: month + "-01",
      parts,
    });
  };
  await release(["pattern", "time"]);
  await expect(commit(id)).rejects.toThrow("LEAVE_FIXED_RELEASE_REQUIRED");
  expect(checkerCalls).toBe(0);
  await release(["break"]);
  expect((await commit(id)).status).toBe("APPROVED");
  expect((await head()).assignments[0].shift).toMatchObject({
    workedMinutes: 240,
    breakKind: "fixed",
    break: [780, 840],
  });
  expect(checkerCalls).toBeGreaterThan(0);
});

it("native automatic rest remains automatic: incompatible AM cancellation is refused unchanged", async () => {
  await setup("auto");
  const original = await head(),
    id = await submit("AM"),
    r = await revision();
  const proof = await preflight(id);
  expect(
    proof.validation.violations.some((v) => v.startsWith("BREAK_QUANTITY")),
  ).toBe(true);
  await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
  expect(await revision()).toBe(r);
  expect(await head()).toEqual(original);
  expect(
    (await readLeave(env.DB, company(), f.team, manager(), id)).record.status,
  ).toBe("PENDING");
});

it("native PM cancellation containing all automatic rest excludes it once without moving or converting it", async () => {
  await setup("auto");
  const id = await submit("PM");
  await commit(id);
  expect((await head()).assignments[0].shift).toMatchObject({
    workedMinutes: 120,
    cancelled: [[720, 1020]],
    breakKind: "auto",
    break: [780, 840],
    start: 600,
    end: 1020,
  });
});

const lowerBoundLayers = ["company_policy", "employment_policy", "staff_contract"] as const;
async function setCancellationLowerBound(
  source: typeof lowerBoundLayers[number],
  rule: { monthlyMin?: number; minDays?: number },
) {
  const { probePolicy, probeEmployment } = await import("../../apps/api/src/input-probes");
  const payload = source === "staff_contract" ? f.profile : source === "company_policy" ? probePolicy : probeEmployment;
  await save(source, { ...payload, rule: { ...payload.rule, ...rule } }, source === "employment_policy" ? f.employment : undefined);
}
async function cancellationEffects() {
  return env.DB.prepare(`SELECT
    (SELECT count(*) FROM schedule_publication_version WHERE company_id=?) publications,
    (SELECT count(*) FROM leave_cancellation_operation WHERE company_id=?) operations,
    (SELECT count(*) FROM planning_participation_removal WHERE company_id=?) removals,
    (SELECT count(*) FROM leave_cancellation_notice WHERE company_id=?) notices,
    (SELECT count(*) FROM product_audit WHERE company_id=? AND kind='schedule:cancelled') audits`)
    .bind(company(), company(), company(), company(), company()).first<{
      publications: number; operations: number; removals: number; notices: number; audits: number;
    }>();
}
it.each(lowerBoundLayers.flatMap(source => [600, 601].map(minimum => ({ source, minimum }))))(
  "native $source monthly minimum $minimum compares exact remaining 600 minutes",
  async ({ source, minimum }) => {
    await setCancellationLowerBound(source, { monthlyMin: minimum });
    const id = await submit("AM"), original = await head(), r = await revision(), effects = await cancellationEffects();
    const proof = await preflight(id);
    if (minimum === 600) {
      expect(proof.validation.status).toBe("VERIFIED");
      await commit(id);
      const current = await head();
      expect(current.assignments.reduce((sum, a) => sum + (a.shift?.workedMinutes ?? 0), 0)).toBe(600);
      expect(current.assignments[0].shift).toMatchObject({start:600,end:1020,break:[780,840],breakKind:"fixed",workedMinutes:240,cancelled:[[600,720]]});
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("APPROVED");
      expect(await cancellationEffects()).toEqual({ publications: effects!.publications + 1, operations: effects!.operations + 1, removals: effects!.removals + 1, notices: effects!.notices + 1, audits: effects!.audits + 1 });
    } else {
      expect(proof.validation.status).toBe("INVALID");
      expect(proof.validation.violations.some(v => v.startsWith("MONTHLY_HOURS"))).toBe(true);
      await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
      expect(await head()).toEqual(original); expect(await revision()).toBe(r);
      expect(await cancellationEffects()).toEqual(effects);
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("PENDING");
      // An explicit manager setting change is a separate operation. The same
      // pending request may be approved only after fresh real verification.
      await setCancellationLowerBound(source, { monthlyMin: 600 });
      expect((await preflight(id)).validation.status).toBe("VERIFIED");
      await commit(id);
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("APPROVED");
      expect((await head()).assignments.reduce((sum, a) => sum + (a.shift?.workedMinutes ?? 0), 0)).toBe(600);
      expect(await cancellationEffects()).toEqual({ publications: effects!.publications + 1, operations: effects!.operations + 1, removals: effects!.removals + 1, notices: effects!.notices + 1, audits: effects!.audits + 1 });
    }
  },
);
it.each(lowerBoundLayers.flatMap(source => [1, 2].map(minimum => ({ source, minimum }))))(
  "native $source monthly minimum $minimum days compares one remaining day",
  async ({ source, minimum }) => {
    await setCancellationLowerBound(source, { minDays: minimum });
    const id = await submit("FULL"), original = await head(), r = await revision(), effects = await cancellationEffects();
    const proof = await preflight(id);
    if (minimum === 1) {
      expect(proof.validation.status).toBe("VERIFIED"); await commit(id);
      const current = await head();
      expect(current.assignments.filter(a => (a.shift?.workedMinutes ?? 0) > 0)).toHaveLength(1);
      expect(current.assignments[0].shift).toMatchObject({start:600,end:1020,break:[780,840],breakKind:"fixed",workedMinutes:0,cancelled:[[600,1020]]});
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("APPROVED");
      expect(await cancellationEffects()).toEqual({ publications: effects!.publications + 1, operations: effects!.operations + 1, removals: effects!.removals + 1, notices: effects!.notices + 1, audits: effects!.audits + 1 });
    } else {
      expect(proof.validation.status).toBe("INVALID");
      expect(proof.validation.violations.some(v => v.startsWith("MONTHLY_DAYS"))).toBe(true);
      await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
      expect(await head()).toEqual(original); expect(await revision()).toBe(r);
      expect(await cancellationEffects()).toEqual(effects);
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("PENDING");
      await setCancellationLowerBound(source, { minDays: 1 });
      expect((await preflight(id)).validation.status).toBe("VERIFIED");
      await commit(id);
      expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("APPROVED");
      expect((await head()).assignments.filter(a => (a.shift?.workedMinutes ?? 0) > 0)).toHaveLength(1);
      expect(await cancellationEffects()).toEqual({ publications: effects!.publications + 1, operations: effects!.operations + 1, removals: effects!.removals + 1, notices: effects!.notices + 1, audits: effects!.audits + 1 });
    }
  },
);
it.each(["fixed", "auto"] as const)(
  "native partial cancellation leaves only 30 of required 60 rest minutes for %s",
  async kind => {
    if (kind === "auto") await setup("auto");
    const { probePolicy } = await import("../../apps/api/src/input-probes");
    await save("company_policy", { ...probePolicy, breakRule: { ...probePolicy.breakRule, threshold: 180, afterStart: 0, beforeEnd: 0 } });
    await saveCalendarSettings(env.DB, company(), manager(), {
      operationId: crypto.randomUUID(), expectedRevision: await revision(), effectiveFrom: month,
      settings: {weekStart:0,deadlineDay:20,halfDayDivider:810,roleRounding:"floor"},
    });
    const id = await submit("AM"), original = await head(), r = await revision(), effects = await cancellationEffects();
    const proof = await preflight(id);
    expect(proof.validation.status).toBe("INVALID");
    expect(proof.validation.violations.some(v => v.startsWith("BREAK_QUANTITY"))).toBe(true);
    await expect(commit(id)).rejects.toThrow("CANCELLATION_NOT_VERIFIED");
    expect(await head()).toEqual(original); expect(await revision()).toBe(r);
    expect(await cancellationEffects()).toEqual(effects);
    expect((await readLeave(env.DB, company(), f.team, manager(), id)).record.status).toBe("PENDING");
  },
);

it("native different half cancellations from one version have one winner; explicit fresh verification completes the other", async () => {
  const ids = [await submit("AM"), await submit("PM", "ABSENCE_FACT")];
  const commands = [await command(), await command()];
  let proofs = 0,
    release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  // This test targets two commits racing on one D1 version, not two engines
  // running in the same process. Obtain both real proofs serially, then hold
  // each before commit. Production DO/process concurrency is tested separately.
  let verificationTail = Promise.resolve();
  const concurrentVerifier = async (c: CancellationCandidateCommand) => {
    const pending = verificationTail.then(() => verify(c));
    verificationTail = pending.then(() => undefined, () => undefined);
    let proof: Awaited<ReturnType<typeof verify>>;
    try {
      proof = await pending;
    } catch (error) {
      release(); // A failed proof must fail the test, not strand its peer.
      throw error;
    }
    if (++proofs === 2) release();
    await barrier;
    return proof;
  };
  const attempts = await Promise.allSettled(
    ids.map((id, i) =>
      commitLeaveCancellation(
        env,
        company(),
        f.team,
        manager(),
        id,
        commands[i],
        concurrentVerifier,
      ),
    ),
  );
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const loser = attempts.findIndex((r) => r.status === "rejected");
  const failed = attempts[loser] as PromiseRejectedResult;
  expect(String(failed.reason)).toMatch(
    /VERSION_CONFLICT|PUBLICATION_CONFLICT/,
  );
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM leave_cancellation_operation WHERE company_id=?",
    )
      .bind(company())
      .first("n"),
  ).toBe(1);
  // This is a reviewed, fresh command after a definite conflict, not an unknown-response retry.
  await commit(ids[loser]);
  expect((await head()).assignments[0].shift?.workedMinutes).toBe(0);
  expect((await head()).assignments[0].shift?.cancelled).toEqual([[600, 1020]]);
  const notices = (await leaveNotices(env.DB, company(), f.team, f.staffUser))
    .notices;
  expect(
    notices.filter((n) =>
      ["APPROVED", "CANCELLATION_CONFIRMED"].includes(n.kind),
    ),
  ).toHaveLength(2);
});
