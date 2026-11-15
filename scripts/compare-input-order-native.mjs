import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { prepareStaffOrderComparison } from './input-order-comparison.mjs';
import { assertNativeSources, assertResourceLimits, cgroupObservationCode } from './native-resource-profile.mjs';
import { compareCheckedObjectives } from './quality-comparison.mjs';

const budgetComparison = process.argv[2] === '--budget-comparison';
const runBoundComparison = process.argv[2] === '--run-bound-comparison';
const solutionTransferComparison = process.argv[2] === '--solution-transfer-comparison';
const coveredOffComparison = process.argv[2] === '--covered-off-comparison';
const paired = budgetComparison || runBoundComparison || solutionTransferComparison || coveredOffComparison;
const budgetTiming = process.argv[2] === '--budget-timing' || paired;
assert.equal(process.argv.length, budgetTiming ? 5 : 3,
  'Usage: compare-input-order-native.mjs manifest.json OR --budget-timing/--budget-comparison/--run-bound-comparison/--solution-transfer-comparison manifest.json image-sha256');
const manifestPath = process.argv[budgetTiming ? 3 : 2];
assert((await stat(manifestPath)).size <= 100_000, 'MANIFEST_LIMIT');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert((await stat(manifest.inputPath)).size <= 4_000_000, 'INPUT_LIMIT');
const raw = await readFile(manifest.inputPath);
const sha = value => createHash('sha256').update(value).digest('hex');
assert.equal(sha(raw), manifest.expectedInputSha256, 'EXACT_RETAINED_INPUT_REQUIRED');
const input = JSON.parse(raw);
let plannedCases;
if (budgetTiming) {
  assert.equal(input.schemaVersion, 'multi-task-v1'); assert.equal(input.mode, 'draft');
  assert.equal(input.staff.length, 500, 'FULL_RETAINED_500_FIXED_INPUT_REQUIRED');
  assert.equal(new Set(input.staff.map(s => s.id)).size, 500);
  assert.equal(input.locks.length, 1); assert.equal(input.exceptions.length, 1);
  assert.deepEqual([...input.locks[0].parts].sort(), ['break', 'pattern', 'time']);
  plannedCases = coveredOffComparison
    ? [['retained-original-off-hints', input, 'mvp-joint-v1'],
      ['retained-covered-off-hints', input, 'mvp-joint-covered-off-hints-v1']]
    : solutionTransferComparison
    ? [['retained-loop-solution-transfer', input, 'mvp-joint-loop-solution-transfer-v1'],
      ['retained-bulk-solution-transfer', input, 'mvp-joint-bulk-solution-transfer-v1']]
    : runBoundComparison
    ? [['retained-normal-run-bounds', input, 'mvp-joint-v1'],
      ['retained-tight-run-bounds', input, 'mvp-joint-tight-run-bounds-v1']]
    : budgetComparison
    ? [['retained-normal-presolve', input, 'mvp-joint-v1'],
      ['retained-main-no-presolve', input, 'mvp-joint-main-no-presolve-v1']]
    : [['retained-fixed-input', input, 'mvp-joint-v1']];
} else {
  plannedCases = [['original-uuid-order', input],
    ['staff-number-order', prepareStaffOrderComparison(input, manifest.orderedStaffIds)]];
}
const image = budgetTiming ? process.argv[4] : manifest.optimizerImageId;
assert.match(image, /^sha256:[a-f0-9]{64}$/);
const resource = { nanoCpus: 1e9, memoryBytes: 6 * 1024 ** 3 };
const root = path.join(path.dirname(manifestPath), 'measurements-' + randomUUID());
await mkdir(root, { mode: 0o700 });
const report = { scope: coveredOffComparison
  ? 'one planned exact full-500 fixed-input pair comparing original/covered-off hints; not full SDK/UI/Cloudflare acceptance'
  : solutionTransferComparison
  ? 'one planned pair of exact full-500 fixed inputs comparing complete solution/hint transfer; not normal SDK/UI/Cloudflare adoption'
  : runBoundComparison
  ? 'one planned pair of exact full-500 fixed inputs comparing equivalent run domains; not normal SDK/UI/Cloudflare adoption'
  : budgetComparison
  ? 'one planned pair of exact full-500 fixed inputs comparing main presolve; not normal SDK/UI/Cloudflare adoption'
  : budgetTiming
  ? 'one exact retained full-500 fixed-input native HTTP timing diagnostic; not SDK/UI/Cloudflare acceptance'
  : 'two order-only direct native HTTP diagnostics; not SDK/UI/Cloudflare acceptance',
  manifestSha256: sha(await readFile(manifestPath)), inputSha256: sha(raw), imageId: image,
  sourceImageId: manifest.optimizerImageId,
  profile: paired ? 'per-case' : 'mvp-joint-v1', budgetSeconds: 120, requestDeadlineMillis: 150000,
  resources: resource, cloudflareDeployments: 0, cloudflareCalculations: 0, cases: [],
  startedAt: new Date().toISOString() };
