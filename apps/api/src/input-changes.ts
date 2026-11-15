import { z } from 'zod';
import { compileInput, loadSources, readInputSnapshot } from './input-snapshots';
import { readDraftHead } from './schedule-drafts';
import { fixedDraftInput } from './draft-recalculation';
import { ProductError, requireManager } from './product';
import type { InputDatabase } from './input-versions';
import { compareInputValues, inputChangeTotals, inputChangesQuery, inputChangesResponse, type InputChange } from './input-changes-contract';
import type { OptimizerInput } from '../../../packages/contracts/optimizer-input.generated';

const lineageSchema = z.array(z.object({kind:z.string(),entity:z.string(),version:z.string(),revision:z.number().int()}));
function conditions(input: OptimizerInput) {
  const { schemaVersion: _schema, tenantId: _tenant, teamId: _team, month: _month,
    inputVersion: _version, settingsVersion: _settings, jobId: _job, attempt: _attempt, ...values } = input;
  return values;
}
export async function readInputChanges(
  env: { DB: InputDatabase; INPUTS: R2Bucket }, company: string, team: string, user: string,
  snapshotId: string, query: z.infer<typeof inputChangesQuery>,
) {
  const q = inputChangesQuery.parse(query), db = env.DB;
  await requireManager(db, company, team, user);
  const saved = await readInputSnapshot(db, env.INPUTS, company, team, user, snapshotId);
  const sources = await loadSources(db, company, team, saved.snapshot.month);
  if (sources.revision !== q.expectedRevision) throw new ProductError('VERSION_CONFLICT');
  const head = await readDraftHead(env, company, team, user, saved.snapshot.month);
  if (head.draftRevision !== q.expectedDraftRevision) throw new ProductError('DRAFT_VERSION_CONFLICT');
  const overrides = head.draft ? fixedDraftInput(head.draft) : undefined;
  // Structural compilation only; displaying a difference never invokes solve,
  // check, registration, adoption or publication, and never declares validity.
  const oldLineage = lineageSchema.parse(JSON.parse(saved.snapshot.lineage));
  const currentVersions=new Map(sources.versions.map(v=>[v.kind+':'+v.entity_id,v]));
  const selected=new Map<string,(typeof sources.versions)[number]>();
  const select=(kind:string,entity:string)=>{const row=currentVersions.get(kind+':'+entity);if(row)selected.set(kind+':'+entity,row);};
  select('company_policy',company);select('team_config',team);select('planning',team);
  for(const person of sources.staff){
    select('staff_contract',person.id);select('staff_month',person.id);
    const profile=currentVersions.get('staff_contract:'+person.id);
    if(profile){const p=z.object({employmentTypeId:z.string().uuid()}).parse(JSON.parse(profile.payload));select('employment_policy',p.employmentTypeId);}
  }
  // Registered values remain useful even when their combined contract cannot
  // compile. Read the immutable versions actually referenced by this snapshot,
  // not whichever historical row happens to be newest today.
  const oldRows=await db.prepare(`SELECT v.kind,v.entity_id,v.payload FROM input_snapshot s JOIN json_each(s.lineage) j
    JOIN work_input_version v ON v.company_id=s.company_id AND v.operation_id=json_extract(j.value,'$.version')
      AND v.kind=json_extract(j.value,'$.kind') AND v.entity_id=json_extract(j.value,'$.entity')
    WHERE s.company_id=? AND s.team_id=? AND s.id=? AND (v.team_id IS NULL OR v.team_id=s.team_id)`)
    .bind(company,team,snapshotId).all<{kind:string;entity_id:string;payload:string}>();
  const oldCalendar=await db.prepare(`SELECT v.payload FROM input_snapshot s JOIN json_each(s.lineage) j
    JOIN calendar_settings_version v ON v.company_id=s.company_id AND v.operation_id=json_extract(j.value,'$.version')
    WHERE s.company_id=? AND s.team_id=? AND s.id=? AND json_extract(j.value,'$.kind')='calendar'`)
    .bind(company,team,snapshotId).first<string>('payload');
  const kinds=new Set(['company_policy','team_config','planning','staff_contract','staff_month','employment_policy']);
  if(oldRows.results.length!==oldLineage.filter(v=>kinds.has(v.kind)).length||!oldCalendar)throw Error('SNAPSHOT_LINEAGE_MISSING');
  const documents=(rows:{kind:string;entity_id:string;payload:string}[],calendar:string)=>{
    const resources:Record<string,Record<string,unknown>>={calendar:{[company]:JSON.parse(calendar)}};
    for(const row of rows)(resources[row.kind]??={})[row.entity_id]=JSON.parse(row.payload);
    return {resources};
  };
  const previousResources=documents(oldRows.results,oldCalendar),currentResources=documents([...selected.values()],sources.calendar.payload);
  let current:ReturnType<typeof compileInput>|null=null,currentInputError:string|null=null;
  try {current=compileInput(company, team, saved.snapshot.month, snapshotId, sources, overrides,
    { registrationValidation: false, fixedRevision: head.draft?.inputRevision ?? 0 });}
  catch(error){if(!(error instanceof ProductError)||error.status!==400)throw error;currentInputError=error.code;}
  const currentLineage=current?.lineage??[
    {kind:'calendar',entity:company,version:sources.calendar.operation_id,revision:sources.calendar.revision},
    ...[...selected.values()].map(v=>({kind:v.kind,entity:v.entity_id,version:v.operation_id,revision:v.revision})),
  ];
  if(head.draft)currentLineage.push({kind:'manual_draft',entity:team,version:head.draft.draftId,revision:head.draftRevision});
  const old = new Map(oldLineage.map(v => [v.kind + ':' + v.entity, v]));
  const now = new Map(currentLineage.map(v => [v.kind + ':' + v.entity, v]));
  const changes: InputChange[] = [];
  for (const key of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const a = old.get(key), b = now.get(key), source = b ?? a!;
    // This is the same policy source; its effective break values are compared
    // in conditions, so do not repeat the policy's version row twice.
    if (source.kind === 'company_break_rule') continue;
    if (a?.version !== b?.version || a?.revision !== b?.revision) changes.push({
      path: ['sources', source.kind, source.entity], before: a?.revision, after: b?.revision,
      beforeTruncated: false, afterTruncated: false,
    });
  }
  if(current)changes.push(...compareInputValues(conditions(saved.input), conditions(current.input)));
  // Without a compiled current input, report only known registered sources;
  // absence of derived history/publication lineage is not a proven removal.
  if(!current)for(let i=changes.length-1;i>=0;i--)if(!kinds.has(changes[i].path[1])&&!['calendar','manual_draft'].includes(changes[i].path[1]))changes.splice(i,1);
  const rawChanges=compareInputValues(previousResources,currentResources);
  for(const change of rawChanges){
    const payload=currentResources.resources[change.path[1]]?.[change.path[2]]??previousResources.resources[change.path[1]]?.[change.path[2]];
    if(change.path[1]==='employment_policy'&&payload&&typeof payload==='object'&&'name' in payload&&typeof payload.name==='string')change.entityName=payload.name;
  }
  changes.push(...rawChanges);
  // Manual heads have their own version, independent of the company input.
  // Verify again after every R2/DB await before disclosing the response.
  const latest = await db.prepare(`SELECT c.revision,coalesce(h.revision,0) AS draft_revision,h.draft_id,
    EXISTS(SELECT 1 FROM access_state a WHERE a.user_id=? AND a.enabled=1 AND a.must_change_password=0)
    AND (EXISTS(SELECT 1 FROM company_admin a WHERE a.company_id=c.id AND a.user_id=?)
      OR EXISTS(SELECT 1 FROM team_member m WHERE m.company_id=c.id AND m.team_id=t.id AND m.user_id=? AND m.role='team_admin')) AS authorized
    FROM company c JOIN team t ON t.company_id=c.id AND t.id=?
    LEFT JOIN schedule_draft_head h ON h.company_id=c.id AND h.team_id=t.id AND h.month=? WHERE c.id=?`)
    .bind(user,user,user,team,saved.snapshot.month,company)
    .first<{revision:number;draft_revision:number;draft_id:string|null;authorized:number}>();
  if (!latest?.authorized) throw new ProductError('FORBIDDEN',403);
  if (latest.revision !== sources.revision) throw new ProductError('VERSION_CONFLICT');
  if (latest.draft_revision !== head.draftRevision || latest.draft_id !== (head.draft?.draftId ?? null)) throw new ProductError('DRAFT_VERSION_CONFLICT');
  if (q.offset > changes.length) throw new ProductError('INVALID_INPUT', 400);
  return inputChangesResponse.parse({
    snapshotId, month: saved.snapshot.month, inputRevision: saved.input.inputVersion,
    currentRevision: sources.revision, sourceDraftRevision: saved.draftSource?.draftRevision ?? 0,
    currentDraftRevision: head.draftRevision, changes: changes.slice(q.offset, q.offset + 50), total: changes.length, totals: inputChangeTotals(changes),
    currentInputStatus:current?'COMPILED':'UNAVAILABLE',currentInputError,
    offset: q.offset, nextOffset: q.offset + 50 < changes.length ? q.offset + 50 : null,
  });
}
