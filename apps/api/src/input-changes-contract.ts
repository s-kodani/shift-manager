import { z } from 'zod';

const revision = z.number().int().nonnegative().safe();
export const inputChangesQuery = z.object({
  expectedRevision: revision,
  expectedDraftRevision: revision,
  offset: z.number().int().min(0).max(1_000_000).default(0),
}).strict();
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/).transform(Number);
export const inputChangesHttpQuery = z.object({
  expectedRevision: decimal, expectedDraftRevision: decimal, offset: decimal.optional(),
}).strict().pipe(inputChangesQuery);
const value = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
export const inputChange = z.object({
  path: z.array(z.string()).min(1),
  before: value.optional(), after: value.optional(),
  beforeTruncated: z.boolean(), afterTruncated: z.boolean(),
  entityName: z.string().max(120).optional(),
}).strict();
export type InputChange = z.infer<typeof inputChange>;
export function inputChangeCategory(change: Pick<InputChange, 'path'>): 'input' | 'publication' {
  const [root, kind] = change.path;
  return root === 'published' || root === 'mode' || root === 'sources' && kind === 'published_schedule'
    ? 'publication' : 'input';
}
export function inputChangeTotals(changes: InputChange[]) {
  const totals = { input: 0, publication: 0 };
  for (const change of changes) totals[inputChangeCategory(change)]++;
  return totals;
}
export const inputChangesResponse = z.object({
  snapshotId: z.string().uuid(), month: z.string(),
  inputRevision: revision, currentRevision: revision,
  sourceDraftRevision: revision, currentDraftRevision: revision,
  currentInputStatus: z.enum(['COMPILED','UNAVAILABLE']), currentInputError: z.string().nullable(),
  changes: z.array(inputChange).max(50), total: revision,
  totals: z.object({ input: revision, publication: revision }).strict(),
  offset: revision, nextOffset: revision.nullable(),
}).strict();

type Json = null | string | number | boolean | Json[] | { [key: string]: Json };
const record = (v: Json | undefined): v is { [key: string]: Json } =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function itemKey(field: string, item: Json, index: number): string {
  if (!record(item)) return String(index);
  if (field === 'rules' && typeof item.id === 'string') return item.id.split(':')[0];
  if (typeof item.id === 'string') return item.id;
  if (field === 'preferences') return String(item.date) + ':' + String(item.kind);
  if (field === 'transitions') return String(item.fromTaskId) + ':' + String(item.toTaskId);
  if (field === 'skills') return String(item.taskId);
  if (field === 'history' || field === 'published') return String(item.staffId) + ':' + String(item.date);
  if (typeof item.date === 'string') return [item.date, item.taskId ?? '', item.start ?? ''].join(':');
  return String(index);
}
const setArrays = new Set(['weekdays', 'roleIds', 'staffIds', 'allowedTasks', 'parts']);
function arrayEntries(values: Json[], field: string): Map<string, Json> {
  const ordered = setArrays.has(field) ? [...values].sort((a, b) => String(a).localeCompare(String(b))) : values;
  const entries = ordered.map((v, i) => [itemKey(field, v, i), v] as const);
  // Inputs are validated; fallback indices still avoid silently losing a row if
  // an array's domain key is not unique (e.g. several intervals with one start).
  return new Set(entries.map(([key]) => key)).size === entries.length
    ? new Map(entries) : new Map(ordered.map((v, i) => [String(i), v]));
}

// Compare exact JSON values, not their display formatting. Absence, null and 0
// stay distinct; record arrays match by domain identity rather than UUID order.
export function compareInputValues(before: unknown, after: unknown): InputChange[] {
  const result: InputChange[] = [];
  const bounded = (v: Json | undefined) => typeof v === 'string' ? v.slice(0, 1000) : v;
  function walk(a: Json | undefined, b: Json | undefined, path: string[]) {
    if (a === b) return;
    if (Array.isArray(a) || Array.isArray(b)) {
      const left = arrayEntries(Array.isArray(a) ? a : [], path.at(-1) ?? '');
      const right = arrayEntries(Array.isArray(b) ? b : [], path.at(-1) ?? '');
      for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) walk(left.get(key), right.get(key), [...path, key]);
    } else if (record(a) || record(b)) {
      const left = record(a) ? a : {}, right = record(b) ? b : {};
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        // A rule's source operation ID changes even when its values do not.
        // Source versions are reported separately below the `sources` path.
        if (key === 'id' && path.includes('rules')) continue;
        walk(Object.hasOwn(left,key)?left[key]:undefined, Object.hasOwn(right,key)?right[key]:undefined, [...path, key]);
      }
    } else {
      result.push({ path, before: bounded(a) as InputChange['before'], after: bounded(b) as InputChange['after'],
        beforeTruncated: typeof a === 'string' && a.length > 1000,
        afterTruncated: typeof b === 'string' && b.length > 1000 });
    }
  }
  // Both callers supply parsed JSON documents; serialization excludes undefined
  // properties and ensures no prototypes, cycles or non-JSON values enter walk.
  walk(JSON.parse(JSON.stringify(before)), JSON.parse(JSON.stringify(after)), []);
  return result;
}