const overallDeadline = coveredOffComparison ? Date.now() + 15 * 60 * 1000 : Infinity;
console.log(JSON.stringify({ evidence: root, plannedCases: plannedCases.map(([label]) => label) }));
function docker(args) {
  const result = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 20_000_000 });
  assert.equal(result.status, 0, 'OWNED_DOCKER_OPERATION_FAILED');
  return result.stdout.trim();
}
async function boundedJson(response, limit) {
  const reader = response.body.getReader(); let bytes = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    bytes += value.length; assert(bytes <= limit, 'RESPONSE_LIMIT'); chunks.push(value); }
  } catch (error) { await reader.cancel(); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function post(base, route, payload, profile = 'mvp-joint-v1') {
  const body = JSON.stringify(payload); assert(Buffer.byteLength(body) <= 16_000_000);
  const millis = Math.min(150000, overallDeadline - Date.now() - 180000);
  assert(millis > 0, 'OVERALL_BUDGET_EXHAUSTED');
  const response = await fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Optimizer-Profile': profile },
    body, signal: AbortSignal.timeout(Math.floor(millis)) });
  const result = await boundedJson(response, 16_000_000);
  assert.equal(response.status, 200, 'NATIVE_HTTP_ERROR'); return result;
}
assert.equal(docker(['image', 'inspect', image, '--format', '{{.Id}}']), image);
for (const [label, data, profile = 'mvp-joint-v1'] of plannedCases) {
  const name = 'shift-order-diagnostic-' + randomUUID(), observations = [], observationErrors = [];
  const entry = { label, name, profile, inputSha256: sha(JSON.stringify(data)), solveRequests: 0, checkRequests: 0,
    ownedContainerRemoved: false, error: null };
  if (label === 'original-uuid-order' || budgetTiming) assert.equal(entry.inputSha256, report.inputSha256);
  report.cases.push(entry); let id = null, timer = null, observing = false;
  function observe() { if (observing) return; observing = true;
    try { observations.push(JSON.parse(docker(['exec', id, 'python', '-c', cgroupObservationCode]))); }
    catch (e) { observationErrors.push(e.message); } finally { observing = false; } }
  try {
    assert(overallDeadline > Date.now() + 6 * 60 * 1000, 'OVERALL_BUDGET_EXHAUSTED');
    id = docker(['create', '--platform', 'linux/amd64', '--name', name,
      '--cpus', '1', '--memory', '6g', '--memory-swap', '6g', '--publish', '127.0.0.1::8080', image]);
    const before = JSON.parse(docker(['inspect', id]))[0];
    assert.equal(before.State.Running, false); assert.equal(before.Image, image);
    assert.equal(before.HostConfig.NanoCpus, resource.nanoCpus);
    assert.equal(before.HostConfig.Memory, resource.memoryBytes);
    assert.equal(before.HostConfig.MemorySwap, resource.memoryBytes);
    entry.beforeStart = { id, imageId: before.Image, running: false, nanoCpus: before.HostConfig.NanoCpus,
      memoryBytes: before.HostConfig.Memory, memorySwapBytes: before.HostConfig.MemorySwap };
    docker(['start', id]); assertResourceLimits(resource, JSON.parse(docker(['inspect', id]))[0]);
    const port = docker(['port', id, '8080/tcp']); assert.match(port, /^127\.0\.0\.1:\d+$/);
    const base = 'http://' + port; let health;
    for (let n = 0; n < 40; n++) { try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(1000) });
      if (r.ok) { health = await boundedJson(r, 100000); break; } } catch {}
      await setTimeout(500); }
    assert(health, 'NATIVE_STARTUP_FAILED'); entry.sourceHashes = await assertNativeSources(health);
    observe(); timer = globalThis.setInterval(observe, 2000);
    console.log(JSON.stringify({ label, phase: 'solve-start', inputSha256: entry.inputSha256 }));
    const started = Date.now(); entry.solveRequests++;
    const result = await post(base, '/solve', data, profile); entry.solveMillis = Date.now() - started;
    await writeFile(root + '/' + label + '-result.json', JSON.stringify(result) + '\n');
    assert.equal(result.calculationProfile, profile);
    if (coveredOffComparison) assert.equal(result.metrics.coveredOffHintsEnabled, profile === 'mvp-joint-covered-off-hints-v1');
    entry.result = { solverStatus: result.solverStatus, validation: result.validation,
      rows: result.assignments?.length ?? 0, metrics: result.metrics, stages: result.stages };
    if (['OPTIMAL', 'FEASIBLE'].includes(result.solverStatus)) {
      assert.equal(result.validation.status, 'VERIFIED'); assert.equal(result.assignments.length, 15500);
      entry.checkRequests++; const checkedAt = Date.now();
      const checked = await post(base, '/check', { input: data, assignments: result.assignments });
      entry.checkMillis = Date.now() - checkedAt; entry.independentCheck = checked;
      assert.equal(checked.status, 'VERIFIED'); assert.deepEqual(checked.objectiveVector, result.validation.objectiveVector);
    } else { assert.equal(result.solverStatus, 'UNKNOWN'); assert.equal(result.validation.status, 'NOT_RUN'); }
    console.log(JSON.stringify({ label, phase: 'diagnostic-result', solverStatus: result.solverStatus,
      validationStatus: result.validation.status, solveMillis: entry.solveMillis, prepareSeconds: result.metrics?.prepareSeconds }));
  } catch (error) { entry.error = error.message; process.exitCode = 1; }
  finally {
    if (timer) globalThis.clearInterval(timer);
    if (!id) {
      // A timed-out create may have succeeded. Discover only this fresh name.
      const found = docker(['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']);
      assert(!found.includes('\n'), 'OWNED_CONTAINER_AMBIGUOUS');
      if (found) id = found;
    }
    if (id) { const current = JSON.parse(docker(['inspect', id]))[0];
      assert.equal(current.Image, image); assert.equal(current.Name, '/' + name);
      if (current.State.Running) observe(); entry.beforeStop = { running: current.State.Running, oomKilled: current.State.OOMKilled };
      docker(['stop', '--time', '1', id]); docker(['rm', id]);
      assert.equal(docker(['ps', '-a', '--filter', 'id=' + id, '--format', '{{.ID}}']), '');
      entry.ownedContainerRemoved = true;
    }
    entry.observations = observations; entry.observationErrors = observationErrors;
    entry.kernelPeakBytes = Math.max(0, ...observations.map(o => o.memoryPeakBytes));
    if (observationErrors.length || !observations.length || observations.some(o =>
      o.memoryMax !== String(resource.memoryBytes) || o.cpuMax !== '100000 100000' ||
      o.memoryEvents.oom || o.memoryEvents.oom_kill) || entry.beforeStop?.oomKilled) {
      entry.error ??= 'RESOURCE_OBSERVATION_FAILED'; process.exitCode = 1;
    }
    await writeFile(root + '/report.json', JSON.stringify(report, null, 2) + '\n');
  }
  if (entry.error) break;
}
report.endedAt = new Date().toISOString();
report.elapsedMillis = Date.parse(report.endedAt) - Date.parse(report.startedAt);
if (coveredOffComparison && report.cases.length === 2 && report.cases.every(c => !c.error && c.independentCheck)) {
  report.coveredOffComparison = compareCheckedObjectives(report.cases[0].independentCheck, report.cases[1].independentCheck);
  if (report.coveredOffComparison.relation === 'WORSE') process.exitCode = 1;
}
await writeFile(root + '/report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ evidence: root + '/report.json', completedCases: report.cases.length,
  ended: report.cases.every(c => c.ownedContainerRemoved), noAutomaticRetries: true,
  coveredOffComparison: report.coveredOffComparison }));
