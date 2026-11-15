import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, expect, it,vi } from "vitest";
import { inputFixture, probePolicy, probeConfig } from "../../apps/api/src/input-probes";
import {
  createInputSnapshot,
  readInputSnapshot,
  sha256,
  loadSources,
  compileInput,
} from "../../apps/api/src/input-snapshots";
import { createJob, readJobResult } from "../../apps/api/src/compute-jobs";
import { executeJob } from "../../apps/api/src/compute-execution";
import {
  optimizerAssignmentsSchema,
  optimizerInputSchema,
} from "../../packages/contracts/optimizer-input.generated";
import { publicationCommand } from "../../apps/api/src/publication-contract";
import {
  publishSchedule,
  readPublication,
  readPublicationHead,
  publicationHistory,
  publicationNotices,
  readPublicationNotice,
} from "../../apps/api/src/schedule-publications";
import {
  saveDraft,
  type DraftVerifier,
} from "../../apps/api/src/schedule-drafts";
import { saveHistory, historyQuery } from "../../apps/api/src/work-history";
import { createApp } from "../../apps/api/src/index";
import {isCompressedSchedule} from '../../apps/api/src/schedule-serialization';
import { saveInputVersion, type InputDatabase } from "../../apps/api/src/input-versions";
import {
  releaseFixed,
  readPublishedFixed,
  loadPublishedFixed,
  assertPublishedLocks,
  ensureFixedSource,
} from "../../apps/api/src/published-fixed";
import { createDraftSnapshot } from "../../apps/api/src/draft-recalculation";
import { changeStaffStatus } from "../../apps/api/src/staff-lifecycle";
import { readInputReadiness } from "../../apps/api/src/input-readiness";
import { createStaff } from "../../apps/api/src/product";
import { checkDraftCandidate } from "../../apps/api/src/draft-check";
import { readInputChanges } from '../../apps/api/src/input-changes';
import { inputChangeCategory } from '../../apps/api/src/input-changes-contract';

let f: Awaited<ReturnType<typeof inputFixture>>,
  snapshotId: string,
  jobId: string;
