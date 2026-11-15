import { z } from "zod";
import type { OptimizerInput } from "../../../packages/contracts/optimizer-input.generated";
import { optimizerInputSchema } from "../../../packages/contracts/optimizer-input.generated";
import type { PublicationDocument } from "./publication-contract";
import type { InputDatabase } from "./input-versions";
import { requireManager, ProductError } from "./product";
import { sha256 } from "./input-snapshots";
import {
  publishedFixedState,
  releasePublishedFixed,
} from "./published-fixed-contract";

export function fixedSourceStatements(
  db: InputDatabase,
  document: PublicationDocument,
  digest: string,
) {
  const company = document.tenantId,
    id = document.publicationId;
  const statements = [
    db
      .prepare(
        "INSERT INTO published_fixed_source(company_id,publication_id,document_sha256,lock_count,exception_count) VALUES (?,?,?,?,?)",
      )
      .bind(
        company,
        id,
        digest,
        document.locks.length,
        document.exceptions.length,
      ),
  ];
  for (let i = 0; i < document.locks.length; i += 100)
    statements.push(
      db
        .prepare(
          `INSERT INTO published_fixed_lock(company_id,publication_id,id,staff_id,date,parts,shift)
    SELECT ?,?,json_extract(value,'$.id'),json_extract(value,'$.staffId'),json_extract(value,'$.date'),json_extract(value,'$.parts'),COALESCE(json_extract(value,'$.shift'),'null') FROM json_each(?)`,
        )
        .bind(company, id, JSON.stringify(document.locks.slice(i, i + 100))),
    );
  for (let i = 0; i < document.exceptions.length; i += 100)
    statements.push(
      db
        .prepare(
          `INSERT INTO published_fixed_exception(company_id,publication_id,id,payload)
    SELECT ?,?,json_extract(value,'$.id'),value FROM json_each(?)`,
        )
        .bind(
          company,
          id,
          JSON.stringify(document.exceptions.slice(i, i + 100)),
        ),
    );
  statements.push(
    db
      .prepare(
        "INSERT INTO published_fixed_seal(company_id,publication_id) VALUES (?,?)",
      )
      .bind(company, id),
    db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM published_fixed_source f
      JOIN published_fixed_seal s ON s.company_id=f.company_id AND s.publication_id=f.publication_id
      WHERE f.company_id=? AND f.publication_id=? AND f.document_sha256=? AND f.lock_count=? AND f.exception_count=?
        AND f.lock_count=(SELECT count(*) FROM published_fixed_lock WHERE company_id=f.company_id AND publication_id=f.publication_id)
        AND f.exception_count=(SELECT count(*) FROM published_fixed_exception WHERE company_id=f.company_id AND publication_id=f.publication_id)
    ) THEN 1 ELSE abs(-9223372036854775808) END AS fixed_source_saved`)
      .bind(company,id,digest,document.locks.length,document.exceptions.length),
  );
  return statements;
}

// Legacy publications are hydrated only from a complete, identity/digest-checked
// R2 document. New publications materialize this metadata in their final batch.
export async function ensureFixedSource(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  id: string,
) {
  if (
    await env.DB.prepare(
      "SELECT 1 FROM published_fixed_seal WHERE company_id=? AND publication_id=?",
    )
      .bind(company, id)
      .first()
  )
    return;
  const { publicationEvidence } = await import("./schedule-publications");
  const evidence = await publicationEvidence(env, company, team, id);
  try {
    await env.DB.batch(
      fixedSourceStatements(env.DB, evidence.document, evidence.row.sha256),
    );
  } catch (error) {
    // Only a completed identical concurrent hydration can satisfy this retry.
    const completed = await env.DB.prepare(
      `SELECT document_sha256 FROM published_fixed_source s JOIN published_fixed_seal c USING(company_id,publication_id) WHERE company_id=? AND publication_id=?`,
    )
      .bind(company, id)
      .first<string>("document_sha256");
    if (completed !== evidence.row.sha256) throw error;
  }
}
export async function ensureCurrentFixedSource(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  month: string,
) {
  const id = await env.DB.prepare(
    "SELECT publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
  )
    .bind(company, team, month)
    .first<string>("publication_id");
  if (id) await ensureFixedSource(env, company, team, id);
}

export type PublishedFixed = {
  publicationId: string;
  inputRevision: number;
  originalLocks: OptimizerInput["locks"];
  locks: OptimizerInput["locks"];
  exceptions: OptimizerInput["exceptions"];
  releases: z.infer<typeof publishedFixedState>["releases"];
};
export async function loadPublishedFixed(
  db: InputDatabase,
  company: string,
  id: string,
  legacy?: { bucket: R2Bucket; team: string },
): Promise<PublishedFixed> {
  const rows = await db.batch([
    db
      .prepare(
        "SELECT 1 FROM published_fixed_seal WHERE company_id=? AND publication_id=?",
      )
      .bind(company, id),
    db
      .prepare(
        "SELECT id,staff_id AS staffId,date,parts,shift FROM published_fixed_lock WHERE company_id=? AND publication_id=? ORDER BY id",
      )
      .bind(company, id),
    db
      .prepare(
        "SELECT payload FROM published_fixed_exception WHERE company_id=? AND publication_id=? ORDER BY id",
      )
      .bind(company, id),
    db
      .prepare(
        `SELECT r.id,r.actor_id AS actorId,r.staff_id AS staffId,r.date,r.parts,r.expected_revision+1 AS appliedRevision,r.recorded_at AS recordedAt FROM published_fixed_release r JOIN published_fixed_release_commit c ON c.company_id=r.company_id AND c.id=r.id WHERE r.company_id=? AND r.publication_id=? ORDER BY r.expected_revision,r.id`,
      )
      .bind(company, id),
    db.prepare("SELECT revision FROM company WHERE id=?").bind(company),
  ]);
  let document: PublicationDocument | undefined;
  if (!rows[0].results.length) {
    if (!legacy) throw new ProductError("PUBLISHED_FIXED_SOURCE_REQUIRED");
    const { publicationEvidence } = await import("./schedule-publications");
    document = (await publicationEvidence({ DB: db, INPUTS: legacy.bucket }, company, legacy.team, id)).document;
  }
  const originalLocks = document?.locks ?? optimizerInputSchema.shape.locks.parse(
    rows[1].results.map((value) => {
      const r = z
        .object({
          id: z.string(),
          staffId: z.string(),
          date: z.string(),
          parts: z.string(),
          shift: z.string(),
        })
        .parse(value);
      return { ...r, parts: JSON.parse(r.parts), shift: JSON.parse(r.shift) };
    }),
  );
  const exceptions = document?.exceptions ?? optimizerInputSchema.shape.exceptions.parse(
    rows[2].results.map((value) =>
      JSON.parse(z.object({ payload: z.string() }).parse(value).payload),
    ),
  );
  const releases = publishedFixedState.shape.releases.parse(
    rows[3].results.map((value) => {
      const r = z
        .object({
          id: z.string(),
          actorId: z.string(),
          staffId: z.string(),
          date: z.string(),
          parts: z.string(),
          appliedRevision: z.number(),
          recordedAt: z.number(),
        })
        .parse(value);
      return { ...r, parts: JSON.parse(r.parts) };
    }),
  );
  const locks = originalLocks.flatMap((l) => {
    const parts = l.parts.filter(
      (p) =>
        !releases.some(
          (r) =>
            r.staffId === l.staffId && r.date === l.date && r.parts.includes(p),
        ),
    );
    return parts.length ? [{ ...l, parts }] : [];
  });
  const inputRevision = z
    .object({ revision: z.number().int().nonnegative() })
    .parse(rows[4].results[0]).revision;
  return {
    publicationId: id,
    inputRevision,
    originalLocks,
    locks,
    exceptions,
    releases,
  };
}

// Published locks remain authoritative until explicitly released. An old saved
// draft/certificate cannot reintroduce released parts. A newer explicit edit may
// fix them again in a future publication; it cannot change the current evidence.
export function currentPublishedFixed(
  source: PublishedFixed,
  overrides?: Pick<OptimizerInput, "locks" | "exceptions">,
  fixedRevision = 0,
) {
  const locks = new Map(source.locks.map((l) => [l.id, l]));
  for (const l of overrides?.locks ?? []) {
    const parts = l.parts.filter(
      (p) =>
        !source.releases.some(
          (r) =>
            r.appliedRevision > fixedRevision &&
            r.staffId === l.staffId &&
            r.date === l.date &&
            r.parts.includes(p),
        ),
    );
    if (!parts.length) continue;
    const old = locks.get(l.id);
    locks.set(
      l.id,
      old
        ? { ...old, parts: [...new Set([...old.parts, ...parts])] }
        : { ...l, parts },
    );
  }
  const active = [...locks.values()];
  const exceptions = (overrides?.exceptions ?? source.exceptions).filter(
    (e) =>
      e.lockId === null ||
      active.some(
        (l) =>
          l.id === e.lockId &&
          ["pattern", "time", "break"].every((p) =>
            l.parts.includes(p as "pattern" | "time" | "break"),
          ),
      ),
  );
  return { locks: active, exceptions };
}

export async function assertPublishedLocks(
  db: InputDatabase,
  company: string,
  team: string,
  month: string,
  locks: OptimizerInput["locks"],
) {
  const id = await db
    .prepare(
      "SELECT publication_id FROM schedule_publication_head WHERE company_id=? AND team_id=? AND month=?",
    )
    .bind(company, team, month)
    .first<string>("publication_id");
  if (!id) return;
  const source = await loadPublishedFixed(db, company, id);
  for (const original of source.locks)
    for (const part of original.parts) {
      const fields = {
        pattern: ["patternId"],
        time: ["start", "end"],
        break: ["breakKind", "break"],
      } as const;
      if (
        !locks.some(
          (l) =>
            l.staffId === original.staffId &&
            l.date === original.date &&
            l.parts.includes(part) &&
            (original.shift === null
              ? l.shift === null
              : l.shift !== null &&
                fields[part].every(
                  (field) =>
                    JSON.stringify(l.shift![field]) ===
                    JSON.stringify(original.shift![field]),
                )),
        )
      )
        throw new ProductError("PUBLISHED_FIXED_RELEASE_REQUIRED");
    }
}

export async function readPublishedFixed(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  user: string,
  id: string,
) {
  await requireManager(env.DB, company, team, user);
  const head = await env.DB.prepare(
    "SELECT month,revision FROM schedule_publication_head WHERE company_id=? AND team_id=? AND publication_id=?",
  )
    .bind(company, team, id)
    .first<{ month: string; revision: number }>();
  if (!head) throw new ProductError("FIXED_RELEASE_PUBLICATION_CONFLICT");
  await ensureFixedSource(env, company, team, id);
  const state = await loadPublishedFixed(env.DB, company, id);
  await requireManager(env.DB, company, team, user);
  if (
    !(await env.DB.prepare(
      "SELECT 1 FROM schedule_publication_head WHERE company_id=? AND team_id=? AND publication_id=? AND revision=?",
    )
      .bind(company, team, id, head.revision)
      .first())
  )
    throw new ProductError("FIXED_RELEASE_PUBLICATION_CONFLICT");
  return publishedFixedState.parse({
    publicationId: id,
    publicationRevision: head.revision,
    inputRevision: state.inputRevision,
    locks: state.locks,
    releases: state.releases,
  });
}

export async function releaseFixed(
  env: { DB: InputDatabase; INPUTS: R2Bucket },
  company: string,
  team: string,
  user: string,
  data: z.infer<typeof releasePublishedFixed>,
) {
  const c = releasePublishedFixed.parse(data);
  c.parts.sort();
  await requireManager(env.DB, company, team, user);
  const fingerprint = await sha256(
    new TextEncoder().encode(
      JSON.stringify({ company, team, user, command: c }),
    ),
  );
  const replay = async () => {
    const old = await env.DB.prepare(
      `SELECT r.fingerprint,r.team_id,r.expected_revision FROM published_fixed_release r JOIN published_fixed_release_commit c ON c.company_id=r.company_id AND c.id=r.id WHERE r.company_id=? AND r.id=?`,
    )
      .bind(company, c.operationId)
      .first<{
        fingerprint: string;
        team_id: string;
        expected_revision: number;
      }>();
    if (old && (old.fingerprint !== fingerprint || old.team_id !== team))
      throw new ProductError("OPERATION_ID_CONFLICT");
    if (!old) return null;
    await requireManager(env.DB, company, team, user);
    return {
      releaseId: c.operationId,
      revision: old.expected_revision + 1,
      replayed: true,
    };
  };
  const old = await replay();
  if (old) return old;
  const state = await readPublishedFixed(
    env,
    company,
    team,
    user,
    c.publicationId,
  );
  if (state.inputRevision !== c.expectedRevision)
    throw new ProductError("FIXED_RELEASE_VERSION_CONFLICT");
  if (state.publicationRevision !== c.expectedPublicationRevision)
    throw new ProductError("FIXED_RELEASE_PUBLICATION_CONFLICT");
  if (
    c.parts.some(
      (p) =>
        !state.locks.some(
          (l) =>
            l.staffId === c.staffId && l.date === c.date && l.parts.includes(p),
        ),
    )
  )
    throw new ProductError("FIXED_RELEASE_PART_NOT_FIXED", 400);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO published_fixed_release(company_id,id,publication_id,team_id,staff_id,date,actor_id,expected_revision,publication_revision,parts,fingerprint,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        company,
        c.operationId,
        c.publicationId,
        team,
        c.staffId,
        c.date,
        user,
        c.expectedRevision,
        c.expectedPublicationRevision,
        JSON.stringify(c.parts),
        fingerprint,
        Date.now(),
      ),
      env.DB.prepare(
        "INSERT INTO product_audit(company_id,id,actor_id,kind,revision,recorded_at) VALUES (?,?,?,'schedule:fixed-released',?,?)",
      ).bind(company, c.operationId, user, c.expectedRevision + 1, Date.now()),
      env.DB.prepare(
        "INSERT INTO published_fixed_release_commit(company_id,id) VALUES (?,?)",
      ).bind(company, c.operationId),
      env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM published_fixed_release r
        JOIN published_fixed_release_commit m ON m.company_id=r.company_id AND m.id=r.id
        JOIN company c ON c.id=r.company_id JOIN product_audit a ON a.company_id=r.company_id AND a.id=r.id
        JOIN publication_validation_head v ON v.company_id=r.company_id AND v.team_id=r.team_id AND v.month=substr(r.date,1,7)
        WHERE r.company_id=? AND r.id=? AND r.publication_id=? AND r.team_id=? AND r.actor_id=? AND r.fingerprint=?
          AND r.staff_id=? AND r.date=? AND r.parts=? AND r.expected_revision=?
          AND c.revision=r.expected_revision+1 AND a.kind='schedule:fixed-released' AND a.actor_id=r.actor_id AND a.revision=c.revision
          AND v.publication_id=r.publication_id AND v.required_revision=c.revision AND v.validation_id IS NULL
      ) THEN 1 ELSE abs(-9223372036854775808) END AS release_saved`)
        .bind(company,c.operationId,c.publicationId,team,user,fingerprint,c.staffId,c.date,JSON.stringify(c.parts),c.expectedRevision),
    ]);
  } catch (error) {
    const retry = await replay();
    if (retry) return retry;
    await requireManager(env.DB, company, team, user);
    for (const code of [
      "FIXED_RELEASE_FORBIDDEN",
      "FIXED_RELEASE_VERSION_CONFLICT",
      "FIXED_RELEASE_PUBLICATION_CONFLICT",
      "FIXED_RELEASE_PART_NOT_FIXED",
      "FIXED_RELEASE_COMMIT_CONFLICT",
    ])
      if (String(error).includes(code))
        throw new ProductError(
          code,
          code.endsWith("FORBIDDEN")
            ? 403
            : code.endsWith("PART_NOT_FIXED")
              ? 400
              : 409,
        );
    if (String(error).includes("UNIQUE constraint"))
      throw new ProductError("OPERATION_ID_CONFLICT");
    throw error;
  }
  return {
    releaseId: c.operationId,
    revision: c.expectedRevision + 1,
    replayed: false,
  };
}