const assignments = () =>
  optimizerAssignmentsSchema.parse(
    Array.from({ length: 31 }, (_, i) => ({
      staffId: f.staff.staffId,
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      shift:
        i === 0
          ? {
              patternId: "day",
              start: 600,
              end: 1020,
              breakKind: "fixed",
              break: [780, 840],
              workedMinutes: 360,
              cancelled: [],
            }
          : null,
      blocks:
        i === 0
          ? Array.from({ length: 14 }, (_, n) => 600 + n * 30)
              .filter((n) => ![660, 780, 810].includes(n))
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
const validation = () => ({
  scope: "multi-task-v1",
  status: "VERIFIED",
  violations: [],
  missingHistory: [],
  generalShortage: 0,
  roleSameShortage: 0,
  roleRequirements: [],
});
const verifier =
  (v: unknown = validation()): DraftVerifier =>
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
    const input = optimizerInputSchema.parse({
      ...frozen.input,
      locks: c.locks,
      exceptions: c.exceptions,
    });
    return {
      snapshotSha256: frozen.snapshot.sha256,
      inputSha256: await sha256(
        new TextEncoder().encode(JSON.stringify(input)),
      ),
      validation: v,
    };
  };
const command = () =>
  publicationCommand.parse({
    operationId: crypto.randomUUID(),
    expectedRevision: f.revision,
    expectedDraftRevision: 0,
    expectedPublicationRevision: 0,
    source: { kind: "job", id: jobId },
    acknowledgeShortage: false,
  });
const publish = (
  c = command(),
  verify = verifier(),
  e: Parameters<typeof publishSchedule>[0] = env,
) =>
  publishSchedule(e, f.company.companyId, f.team, f.company.userId, c, verify);
const revision = () =>
  env.DB.prepare("SELECT revision FROM company WHERE id=?")
    .bind(f.company.companyId)
    .first<number>("revision");
function sqlObserver() {
  const queries=new WeakMap<D1PreparedStatement,string>();
  const prepare=(sql:string)=>{
    const statement=env.DB.prepare(sql);queries.set(statement,sql);
    return new Proxy(statement,{get(target,key){
      if(key==='bind')return (...values:Parameters<D1PreparedStatement['bind']>)=>{const bound=target.bind(...values);queries.set(bound,sql);return bound;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  };
  return {prepare,queries};
}
async function legacyFixedFixture(){
  const a=assignments(),draftId=crypto.randomUUID();
  const locks=optimizerInputSchema.shape.locks.parse([{id:'legacy-full',staffId:f.staff.staffId,date:a[0].date,parts:['pattern','time','break'],shift:a[0].shift}]);
  const exceptions=optimizerInputSchema.shape.exceptions.parse([{id:'legacy-exception',lockId:'legacy-full',staffId:f.staff.staffId,date:a[0].date,start:607,end:617,reason:'Fictional legacy placement'}]);
  await saveDraft(env,f.company.companyId,f.team,f.company.userId,{operationId:draftId,expectedRevision:f.revision,expectedDraftRevision:0,sourceJobId:jobId,assignments:a,locks,exceptions},verifier());
  const c={...command(),expectedDraftRevision:1,source:{kind:'draft' as const,id:draftId}};await publish(c);
  // A pre-metadata publication has the same immutable R2 evidence/assignments.
  // Only this fixture removes metadata; normal code keeps deletion forbidden.
  const triggers=await env.DB.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('published_fixed_seal_delete','published_fixed_exception_delete','published_fixed_lock_delete','published_fixed_source_delete')").all<{name:string;sql:string}>();
  expect(triggers.results).toHaveLength(4);
  try{
    for(const t of triggers.results)await env.DB.prepare(`DROP TRIGGER ${t.name}`).run();
    for(const table of ['published_fixed_seal','published_fixed_exception','published_fixed_lock','published_fixed_source'])await env.DB.prepare(`DELETE FROM ${table} WHERE company_id=? AND publication_id=?`).bind(f.company.companyId,c.operationId).run();
  }finally{for(const t of triggers.results)await env.DB.prepare(t.sql).run();}
  const before=await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  return {id:c.operationId,locks,exceptions,before,revision:await revision()};
}
it.each(['source','lock','exception','seal'])('legacy fixed hydration silent %s omission rolls back metadata without changing public work',async fault=>{
  const old=await legacyFixedFixture();
  await env.DB.prepare(`CREATE TRIGGER legacy_fixed_silent_omission BEFORE INSERT ON published_fixed_${fault} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(ensureFixedSource(env,f.company.companyId,f.team,old.id)).rejects.toThrow();
    for(const table of ['source','lock','exception','seal'])expect(await env.DB.prepare(`SELECT count(*) n FROM published_fixed_${table} WHERE company_id=? AND publication_id=?`).bind(f.company.companyId,old.id).first('n')).toBe(0);
  }finally{await env.DB.prepare('DROP TRIGGER legacy_fixed_silent_omission').run();}
  await ensureFixedSource(env,f.company.companyId,f.team,old.id);
  const fixed=await loadPublishedFixed(env.DB,f.company.companyId,old.id);expect(fixed.originalLocks).toEqual(old.locks);expect(fixed.exceptions).toEqual(old.exceptions);
  expect(await revision()).toBe(old.revision);expect(await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10')).toEqual(old.before);
});
it.each(['missing','digest'])('legacy fixed hydration rejects %s R2 evidence before exposing metadata',async fault=>{
  const old=await legacyFixedFixture(),row=await env.DB.prepare('SELECT object_key FROM schedule_publication_version WHERE company_id=? AND id=?').bind(f.company.companyId,old.id).first<{object_key:string}>();
  const original=new Uint8Array(await(await env.INPUTS.get(row!.object_key))!.arrayBuffer());
  if(fault==='missing')await env.INPUTS.delete(row!.object_key);else{const changed=original.slice();changed[0]^=1;await env.INPUTS.put(row!.object_key,changed);}
  await expect(ensureFixedSource(env,f.company.companyId,f.team,old.id)).rejects.toThrow(fault==='missing'?'PUBLICATION_OBJECT_MISSING':'PUBLICATION_DIGEST_MISMATCH');
  expect(await env.DB.prepare('SELECT 1 FROM published_fixed_source WHERE company_id=? AND publication_id=?').bind(f.company.companyId,old.id).first()).toBeNull();
  await env.INPUTS.put(row!.object_key,original);await ensureFixedSource(env,f.company.companyId,f.team,old.id);expect((await loadPublishedFixed(env.DB,f.company.companyId,old.id)).exceptions).toEqual(old.exceptions);expect(await revision()).toBe(old.revision);
});
it('legacy fixed hydration rejects foreign team and concurrent identical reads create one complete source',async()=>{
  const old=await legacyFixedFixture();await expect(ensureFixedSource(env,f.company.companyId,crypto.randomUUID(),old.id)).rejects.toMatchObject({code:'NOT_FOUND'});
  await Promise.all([ensureFixedSource(env,f.company.companyId,f.team,old.id),ensureFixedSource(env,f.company.companyId,f.team,old.id)]);
  for(const table of ['source','lock','exception','seal'])expect(await env.DB.prepare(`SELECT count(*) n FROM published_fixed_${table} WHERE company_id=? AND publication_id=?`).bind(f.company.companyId,old.id).first('n')).toBe(1);
  expect((await loadPublishedFixed(env.DB,f.company.companyId,old.id)).originalLocks).toEqual(old.locks);expect(await revision()).toBe(old.revision);expect(await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10')).toEqual(old.before);
});
it('publication notice silent read omission refuses success and can repeat after repair without moving read time',async()=>{
  const c=command();await publish(c);
  await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  await env.DB.prepare('CREATE TRIGGER publication_notice_silent_update BEFORE UPDATE ON schedule_publication_notice BEGIN SELECT RAISE(IGNORE); END').run();
  try{
    await expect(readPublicationNotice(env.DB,f.company.companyId,f.team,f.staffUser,c.operationId)).rejects.toThrow();
    expect(await env.DB.prepare('SELECT read_at FROM schedule_publication_notice WHERE company_id=? AND publication_id=? AND user_id=?').bind(f.company.companyId,c.operationId,f.staffUser).first('read_at')).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER publication_notice_silent_update').run();}
  const seen=await readPublicationNotice(env.DB,f.company.companyId,f.team,f.staffUser,c.operationId);expect(seen).toMatchObject({read:true,changed:true});
  expect(await readPublicationNotice(env.DB,f.company.companyId,f.team,f.staffUser,c.operationId)).toMatchObject({read:true,changed:false,readAt:seen.readAt});
});
const count = (table: string, id: string) =>
  env.DB.prepare(
    `SELECT count(*) AS n FROM ${table} WHERE company_id=? AND ${table === "product_audit" || table === "schedule_publication_version" ? "id" : "publication_id"}=?`,
  )
    .bind(f.company.companyId, id)
    .first("n");
async function absent(id: string) {
  for (const table of [
    "schedule_publication_version",
    "schedule_publication_assignment",
    "schedule_publication_event",
    "schedule_publication_notice",
    "schedule_publication_commit",
    "product_audit",
  ])
    expect(await count(table, id)).toBe(0);
  expect(await revision()).toBe(f.revision);
  expect(
    (
      await readPublicationHead(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      )
    ).publication,
  ).toBeNull();
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  f = await inputFixture(env.DB, env.INPUTS);
  snapshotId = crypto.randomUUID();
  await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { operationId: snapshotId, expectedRevision: f.revision, month: "2026-10" },
  );
  jobId = (
    await createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId,
        expectedRevision: f.revision,
      },
    )
  ).job.id;
  // Real D1/R2 and orchestration, controlled checker/solver transport. These
  // tests prove persistence/authorization, not native constraint correctness.
  await executeJob(
    env,
    { version: 1, companyId: f.company.companyId, teamId: f.team, jobId },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: assignments() }
          : validation(),
      ),
    async () => {},
  );
});
it('compressed publication certificates retain staff/manager reads and stored-byte integrity',async()=>{
 const c=command(),padding='fictional'.repeat(10_000);
 await publish(c,verifier({...validation(),padding}));
 const row=await env.DB.prepare('SELECT object_key FROM schedule_publication_version WHERE company_id=? AND id=?').bind(f.company.companyId,c.operationId).first<{object_key:string}>();
 const bytes=new Uint8Array(await(await env.INPUTS.get(row!.object_key))!.arrayBuffer());
 expect(isCompressedSchedule(bytes)).toBe(true);
 const head=await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10');
 expect(head.publication&&'validation' in head.publication?head.publication.validation.padding:undefined).toBe(padding);
 bytes[bytes.length-1]^=1;await env.INPUTS.put(row!.object_key,bytes);
 await expect(readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10')).rejects.toThrow('PUBLICATION_DIGEST_MISMATCH');
});
it("WP-07: publication rechecks actual immutable source, then commits version/facts/audit/inbox once; replay never invokes checker again", async () => {
  const c = command();
  let calls = 0;
  const check: DraftVerifier = async (candidate) => {
    calls++;
    expect(candidate.assignments).toEqual(assignments());
    return verifier()(candidate);
  };
  expect(await publish(c, check)).toMatchObject({
    publication: "PUBLISHED",
    revision: f.revision + 1,
    publicationRevision: 1,
    replayed: false,
  });
  const differences = await readInputChanges(env, f.company.companyId, f.team, f.company.userId, snapshotId,
    {expectedRevision:(await revision())!, expectedDraftRevision:0, offset:0});
  expect(differences.totals.publication).toBeGreaterThan(0);
  expect(differences.totals.input + differences.totals.publication).toBe(differences.total);
  expect(differences.changes.find(change => change.path[0] === 'mode')).toMatchObject({before:'draft', after:'reallocation'});
  expect(differences.changes.filter(change => inputChangeCategory(change) === 'publication').some(change => change.path[1] === 'published_schedule')).toBe(true);
  expect(
    await publish(c, async () => {
      throw new Error("MUST_NOT_RECHECK_REPLAY");
    }),
  ).toMatchObject({ replayed: true });
  expect(calls).toBe(1);
  expect(await revision()).toBe(f.revision + 1);
  expect(await count("schedule_publication_assignment", c.operationId)).toBe(
    31,
  );
  for (const table of [
    "schedule_publication_version",
    "schedule_publication_event",
    "schedule_publication_commit",
    "product_audit",
  ])
    expect(await count(table, c.operationId)).toBe(1);
  expect(await count("schedule_publication_notice", c.operationId)).toBe(1);
  expect(
    await readPublication(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).toMatchObject({
    publication: {
      source: c.source,
      assignments: assignments(),
      validation: validation(),
    },
    revalidationRequired: false,
    superseded: false,
  });
  expect(
    (
      await publicationHistory(
        env.DB,
        f.company.companyId,
        f.team,
        f.company.userId,
        "2026-10",
      )
    ).versions,
  ).toHaveLength(1);
  await expect(publish({ ...c, acknowledgeShortage: true })).rejects.toThrow(
    "OPERATION_ID_CONFLICT",
  );
});
it("Q81/Q82: history-unverified, invalid, even inconsistent VERIFIED certificates cannot be published", async () => {
  for (const v of [
    { ...validation(), status: "HISTORY_UNVERIFIED" },
    { ...validation(), status: "INVALID", violations: ["DAILY_MAX"] },
    { ...validation(), missingHistory: ["boundary"] },
    { ...validation(), violations: ["BREAK"] },
  ]) {
    const c = command();
    await expect(publish(c, verifier(v))).rejects.toThrow(
      "PUBLICATION_NOT_VERIFIED",
    );
    await absent(c.operationId);
  }
});
it("ordinary general and role shortage require explicit manager acknowledgement, never loosen mandatory conditions", async () => {
  for (const v of [
    { ...validation(), generalShortage: 30 },
    { ...validation(), roleSameShortage: 30 },
    {
      ...validation(),
      roleRequirements: [{ id: "role", shortagePersonMinutes: 30 }],
    },
  ]) {
    const c = command();
    await expect(publish(c, verifier(v))).rejects.toThrow(
      "PUBLICATION_SHORTAGE_ACK_REQUIRED",
    );
    await absent(c.operationId);
  }
  const c = { ...command(), acknowledgeShortage: true };
  await publish(c, verifier({ ...validation(), generalShortage: 30 }));
  expect(
    (
      await readPublication(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.operationId,
      )
    ).publication,
  ).toMatchObject({
    shortageAcknowledged: true,
    validation: { generalShortage: 30 },
  });
});
it("publication fails closed on missing shortage metrics, checker identity mismatch, busy or unconfirmed process stop", async () => {
  const c = command();
  await expect(
    publish(c, async (candidate) => ({
      ...((await verifier()(candidate)) as object),
      inputSha256: "0".repeat(64),
    })),
  ).rejects.toThrow("PUBLICATION_CHECK_IDENTITY_MISMATCH");
  await expect(
    publish(
      c,
      verifier({
        scope: "multi-task-v1",
        status: "VERIFIED",
        violations: [],
      } as ReturnType<typeof validation>),
    ),
  ).rejects.toThrow();
  await expect(
    publish(c, async () => {
      throw new Error("CHECK_BUSY");
    }),
  ).rejects.toThrow("CHECK_BUSY");
  await expect(
    publish(c, async () => {
      throw new Error("PROCESS_STOP_UNCONFIRMED");
    }),
  ).rejects.toThrow("PROCESS_STOP_UNCONFIRMED");
  await absent(c.operationId);
});
it("the latest saved manual draft is rechecked and published, preserving original result and fixed/reason evidence", async () => {
  const operationId = crypto.randomUUID(),
    a = assignments(),
    locks = [
      {
        id: "full",
        staffId: f.staff.staffId,
        date: a[0].date,
        parts: ["pattern", "time", "break"],
        shift: a[0].shift,
      },
    ];
  await saveDraft(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId,
      expectedRevision: f.revision,
      expectedDraftRevision: 0,
      sourceJobId: jobId,
      assignments: a,
      locks: optimizerInputSchema.shape.locks.parse(locks),
      exceptions: [],
    },
    verifier(),
  );
  const stale = await readJobResult(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    jobId,
  );
  expect(stale.stale).toBe(true);
  const c = {
    ...command(),
    expectedDraftRevision: 1,
    source: { kind: "draft" as const, id: operationId },
  };
  await publish(c);
  expect(
    (
      await readPublication(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.operationId,
      )
    ).publication,
  ).toMatchObject({ source: c.source, locks });
  expect(
    (
      await readJobResult(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        jobId,
      )
    ).result.assignments,
  ).toEqual(a);
});
it("Q12/Q70: a new frozen input is reallocation against every published time/break/off-day and records its publication lineage", async () => {
  const c = command();
  await publish(c);
  const sources = await loadSources(
    env.DB,
    f.company.companyId,
    f.team,
    "2026-10",
  );
  const compiled = compileInput(
    f.company.companyId,
    f.team,
    "2026-10",
    crypto.randomUUID(),
    sources,
  );
  expect(compiled.input.mode).toBe("reallocation");
  expect(compiled.input.published).toEqual(
    assignments().map(({ staffId, date, shift }) => ({ staffId, date, shift })),
  );
  expect(compiled.lineage).toContainEqual({
    kind: "published_schedule",
    entity: f.team,
    version: c.operationId,
    revision: 1,
  });
  expect(compiled.input.published[0].shift).toMatchObject({
    start: 600,
    end: 1020,
    break: [780, 840],
  });
  const snapshot = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: f.revision + 1,
      month: "2026-10",
    },
  );
  expect(
    (
      await readInputSnapshot(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        snapshot.snapshot!.id,
        true,
      )
    ).input.mode,
  ).toBe("reallocation");
  await expect(
    createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        expectedRevision: f.revision + 1,
        snapshotId,
      },
    ),
  ).rejects.toThrow("VERSION_CONFLICT");
});
it("Q98: adjacent published work overrides prior manually confirmed history, and manual history cannot alter published facts", async () => {
  const c = command();
  await publish(c);
  const rows = (
    await historyQuery(env.DB, f.company.companyId, f.team, "2026-11").all()
  ).results;
  expect(rows).toContainEqual({
    staffId: f.staff.staffId,
    date: "2026-10-01",
    workedMinutes: 360,
    evidence: "公開済み勤務版 " + c.operationId,
    operationId: c.operationId,
    revision: f.revision + 1,
    source: "published",
  });
  expect(rows).toHaveLength(31);
  await expect(
    saveHistory(env.DB, f.company.companyId, f.team, f.company.userId, {
      operationId: crypto.randomUUID(),
      expectedRevision: f.revision + 1,
      month: "2026-11",
      records: [
        {
          staffId: f.staff.staffId,
          date: "2026-10-01",
          workedMinutes: 0,
          evidence: "Must not override publication",
        },
      ],
    }),
  ).rejects.toThrow("PUBLISHED_HISTORY_READ_ONLY");
  expect(await revision()).toBe(f.revision + 1);
});
it("published attendance rejects adding events on published off-days or across the preserved break", async () => {
  await publish();
  for (const event of [
    { date: "2026-10-01", start: 780, end: 810 },
    { date: "2026-10-02", start: 600, end: 630 },
  ]) {
    const sources = await loadSources(
      env.DB,
      f.company.companyId,
      f.team,
      "2026-10",
    );
    sources.versions.find((v) => v.kind === "planning")!.payload =
      JSON.stringify({
        ...f.plan,
        events: [{ ...f.plan.events[0], ...event }],
      });
    expect(() =>
      compileInput(
        f.company.companyId,
        f.team,
        "2026-10",
        crypto.randomUUID(),
        sources,
      ),
    ).toThrow("EVENT_ATTENDANCE_CONFLICT");
  }
});
it("a condition change during checker I/O rejects publication with no partial visible state", async () => {
  const c = command();
  await expect(
    publish(c, async (candidate) => {
      const proof = await verifier()(candidate);
      await env.DB.prepare("UPDATE company SET revision=revision+1 WHERE id=?")
        .bind(f.company.companyId)
        .run();
      return proof;
    }),
  ).rejects.toThrow("VERSION_CONFLICT");
  for (const table of [
    "schedule_publication_version",
    "schedule_publication_event",
    "schedule_publication_notice",
    "schedule_publication_commit",
    "product_audit",
  ])
    expect(await count(table, c.operationId)).toBe(0);
});
it("a new manual edit during publication upload wins, rolling back all losing publication records and retaining uncertain R2 bytes", async () => {
  const c = command(),
    bucket = new Proxy(env.INPUTS, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const r = await target.put(...args);
            await saveDraft(
              env,
              f.company.companyId,
              f.team,
              f.company.userId,
              {
                operationId: crypto.randomUUID(),
                expectedRevision: f.revision,
                expectedDraftRevision: 0,
                sourceJobId: jobId,
                assignments: assignments(),
                locks: [],
                exceptions: [],
              },
              verifier(),
            );
            return r;
          };
        const v = Reflect.get(target, key);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  await expect(
    publish(c, verifier(), { DB: env.DB, INPUTS: bucket }),
  ).rejects.toThrow("DRAFT_VERSION_CONFLICT");
  await absent(c.operationId);
  expect(
    (
      await env.INPUTS.list({
        prefix: `companies/${f.company.companyId}/teams/${f.team}/publications/2026-10/${c.operationId}/`,
      })
    ).objects,
  ).toHaveLength(1);
});
it("mid-batch permission revocation and audit failure roll back facts, company/head revisions and notices", async () => {
  for (const fail of ["permission", "audit"]) {
    const observed=sqlObserver();
    const c = command(),
      db: InputDatabase = {
        prepare: observed.prepare,
        batch: async (statements) => {
          const beforeCommit=statements.findIndex(s=>/^INSERT INTO schedule_publication_commit\b/.test(observed.queries.get(s)??''));
          if(beforeCommit<0)return env.DB.batch(statements);
          const injected =
            fail === "permission"
              ? env.DB.prepare(
                  "UPDATE access_state SET enabled=0 WHERE user_id=?",
                ).bind(f.company.userId)
              : env.DB.prepare(
                  "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'collision',?,?)",
                ).bind(
                  f.company.companyId,
                  c.operationId,
                  f.company.userId,
                  f.revision,
                  Date.now(),
                );
          return env.DB.batch([
            ...statements.slice(0, beforeCommit),
            injected,
            ...statements.slice(beforeCommit),
          ]);
        },
      };
    await expect(
      publish(c, verifier(), { DB: db, INPUTS: env.INPUTS }),
    ).rejects.toThrow();
    await absent(c.operationId);
    expect(
      await env.DB.prepare("SELECT enabled FROM access_state WHERE user_id=?")
        .bind(f.company.userId)
        .first("enabled"),
    ).toBe(1);
  }
});
it("same operation retries and competing publications produce exactly one complete winning publication", async () => {
  const c = command(),
    results = await Promise.all([publish(c), publish(c)]);
  expect(results.filter((r) => r.replayed)).toHaveLength(1);
  expect(await revision()).toBe(f.revision + 1);
  expect(await count("schedule_publication_assignment", c.operationId)).toBe(
    31,
  );
});
it("staff receives only own assignments and no full-team certificate, edits or reasons; inbox read is self-only and idempotent", async () => {
  const c = command();
  await publish(c);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const read = await readPublication(
    env,
    f.company.companyId,
    f.team,
    f.staffUser,
    c.operationId,
  );
  expect(read.publication.assignments).toEqual(assignments());
  expect(read.publication).not.toHaveProperty("validation");
  expect(read.publication).not.toHaveProperty("exceptions");
  expect(read.publication).not.toHaveProperty("actorId");
  await expect(
    publicationHistory(
      env.DB,
      f.company.companyId,
      f.team,
      f.staffUser,
      "2026-10",
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(
    (await publicationNotices(env.DB, f.company.companyId, f.team, f.staffUser))
      .notices,
  ).toHaveLength(1);
  expect(
    await readPublicationNotice(
      env.DB,
      f.company.companyId,
      f.team,
      f.staffUser,
      c.operationId,
    ),
  ).toMatchObject({ read: true, changed: true });
  expect(
    await readPublicationNotice(
      env.DB,
      f.company.companyId,
      f.team,
      f.staffUser,
      c.operationId,
    ),
  ).toMatchObject({ read: true, changed: false });
  await expect(
    readPublicationNotice(
      env.DB,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    readPublication(
      env,
      f.company.companyId,
      crypto.randomUUID(),
      f.staffUser,
      c.operationId,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("publication records stay immutable, company changes mark revalidation pending without modifying the historical certificate", async () => {
  const c = command();
  await publish(c);
  for (const sql of [
    "UPDATE schedule_publication_assignment SET worked_minutes=0 WHERE company_id=? AND publication_id=?",
    "DELETE FROM schedule_publication_version WHERE company_id=? AND id=?",
    "DELETE FROM schedule_publication_commit WHERE company_id=? AND publication_id=?",
  ])
    await expect(
      env.DB.prepare(sql).bind(f.company.companyId, c.operationId).run(),
    ).rejects.toThrow("IMMUTABLE_PUBLICATION");
  await expect(
    env.DB.prepare(
      "INSERT INTO schedule_publication_notice(company_id,publication_id,team_id,user_id) VALUES (?,?,?,?)",
    )
      .bind(f.company.companyId, c.operationId, f.team, f.company.userId)
      .run(),
  ).rejects.toThrow("IMMUTABLE_PUBLICATION");
  const { saveInputVersion } =
    await import("../../apps/api/src/input-versions");
  await saveInputVersion(
    env.DB,
    {
      company: f.company.companyId,
      team: null,
      staff: null,
      kind: "company_policy",
      entity: f.company.companyId,
    },
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: f.revision + 1,
      effectiveFrom: "2026-10",
      payload: probePolicy,
    },
    env.INPUTS,
  );
  expect(
    await readPublication(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.operationId,
    ),
  ).toMatchObject({
    revalidationRequired: true,
    publication: { inputRevision: f.revision, validation: validation() },
  });
});
it("HTTP: auth, initial-password gate, origin, self-only staff scope and strict publication shape", async () => {
  const app = createApp(),
    base = env.AUTH_BASE_URL,
    path =
      base +
      `/api/companies/${f.company.companyId}/schedules/teams/${f.team}/publications`;
  expect((await app.request(path + "?month=2026-10", {}, env)).status).toBe(
    401,
  );
  const login = await app.request(
      base + "/api/auth/sign-in/email",
      {
        method: "POST",
        headers: { origin: base, "content-type": "application/json" },
        body: JSON.stringify({
          email: f.email,
          password: f.company.initialPassword,
        }),
      },
      env,
    ),
    cookie = login.headers.get("set-cookie")!.split(";")[0];
  expect(
    (
      await app.request(
        path,
        {
          method: "POST",
          headers: {
            cookie,
            origin: "https://foreign.invalid",
            "content-type": "application/json",
          },
          body: JSON.stringify(command()),
        },
        env,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        path,
        {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({ ...command(), validation: validation() }),
        },
        env,
      )
    ).status,
  ).toBe(400);
  expect(
    (await app.request(path + "?month=2026-10", { headers: { cookie } }, env))
      .status,
  ).toBe(200);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=1 WHERE user_id=?",
  )
    .bind(f.company.userId)
    .run();
  expect(
    (await app.request(path + "?month=2026-10", { headers: { cookie } }, env))
      .status,
  ).toBe(403);
});

it("published reallocation result is accepted only when its mode matches the frozen input; a draft-mode spoof is rejected before check", async () => {
  await publish();
  const snapshot = await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: f.revision + 1,
      month: "2026-10",
    },
  );
  for (const mode of ["reallocation", "draft"]) {
    const job = (
      await createJob(
        env.DB,
        env.INPUTS,
        f.company.companyId,
        f.team,
        f.company.userId,
        {
          operationId: crypto.randomUUID(),
          expectedRevision: f.revision + 1,
          snapshotId: snapshot.snapshot!.id,
        },
      )
    ).job;
    let checks = 0;
    await executeJob(
      env,
      {
        version: 1,
        companyId: f.company.companyId,
        teamId: f.team,
        jobId: job.id,
      },
      async (path, payload) => {
        if (path === "/solve")
          return Response.json({
            ...payload,
            mode,
            solverStatus: "FEASIBLE",
            assignments: assignments(),
          });
        checks++;
        return Response.json(validation());
      },
      async () => {},
    );
    const stored = await env.DB.prepare(
      "SELECT state,failure_code FROM compute_job WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, job.id)
      .first();
    expect(stored).toEqual(
      mode === "reallocation"
        ? { state: "SUCCEEDED", failure_code: null }
        : { state: "FAILED", failure_code: "RESULT_IDENTITY_MISMATCH" },
    );
    expect(checks).toBe(mode === "reallocation" ? 1 : 0);
  }
});
it("with two real staff records, a staff read returns only that staff and live permission changes never expose the full-team certificate", async () => {
  const { createStaff } = await import("../../apps/api/src/product");
  const { saveInputVersion } =
    await import("../../apps/api/src/input-versions");
  const second = await createStaff(
    env.DB,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: f.revision,
      staffNumber: "0002",
      name: "架空別スタッフ",
      email: crypto.randomUUID() + "@example.invalid",
    },
  );
  const contract = await saveInputVersion(
    env.DB,
    {
      company: f.company.companyId,
      team: f.team,
      staff: second.staffId,
      kind: "staff_contract",
      entity: second.staffId,
    },
    f.company.userId,
    {
      operationId: crypto.randomUUID(),
      expectedRevision: second.revision,
      effectiveFrom: "2026-10",
      payload: f.profile,
    },
    env.INPUTS,
  );
  f.revision = contract.revision;
  const all = optimizerAssignmentsSchema.parse([
    ...assignments(),
    ...assignments().map((a) => ({
      ...a,
      staffId: second.staffId,
      shift: null,
      blocks: [],
      roleIntervals: [],
    })),
  ]);
  snapshotId = crypto.randomUUID();
  await createInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    { operationId: snapshotId, expectedRevision: f.revision, month: "2026-10" },
  );
  jobId = (
    await createJob(
      env.DB,
      env.INPUTS,
      f.company.companyId,
      f.team,
      f.company.userId,
      {
        operationId: crypto.randomUUID(),
        snapshotId,
        expectedRevision: f.revision,
      },
    )
  ).job.id;
  await executeJob(
    env,
    { version: 1, companyId: f.company.companyId, teamId: f.team, jobId },
    async (path, payload) =>
      Response.json(
        path === "/solve"
          ? { ...payload, solverStatus: "FEASIBLE", assignments: all }
          : validation(),
      ),
    async () => {},
  );
  const c = command();
  await publish(c);
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  const own = await readPublication(
    env,
    f.company.companyId,
    f.team,
    f.staffUser,
    c.operationId,
  );
  expect(own.publication.assignments).toEqual(assignments());
  expect(own.publication.assignments).toHaveLength(31);
  expect(
    (
      await readPublication(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.operationId,
      )
    ).publication.assignments,
  ).toHaveLength(62);
  // Controlled role revocation during R2 I/O; re-read live permissions after I/O.
  await env.DB.prepare(
    "UPDATE team_member SET role='team_admin' WHERE company_id=? AND team_id=? AND user_id=?",
  )
    .bind(f.company.companyId, f.team, f.staffUser)
    .run();
  const bucket = new Proxy(env.INPUTS, {
    get(target, key) {
      if (key === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const r = await target.get(...args);
          await env.DB.prepare(
            "UPDATE team_member SET role='staff' WHERE company_id=? AND team_id=? AND user_id=?",
          )
            .bind(f.company.companyId, f.team, f.staffUser)
            .run();
          return r;
        };
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const demoted = await readPublication(
    { DB: env.DB, INPUTS: bucket },
    f.company.companyId,
    f.team,
    f.staffUser,
    c.operationId,
  );
  expect(demoted.publication.assignments).toEqual(assignments());
  expect(demoted.publication).not.toHaveProperty("validation");
  const foreign = await inputFixture(env.DB, env.INPUTS);
  await expect(
    readPublication(
      env,
      f.company.companyId,
      f.team,
      foreign.company.userId,
      c.operationId,
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("Q102 CSV: managers export only published attendance/breaks and frozen identifiers, staff and foreign scopes are refused", async () => {
  const { publicationCsv } = await import("../../apps/api/src/publication-csv");
  await publish();
  const file = await publicationCsv(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
  expect(file.filename).toBe("schedule-2026-10-v1.csv");
  expect(file.csv.startsWith("\uFEFF")).toBe(true);
  expect(file.csv.split("\r\n")).toHaveLength(33);
  expect(file.csv).toContain(
    '"0001","架空入力スタッフ","2026-10-01","勤務","10:00","17:00","13:00","14:00",""',
  );
  expect(file.csv).not.toContain("phone");
  expect(file.csv).not.toContain("training");
  expect(file.csv).not.toContain("shortage");
  await env.DB.prepare(
    "UPDATE access_state SET must_change_password=0 WHERE user_id=?",
  )
    .bind(f.staffUser)
    .run();
  await expect(
    publicationCsv(env, f.company.companyId, f.team, f.staffUser, "2026-10"),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    publicationCsv(
      env,
      f.company.companyId,
      crypto.randomUUID(),
      f.company.userId,
      "2026-10",
    ),
  ).rejects.toThrow("FORBIDDEN");
});
it("CSV cancellation intervals remove attendance and rest portions, including full cancellation; output never suggests the original full shift", async () => {
  const { csvWork } = await import("../../apps/api/src/publication-csv"),
    s = assignments()[0].shift!;
  expect(csvWork({ ...s, cancelled: [[600, 840]] })).toEqual([
    "一部取消",
    "14:00",
    "17:00",
    "",
    "",
    "10:00〜14:00",
  ]);
  expect(csvWork({ ...s, cancelled: [[690, 750]] })).toEqual([
    "一部取消",
    "10:00 / 12:30",
    "11:30 / 17:00",
    "13:00",
    "14:00",
    "11:30〜12:30",
  ]);
  expect(csvWork({ ...s, cancelled: [[600, 1020]] })).toEqual([
    "全日取消",
    "",
    "",
    "",
    "",
    "10:00〜17:00",
  ]);
});
it("CSV escapes spreadsheet formulas in names and staff numbers rather than evaluating them", async () => {
  const { publicationCsv } = await import("../../apps/api/src/publication-csv");
  await env.DB.prepare(
    "UPDATE staff SET name='=1+1',staff_number='@SUM(1)' WHERE company_id=? AND id=?",
  )
    .bind(f.company.companyId, f.staff.staffId)
    .run();
  await publish();
  const exported = await publicationCsv(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    "2026-10",
  );
  expect(exported.csv).toContain('"\'@SUM(1)","\'=1+1"');
});

async function fixedPublication() {
  const a = assignments(),
    draftId = crypto.randomUUID(),
    locks = optimizerInputSchema.shape.locks.parse([
      {
        id: "published-full",
        staffId: f.staff.staffId,
        date: a[0].date,
        parts: ["pattern", "time", "break"],
        shift: a[0].shift,
      },
    ]);
  await saveDraft(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    {
      operationId: draftId,
      expectedRevision: f.revision,
      expectedDraftRevision: 0,
      sourceJobId: jobId,
      assignments: a,
      locks,
      exceptions: [],
    },
    verifier(),
  );
  const published = await publish({
    ...command(),
    expectedDraftRevision: 1,
    source: { kind: "draft", id: draftId },
  });
  const c = {
    operationId: crypto.randomUUID(),
    expectedRevision: published.revision,
    publicationId: published.publicationId,
    expectedPublicationRevision: published.publicationRevision,
    staffId: f.staff.staffId,
    date: a[0].date,
    parts: ["pattern", "time", "break"] as ("pattern" | "time" | "break")[],
  };
  return { published, c, locks, draftId };
}
it("published fixed release removes only selected explicit parts and preserves original work, certificate and source", async () => {
  const { c, locks } = await fixedPublication();
  const original = (
    await readPublication(
      env,
      f.company.companyId,
      f.team,
      f.company.userId,
      c.publicationId,
    )
  ).publication;
  expect(
    (
      await readPublishedFixed(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.publicationId,
      )
    ).locks,
  ).toEqual(locks);
  expect(
    await releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      parts: ["pattern"],
    }),
  ).toMatchObject({ revision: c.expectedRevision + 1, replayed: false });
  const state = await readPublishedFixed(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    c.publicationId,
  );
  expect(state.locks[0].parts).toEqual(["time", "break"]);
  expect(state.releases[0]).toMatchObject({
    actorId: f.company.userId,
    staffId: f.staff.staffId,
    parts: ["pattern"],
    appliedRevision: c.expectedRevision + 1,
  });
  expect(
    (
      await readPublication(
        env,
        f.company.companyId,
        f.team,
        f.company.userId,
        c.publicationId,
      )
    ).publication,
  ).toEqual(original);
  const source = await loadSources(
    env.DB,
    f.company.companyId,
    f.team,
    "2026-10",
  );
  const compiled = compileInput(
    f.company.companyId,
    f.team,
    "2026-10",
    crypto.randomUUID(),
    source,
  );
  expect(compiled.input.locks[0].parts).toEqual(["time", "break"]);
  expect(compiled.input.published).toEqual(
    assignments().map(({ staffId, date, shift }) => ({ staffId, date, shift })),
  );
  expect(compiled.lineage).toContainEqual({
    kind: "published_fixed_release",
    entity: c.operationId,
    version: c.operationId,
    revision: c.expectedRevision + 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT required_revision FROM publication_validation_head WHERE company_id=? AND publication_id=?",
    )
      .bind(f.company.companyId, c.publicationId)
      .first("required_revision"),
  ).toBe(c.expectedRevision + 1);
});
it("release replay is order independent and retains one revision/audit; conflicting payload and revoked access are refused", async () => {
  const { c } = await fixedPublication();
  const result = await releaseFixed(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    c,
  );
  expect(
    await releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      parts: ["break", "time", "pattern"],
    }),
  ).toEqual({ ...result, replayed: true });
  await expect(
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      parts: ["time"],
    }),
  ).rejects.toThrow("OPERATION_ID_CONFLICT");
  expect(await revision()).toBe(c.expectedRevision + 1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM product_audit WHERE company_id=? AND id=?",
    )
      .bind(f.company.companyId, c.operationId)
      .first("n"),
  ).toBe(1);
  await env.DB.prepare("UPDATE access_state SET enabled=0 WHERE user_id=?")
    .bind(f.company.userId)
    .run();
  await expect(
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, c),
  ).rejects.toThrow("FORBIDDEN");
});
it("two concurrent releases at one input revision have one winner and no partially released loser", async () => {
  const { c } = await fixedPublication();
  const results = await Promise.allSettled([
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, c),
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      operationId: crypto.randomUUID(),
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await revision()).toBe(c.expectedRevision + 1);
  expect(
    (await loadPublishedFixed(env.DB, f.company.companyId, c.publicationId))
      .locks,
  ).toEqual([]);
  expect(
    (await loadPublishedFixed(env.DB, f.company.companyId, c.publicationId))
      .releases,
  ).toHaveLength(1);
});
it.each(['fact','audit','commit','revision','validation-head'])('fixed release silent %s omission preserves explicit locks until the same operation is repaired',async fault=>{
  const {c,locks}=await fixedPublication(),target={fact:'BEFORE INSERT ON published_fixed_release',audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:fixed-released'",commit:'BEFORE INSERT ON published_fixed_release_commit',revision:'BEFORE UPDATE ON company','validation-head':'BEFORE UPDATE ON publication_validation_head'}[fault];
  const write=()=>releaseFixed(env,f.company.companyId,f.team,f.company.userId,c);
  await env.DB.prepare(`CREATE TRIGGER release_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{
    await expect(write()).rejects.toThrow();expect(await revision()).toBe(c.expectedRevision);expect((await loadPublishedFixed(env.DB,f.company.companyId,c.publicationId)).locks).toEqual(locks);
    for(const table of ['published_fixed_release','published_fixed_release_commit','product_audit'])expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE company_id=? AND id=?`).bind(f.company.companyId,c.operationId).first()).toBeNull();
  }finally{await env.DB.prepare('DROP TRIGGER release_silent_omission').run();}
  expect(await write()).toMatchObject({replayed:false});expect(await write()).toMatchObject({replayed:true});expect((await loadPublishedFixed(env.DB,f.company.companyId,c.publicationId)).locks).toEqual([]);
});
it.each(['audit','assignment','event','notice','commit','head-insert','head-update','revision','fixed-seal','validation-head'])('publication silent %s omission refuses every staged public fact and repairs the same ID',async fault=>{
  const c=command(),target={audit:"BEFORE INSERT ON product_audit WHEN NEW.kind='schedule:published'",assignment:'BEFORE INSERT ON schedule_publication_assignment',event:'BEFORE INSERT ON schedule_publication_event',notice:'BEFORE INSERT ON schedule_publication_notice',commit:'BEFORE INSERT ON schedule_publication_commit','head-insert':'BEFORE INSERT ON schedule_publication_head','head-update':'BEFORE UPDATE ON schedule_publication_head',revision:'BEFORE UPDATE ON company','fixed-seal':'BEFORE INSERT ON published_fixed_seal','validation-head':'BEFORE INSERT ON publication_validation_head'}[fault];
  await env.DB.prepare(`CREATE TRIGGER publication_silent_omission ${target} BEGIN SELECT RAISE(IGNORE); END`).run();
  try{await expect(publish(c)).rejects.toThrow();await absent(c.operationId);}
  finally{await env.DB.prepare('DROP TRIGGER publication_silent_omission').run();}
  expect(await publish(c)).toMatchObject({replayed:false,publicationRevision:1});expect(await publish(c)).toMatchObject({replayed:true,publicationRevision:1});
  expect(await revision()).toBe(c.expectedRevision+1);expect(await count('schedule_publication_commit',c.operationId)).toBe(1);
});
it("audit failure rolls back release, input revision and revalidation request together", async () => {
  const { c, locks } = await fixedPublication();
  await env.DB.exec(
    `CREATE TRIGGER fixed_release_audit_failure BEFORE INSERT ON product_audit WHEN NEW.id='${c.operationId}' BEGIN SELECT RAISE(ABORT,'FIXED_RELEASE_AUDIT_FAILURE');END;`,
  );
  try {
    await expect(
      releaseFixed(env, f.company.companyId, f.team, f.company.userId, c),
    ).rejects.toThrow("FIXED_RELEASE_AUDIT_FAILURE");
    expect(await revision()).toBe(c.expectedRevision);
    expect(
      (await loadPublishedFixed(env.DB, f.company.companyId, c.publicationId))
        .locks,
    ).toEqual(locks);
    for (const table of [
      "published_fixed_release",
      "published_fixed_release_commit",
    ])
      expect(
        await env.DB.prepare(
          `SELECT count(*) AS n FROM ${table} WHERE company_id=? AND id=?`,
        )
          .bind(f.company.companyId, c.operationId)
          .first("n"),
      ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM publication_revalidation_request WHERE company_id=? AND publication_id=?",
      )
        .bind(f.company.companyId, c.publicationId)
        .first("n"),
    ).toBe(0);
  } finally {
    await env.DB.exec("DROP TRIGGER fixed_release_audit_failure;");
  }
});
it("staff, another tenant/team, missing fixed parts and stale revision cannot release published fixed work", async () => {
  const { c } = await fixedPublication();
  await expect(
    releaseFixed(env, f.company.companyId, f.team, f.staffUser, c),
  ).rejects.toThrow("FORBIDDEN");
  const other = await inputFixture(env.DB, env.INPUTS);
  await expect(
    releaseFixed(
      env,
      other.company.companyId,
      other.team,
      other.company.userId,
      c,
    ),
  ).rejects.toThrow("FIXED_RELEASE_PUBLICATION_CONFLICT");
  await expect(
    releaseFixed(env, f.company.companyId, other.team, f.company.userId, c),
  ).rejects.toThrow("FORBIDDEN");
  await expect(
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      expectedRevision: c.expectedRevision - 1,
    }),
  ).rejects.toThrow("FIXED_RELEASE_VERSION_CONFLICT");
  await expect(
    releaseFixed(env, f.company.companyId, f.team, f.company.userId, {
      ...c,
      date: "2026-10-02",
    }),
  ).rejects.toThrow("FIXED_RELEASE_PART_NOT_FIXED");
  expect(await revision()).toBe(c.expectedRevision);
});
it("SQL rechecks live access when it is revoked between fixed read and final batch", async () => {
  const { c } = await fixedPublication();
  const observed=sqlObserver();
  let revoked = false;
  const db: InputDatabase = {
    prepare: observed.prepare,
    batch: async (statements) => {
      if (!revoked && statements.some(s=>/^INSERT INTO published_fixed_release\(/.test(observed.queries.get(s)??''))) {
        revoked = true;
        await env.DB.prepare(
          "UPDATE access_state SET enabled=0 WHERE user_id=?",
        )
          .bind(f.company.userId)
          .run();
      }
      return env.DB.batch(statements);
    },
  };
  await expect(
    releaseFixed(
      { DB: db, INPUTS: env.INPUTS },
      f.company.companyId,
      f.team,
      f.company.userId,
      c,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(await revision()).toBe(c.expectedRevision);
  expect(
    (await loadPublishedFixed(env.DB, f.company.companyId, c.publicationId))
      .releases,
  ).toHaveLength(0);
});
it("a pre-release saved draft cannot resurrect fixed parts when it compiles a current reallocation snapshot", async () => {
  const { c, draftId } = await fixedPublication();
  await releaseFixed(env, f.company.companyId, f.team, f.company.userId, c);
  const id = crypto.randomUUID();
  await createDraftSnapshot(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    draftId,
    {
      operationId: id,
      expectedRevision: c.expectedRevision + 1,
      expectedDraftRevision: 1,
    },
  );
  const frozen = await readInputSnapshot(
    env.DB,
    env.INPUTS,
    f.company.companyId,
    f.team,
    f.company.userId,
    id,
    true,
    true,
  );
  expect(frozen.input.mode).toBe("reallocation");
  expect(frozen.input.locks).toEqual([]);
  expect(frozen.input.published).toEqual(
    assignments().map(({ staffId, date, shift }) => ({ staffId, date, shift })),
  );
});
it("manual candidate checking cannot implicitly remove an active published lock and always confirms process stop", async () => {
  const { c, draftId } = await fixedPublication(),
    id = crypto.randomUUID();
  await createDraftSnapshot(
    env,
    f.company.companyId,
    f.team,
    f.company.userId,
    draftId,
    {
      operationId: id,
      expectedRevision: c.expectedRevision,
      expectedDraftRevision: 1,
    },
  );
  let calls = 0,
    stops = 0;
  await expect(
    checkDraftCandidate(
      env,
      {
        companyId: f.company.companyId,
        teamId: f.team,
        userId: f.company.userId,
        snapshotId: id,
        assignments: assignments(),
        locks: [],
        exceptions: [],
      },
      async () => {
        calls++;
        return Response.json(validation());
      },
      async () => {
        stops++;
      },
    ),
  ).rejects.toThrow("PUBLISHED_FIXED_RELEASE_REQUIRED");
  expect(calls).toBe(0);
  expect(stops).toBe(1);
  await expect(
    assertPublishedLocks(env.DB, f.company.companyId, f.team, "2026-10", []),
  ).rejects.toThrow("PUBLISHED_FIXED_RELEASE_REQUIRED");
  await releaseFixed(env, f.company.companyId, f.team, f.company.userId, c);
  await expect(
    assertPublishedLocks(env.DB, f.company.companyId, f.team, "2026-10", []),
  ).resolves.toBeUndefined();
});

// Real D1/R2 publication commits; constraint correctness remains covered by
// independent Python and native Container cases, not this controlled transport.
async function nextBrowsingPublication(expectedPublicationRevision:number){
  const inputRevision=(await revision())!,snapshot=crypto.randomUUID();
  await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:snapshot,expectedRevision:inputRevision,month:'2026-10'});
  const job=(await createJob(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),snapshotId:snapshot,expectedRevision:inputRevision})).job;
  await executeJob(env,{version:1,companyId:f.company.companyId,teamId:f.team,jobId:job.id},async(path,payload)=>Response.json(path==='/solve'?{...payload,solverStatus:'FEASIBLE',assignments:assignments()}:validation()),async()=>{});
  return publishSchedule(env,f.company.companyId,f.team,f.company.userId,{...command(),source:{kind:'job',id:job.id},expectedRevision:inputRevision,expectedPublicationRevision},verifier());
}
it('WP-07: 102 same-time publications page without loss/duplicates; a newer publication never shifts older pages or overwrites history',async()=>{
  const stamp=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(stamp),ids:string[]=[];
  try{
    ids.push((await publish()).publicationId);
    for(let i=1;i<102;i++)ids.push((await nextBrowsingPublication(i)).publicationId);
    await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
    const history=await publicationHistory(env.DB,f.company.companyId,f.team,f.company.userId,'2026-10');
    const notices=await publicationNotices(env.DB,f.company.companyId,f.team,f.staffUser);
    expect(history.versions).toHaveLength(50);expect(history.nextCursor).toEqual({revision:53});expect(notices.notices).toHaveLength(50);expect(notices.nextCursor).not.toBeNull();
    expect(history.versions[0]).toMatchObject({publicationRevision:102,actorId:f.company.userId,actorName:'架空管理者',sourceKind:'job'});
    expect(notices.notices.map(n=>n.publicationId)).toEqual([...ids].sort().reverse().slice(0,50));
    clock.mockReturnValue(stamp+1);const newest=await nextBrowsingPublication(102);
    const history2=await publicationHistory(env.DB,f.company.companyId,f.team,f.company.userId,'2026-10',history.nextCursor!);
    const history3=await publicationHistory(env.DB,f.company.companyId,f.team,f.company.userId,'2026-10',history2.nextCursor!);
    const notice2=await publicationNotices(env.DB,f.company.companyId,f.team,f.staffUser,notices.nextCursor!);
    const notice3=await publicationNotices(env.DB,f.company.companyId,f.team,f.staffUser,notice2.nextCursor!);
    expect(history3.nextCursor).toBeNull();expect(notice3.nextCursor).toBeNull();
    expect([...history.versions,...history2.versions,...history3.versions].map(v=>v.publicationId)).toEqual([...ids].reverse());
    expect([...notices.notices,...notice2.notices,...notice3.notices].map(n=>n.publicationId)).toEqual([...ids].sort().reverse());
    const old=await readPublication(env,f.company.companyId,f.team,f.staffUser,ids[0]);
    expect(old.superseded).toBe(true);expect(old.publication.assignments).toEqual(assignments());expect(old.publication).not.toHaveProperty('actorId');
    expect((await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10')).publication?.publicationId).toBe(newest.publicationId);
    expect((await publicationNotices(env.DB,f.company.companyId,f.team,f.staffUser)).notices[0].publicationId).toBe(newest.publicationId);
    await expect(publicationHistory(env.DB,f.company.companyId,f.team,f.staffUser,'2026-10',history.nextCursor!)).rejects.toThrow('FORBIDDEN');
    const foreign=await inputFixture(env.DB,env.INPUTS);
    await expect(publicationNotices(env.DB,foreign.company.companyId,foreign.team,f.staffUser,notices.nextCursor!)).rejects.toThrow('FORBIDDEN');
    expect((await publicationHistory(env.DB,f.company.companyId,f.team,f.company.userId,'2026-11')).versions).toHaveLength(0);
  }finally{clock.mockRestore();}
},120000);
it('notice read keeps the persisted timestamp on retry and permits the same company-admin scope as reads after membership removal',async()=>{
  await env.DB.prepare("INSERT INTO team_member(company_id,team_id,user_id,role,staff_id) VALUES (?,?,?,'team_admin',NULL)").bind(f.company.companyId,f.team,f.company.userId).run();
  const saved=await publish();await env.DB.prepare('DELETE FROM team_member WHERE company_id=? AND team_id=? AND user_id=?').bind(f.company.companyId,f.team,f.company.userId).run();
  const notice=(await publicationNotices(env.DB,f.company.companyId,f.team,f.company.userId)).notices[0],clock=vi.spyOn(Date,'now').mockReturnValue(0);
  try{
    const read=await readPublicationNotice(env.DB,f.company.companyId,f.team,f.company.userId,saved.publicationId);
    expect(read).toMatchObject({read:true,changed:true,readAt:notice.recordedAt});
    expect(await readPublicationNotice(env.DB,f.company.companyId,f.team,f.company.userId,saved.publicationId)).toMatchObject({read:true,changed:false,readAt:read.readAt});
  }finally{clock.mockRestore();}
});
it('native browsing API validates complete decimal cursors; history stays manager-only and query parameters cannot change inbox ownership',async()=>{
  const saved=await publish(),app=createApp(),path=`/api/companies/${f.company.companyId}/schedules/teams/${f.team}/publications`;
  const login=await app.request('/api/auth/sign-in/email',{method:'POST',headers:{origin:env.AUTH_BASE_URL,'content-type':'application/json'},body:JSON.stringify({email:f.email,password:f.company.initialPassword})},env),cookie=login.headers.get('set-cookie')!.split(';')[0];
  for(const query of ['cursorTime=','cursorId='+saved.publicationId,'cursorTime=1e3&cursorId='+saved.publicationId,'cursorTime=1&cursorId=bad','cursorTime=9007199254740992&cursorId='+saved.publicationId])expect((await app.request(path+'/notices?'+query,{headers:{cookie}},env)).status).toBe(400);
  for(const value of ['','0','-1','1.5','1e3','9007199254740992'])expect((await app.request(path+'/history?month=2026-10&cursorRevision='+value,{headers:{cookie}},env)).status).toBe(400);
  const own=await app.request(path+'/notices?userId='+f.staffUser,{headers:{cookie}},env);expect(own.headers.get('cache-control')).toBe('no-store');expect(await own.json()).toMatchObject({notices:[],nextCursor:null});
  expect((await app.request(path+'/history?month=2026-10&cursorRevision=2',{headers:{cookie}},env)).status).toBe(200);
  await env.DB.prepare('UPDATE access_state SET must_change_password=1 WHERE user_id=?').bind(f.company.userId).run();
  expect((await app.request(path+'/history?month=2026-10',{headers:{cookie}},env)).status).toBe(403);
});
it('browsing rechecks permission after SQL and a stopped user cannot mark a notice read during the write',async()=>{
  const saved=await publish();await env.DB.prepare('UPDATE access_state SET must_change_password=0 WHERE user_id=?').bind(f.staffUser).run();
  const dbAfter=(match:string,user:string,operation:'all'|'run'):InputDatabase=>({batch:env.DB.batch.bind(env.DB),prepare(sql){
    const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
      if(key==='bind')return(...args:unknown[])=>wrap(target.bind(...args));
      if(key===operation&&sql.includes(match))return async()=>{if(operation==='run')await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(user).run();const result=await (operation==='all'?target.all():target.run());if(operation==='all')await env.DB.prepare('UPDATE access_state SET enabled=0 WHERE user_id=?').bind(user).run();return result;};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});return wrap(env.DB.prepare(sql));
  }});
  await expect(publicationNotices(dbAfter('SELECT n.publication_id',f.staffUser,'all'),f.company.companyId,f.team,f.staffUser)).rejects.toThrow('FORBIDDEN');
  await env.DB.prepare('UPDATE access_state SET enabled=1 WHERE user_id=?').bind(f.staffUser).run();
  await expect(readPublicationNotice(dbAfter('UPDATE schedule_publication_notice',f.staffUser,'run'),f.company.companyId,f.team,f.staffUser,saved.publicationId)).rejects.toThrow('FORBIDDEN');
  expect(await env.DB.prepare('SELECT read_at FROM schedule_publication_notice WHERE company_id=? AND publication_id=? AND user_id=?').bind(f.company.companyId,saved.publicationId,f.staffUser).first('read_at')).toBeNull();
  await expect(publicationHistory(dbAfter('u.name AS actorName',f.company.userId,'all'),f.company.companyId,f.team,f.company.userId,'2026-10')).rejects.toThrow('FORBIDDEN');
});

it('inactive unpublished staff are omitted from publication; deleted published staff retain attendance through reallocation and republication',async()=>{
  const company=f.company.companyId,user=f.company.userId;
  const second=await createStaff(env.DB,company,f.team,user,{operationId:crypto.randomUUID(),expectedRevision:f.revision,name:'架空未配置スタッフ',staffNumber:'0002',email:`${crypto.randomUUID()}@example.invalid`});
  await changeStaffStatus(env.DB,company,f.team,second.staffId,user,{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,status:'inactive'});
  const prepare=async()=>{
    f.revision=(await revision())!;
    snapshotId=crypto.randomUUID();
    await createInputSnapshot(env.DB,env.INPUTS,company,f.team,user,{operationId:snapshotId,expectedRevision:f.revision,month:'2026-10'});
    jobId=(await createJob(env.DB,env.INPUTS,company,f.team,user,{operationId:crypto.randomUUID(),snapshotId,expectedRevision:f.revision})).job.id;
    await executeJob(env,{version:1,companyId:company,teamId:f.team,jobId},async(path,payload)=>Response.json(path==='/solve'?{...payload,solverStatus:'FEASIBLE',assignments:assignments()}:validation()),async()=>{});
  };
  await prepare();
  const first=command();await publish(first);
  const original=await readPublicationHead(env,company,f.team,user,'2026-10');
  for(const status of ['inactive','deleted'] as const){
    await changeStaffStatus(env.DB,company,f.team,f.staff.staffId,user,{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,status});
    const head=await readPublicationHead(env,company,f.team,user,'2026-10');
    expect(head.publication).toEqual(original.publication);
    const sources=await loadSources(env.DB,company,f.team,'2026-10');
    const input=compileInput(company,f.team,'2026-10',crypto.randomUUID(),sources).input;
    expect(input.mode).toBe('reallocation');expect(input.staff.map(s=>s.id)).toEqual([f.staff.staffId]);
    expect(input.published.map(a=>({staffId:a.staffId,date:a.date,shift:a.shift}))).toEqual(assignments().map(a=>({staffId:a.staffId,date:a.date,shift:a.shift})));
    expect(input.events).toEqual(f.plan.events);
  }
  await prepare();
  await publish({...command(),expectedPublicationRevision:1});
  expect(await env.DB.prepare('SELECT count(*) n FROM schedule_publication_assignment WHERE company_id=? AND publication_id=(SELECT publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?)').bind(company,company,f.team,'2026-10').first('n')).toBe(31);
});

it('readiness reads a legacy publication and draft fixed facts without materializing metadata, and rejects missing or corrupt evidence',async()=>{
  const old=await legacyFixedFixture();
  const read=()=>readInputReadiness(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  const before=await revision();const result=await read();expect(result.canCompute).toBe(true);expect(result.draftRevision).toBe(1);
  for(const table of ['source','lock','exception','seal'])expect(await env.DB.prepare(`SELECT count(*) n FROM published_fixed_${table} WHERE company_id=? AND publication_id=?`).bind(f.company.companyId,old.id).first('n')).toBe(0);
  expect(await revision()).toBe(before);
  const key=await env.DB.prepare('SELECT object_key FROM schedule_publication_version WHERE company_id=? AND id=?').bind(f.company.companyId,old.id).first<string>('object_key');
  const bytes=new Uint8Array(await(await env.INPUTS.get(key!))!.arrayBuffer());const changed=bytes.slice();changed[0]^=1;
  await env.INPUTS.put(key!,changed);await expect(read()).rejects.toThrow('PUBLICATION_DIGEST_MISMATCH');
  await env.INPUTS.delete(key!);await expect(read()).rejects.toThrow('PUBLICATION_OBJECT_MISSING');
  await env.INPUTS.put(key!,bytes);expect((await read()).canCompute).toBe(true);
});
it('readiness retains published staff after deletion',async()=>{
  await publish();
  await changeStaffStatus(env.DB,f.company.companyId,f.team,f.staff.staffId,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:(await revision())!,status:'deleted'});
  const data=await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  expect(data.canCompute).toBe(true);expect(data.items.find(i=>i.id==='staff')!.count).toBe(1);
});
it('readiness refuses an interleaved draft update without changing inputs or dispatching a calculation',async()=>{
  const source={sourceJobId:jobId,assignments:assignments(),locks:[],exceptions:[]};
  await saveDraft(env,f.company.companyId,f.team,f.company.userId,{...source,operationId:crypto.randomUUID(),expectedRevision:f.revision,expectedDraftRevision:0},verifier());
  let changed=false;
  const db:InputDatabase={prepare:env.DB.prepare.bind(env.DB),batch:async<T>(statements:D1PreparedStatement[])=>{
    const result=await env.DB.batch<T>(statements);if(!changed){changed=true;
      await saveDraft(env,f.company.companyId,f.team,f.company.userId,{...source,operationId:crypto.randomUUID(),expectedRevision:f.revision,expectedDraftRevision:1},verifier());
    }return result;
  }};
  await expect(readInputReadiness({...env,DB:db},f.company.companyId,f.team,f.company.userId,'2026-10')).rejects.toThrow('DRAFT_VERSION_CONFLICT');
  expect(await revision()).toBe(f.revision);
});

it('readiness rejects a saved fixed day when current contract times cannot contain its attendance',async()=>{
  const a=assignments();
  await saveDraft(env,f.company.companyId,f.team,f.company.userId,{operationId:crypto.randomUUID(),expectedRevision:f.revision,expectedDraftRevision:0,sourceJobId:jobId,assignments:a,locks:[{id:'fixed-day',staffId:f.staff.staffId,date:a[0].date,parts:['pattern','time','break'],shift:a[0].shift}],exceptions:[]},verifier());
  await f.save('staff_contract',{...f.profile,contract:{...f.profile.contract,start:720}});
  const data=await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  expect(data.canCompute).toBe(false);expect(data.items.find(i=>i.id==='consistency')).toMatchObject({status:'invalid',code:'EVENT_ATTENDANCE_CONFLICT'});
});

it.each([
  { id: "day", start: 600, end: 1020, breakKind: "auto" },
  { ...probeConfig.patterns[0], start: 570 },
  { ...probeConfig.patterns[0], end: 1050 },
  { ...probeConfig.patterns[0], fixedBreak: [750, 810] },
])('published pattern changes have a team-settings error, preserve history checks and recover after restoring settings: %j',async pattern=>{
  await publish();
  const before=await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  const saveConfig=async(payload:unknown)=>saveInputVersion(env.DB,{
    company:f.company.companyId,team:f.team,staff:null,kind:'team_config',entity:f.team,
  },f.company.userId,{
    operationId:crypto.randomUUID(),expectedRevision:(await revision())!,effectiveFrom:'2026-10',payload,
  });
  await saveConfig({...probeConfig,patterns:[pattern]});
  const data=await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,'2026-10');
  expect(data.canCompute).toBe(false);
  expect(data.items.find(i=>i.id==='consistency')).toMatchObject({status:'invalid',code:'PUBLISHED_PATTERN_CONFLICT',section:'team'});
  expect(data.items.find(i=>i.id==='consistency')!.message).toContain('公開時の設定に戻し');
  expect(data.items.find(i=>i.id==='history')!.status).toBe('missing');
  await expect(createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{
    operationId:crypto.randomUUID(),expectedRevision:(await revision())!,month:'2026-10',
  })).rejects.toThrow('PUBLISHED_PATTERN_CONFLICT');
  await saveConfig(probeConfig);
  expect((await readInputReadiness(env,f.company.companyId,f.team,f.company.userId,'2026-10')).canCompute).toBe(true);
  const snapshot=await createInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,{
    operationId:crypto.randomUUID(),expectedRevision:(await revision())!,month:'2026-10',
  });
  const frozen=await readInputSnapshot(env.DB,env.INPUTS,f.company.companyId,f.team,f.company.userId,snapshot.snapshot!.id,true);
  expect(frozen.input.mode).toBe('reallocation');
  expect(frozen.input.published).toEqual(assignments().map(({staffId,date,shift})=>({staffId,date,shift})));
  expect((await readPublicationHead(env,f.company.companyId,f.team,f.company.userId,'2026-10')).publication).toEqual(before.publication);
});
