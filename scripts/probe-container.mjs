import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { waitForOwnedContainerRemoval } from './owned-container-cleanup.mjs';

const { values: { benchmarks } } = parseArgs({
  options: { benchmarks: { type: 'boolean', default: false } },
});

const image = process.env.SECURITY_IMAGE || 'shift-planner-security';
const name = `shift-planner-health-${randomUUID()}`;
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(result.stderr || 'Docker probe failed');
  return result.stdout.trim();
}
let created = false;
try {
  const runtime = JSON.parse(docker(['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'python', image,
    '-c', [
      'import gzip, json, os, pathlib, platform, sqlite3, ssl, subprocess, uuid, zlib',
      'from ortools.sat.python import cp_model',
      'loader = next(pathlib.Path("/lib").rglob("ld-linux-x86-64.so.2"))',
      'objects = list(pathlib.Path("/usr/local").rglob("*.so"))',
      'missing = [str(p) for p in objects if subprocess.run([str(loader), "--list", str(p)], capture_output=True).returncode]',
      'assert not missing, missing',
      'assert os.getuid() != 0',
      'assert all(not pathlib.Path(p).exists() for p in ("/bin/sh", "/bin/bash", "/usr/bin/apt-get", "/usr/bin/dpkg"))',
      'assert pathlib.Path(ssl.get_default_verify_paths().cafile).is_file()',
      'assert uuid.uuid4().version == 4',
      'assert sqlite3.sqlite_version_info >= (3, 54, 0)',
      'assert "Version: 3.54.1-2\\n" in pathlib.Path("/var/lib/dpkg/status.d/libsqlite3-0").read_text()',
      'assert "Version: 1:1.3.dfsg+really1.3.1-1+deb13u1\\n" in pathlib.Path("/var/lib/dpkg/status.d/zlib1g").read_text()',
      'db = sqlite3.connect(":memory:")',
      'db.execute("CREATE TABLE records(value TEXT, payload BLOB)")',
      'db.execute("INSERT INTO records VALUES(?,?)", ("架空データ", b"\\x00\\xff")); db.commit()',
      'db.execute("DELETE FROM records"); db.rollback()',
      'assert db.execute("SELECT * FROM records").fetchall() == [("架空データ", b"\\x00\\xff")]',
      'db.execute("CREATE VIRTUAL TABLE docs USING fts5(value, detail=none, prefix=2)")',
      'db.executemany("INSERT INTO docs(rowid,value) VALUES(?,?)", [(n,"verified") for n in range(-10,0)])',
      'assert len(db.execute("SELECT rowid FROM docs WHERE docs MATCH ?", ("v*",)).fetchall()) == 10',
      'db.execute("INSERT INTO docs(docs,rank) VALUES(?,?)", ("secure-delete",1))',
      'db.execute("DELETE FROM docs WHERE rowid=-1"); db.close()',
      'payload = "架空データ".encode() * 200',
      'assert zlib.decompress(zlib.compress(payload)) == payload',
      'assert gzip.decompress(gzip.compress(payload)) == payload',
      'print(json.dumps({"python": platform.python_version(), "nativeObjects": len(objects), "uid": os.getuid(), "sqlite": sqlite3.sqlite_version, "zlib": zlib.ZLIB_RUNTIME_VERSION}))',
    ].join('\n')]));
  assert.ok(runtime.nativeObjects > 0);
  console.log('Minimal runtime, all CPython/wheel ELF links, non-root UID, TLS CA and UUID verified', runtime);
  docker(['run', '--detach', '--rm', '--platform', 'linux/amd64', '--name', name,
    '--health-interval=1s', '--health-start-period=1s', '--env', `CLOUDFLARE_DEPLOYMENT_ID=${name}`,
    '--publish', '127.0.0.1::8080', image]);
  created = true;
  const port = docker(['port', name, '8080/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Probe must stay on loopback');
  const deadline = Date.now() + 20000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (docker(['inspect', '--format', '{{.State.Health.Status}}', name]) === 'healthy') {
      const response = await fetch(`http://${port}/health`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        status: 'ok', scope: 'single-task-v0', profiles: ['single-task-v0', 'multi-task-v1'],
        sourceSha256: Object.fromEntries(readdirSync('services/optimizer/optimizer').filter(name=>name.endsWith('.py')).sort().map(name=>[name,createHash('sha256').update(readFileSync(join('services/optimizer/optimizer',name))).digest('hex')])),
        runtime: { uid: runtime.uid, hasShell: false, deploymentId: name },
      });
      healthy = true;
      break;
    }
    await setTimeout(500);
  }
  assert.ok(healthy, 'Container did not become healthy');
  const input = JSON.parse(docker(['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', 'python', image,
    '-c', 'import json; from optimizer.fixtures import multi_synthetic; print(json.dumps(multi_synthetic(1, tiny=True)))']));
  async function post(route, body, profile) {
    const response = await fetch(`http://${port}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(profile ? {'x-optimizer-profile':profile}: {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(25000),
    });
    const payload = await response.json();
    const safeErrors = new Set(['BUSY', 'MODEL_ERROR', 'BODY_LIMIT', 'INVALID_CONTENT_LENGTH',
      'ValidationError', 'ValueError', 'KeyError', 'TypeError']);
    const error = safeErrors.has(payload?.error) ? ` (${payload.error})` : '';
    assert.equal(response.status, 200,
      `POST ${route} [${profile || 'default'}] returned HTTP ${response.status}${error}`);
    return payload;
  }
  const result = await post('/solve', input);
  assert.equal(result.schemaVersion, 'multi-task-v1');
  assert.equal(result.metrics.modelEncoding, 'shared-daily-v1');
  assert.ok(result.metrics.initialHintVariables > 0);
  assert.equal(result.validation.status, 'VERIFIED');
  assert.equal(result.publication, 'BLOCKED_A1');
  const report = await post('/check', { input, assignments: result.assignments });
  assert.equal(report.status, 'VERIFIED');
  assert.deepEqual(report.objectiveVector, result.validation.objectiveVector);
  if (benchmarks) {
    for (const strategy of ['balanced-incumbent-v2', 'balanced-incumbent-v3', 'balanced-incumbent-v4']) {
      const benchmark = await post('/benchmark', {
        input: { ...input, jobId: 'fictional-runtime-benchmark' }, strategy, budgetSeconds: 5,
      });
      assert.equal(benchmark.validation.status, 'VERIFIED');
      assert.equal(benchmark.metrics.initialHintStrategy, strategy);
      assert.equal(benchmark.assignments, undefined);
      assert.ok(benchmark.assignmentCount > 0);
      console.log('Benchmark hint strategy verified:', strategy);
    }
  }
  const configured = await post('/solve', input, 'mvp-joint-v1');
  assert.equal(configured.calculationProfile, 'mvp-joint-v1');
  assert.equal(configured.metrics.budgetSeconds, 120);
  assert.equal(configured.metrics.initialHintStrategy, 'balanced-incumbent-v4');
  assert.equal(configured.validation.status, 'VERIFIED');
  assert.equal((await post('/check', {input, assignments:configured.assignments})).status, 'VERIFIED');
  const source={draftId:'fictional-runtime-draft',draftRevision:1};
  const envelope={schemaVersion:'solve-seed-v1',input,savedCandidate:{source,assignments:configured.assignments}};
  const seeded=await post('/solve',envelope,'mvp-joint-seed-v1');
  assert.equal(seeded.calculationProfile,'mvp-joint-seed-v1');
  assert.deepEqual(seeded.savedCandidateSource,source);
  assert.equal(seeded.metrics.savedCandidate.precheckStatus,'VERIFIED');
  assert.equal(seeded.metrics.savedCandidate.adopted,true);
  assert.equal(seeded.validation.status,'VERIFIED');
  assert.deepEqual(seeded.validation.objectiveVector,configured.validation.objectiveVector);
  assert.equal((await post('/check',{input,assignments:seeded.assignments})).status,'VERIFIED');
  const badCandidate=structuredClone(envelope);
  badCandidate.savedCandidate.assignments.find(a=>a.shift).shift.workedMinutes+=1;
  const fallback=await post('/solve',badCandidate,'mvp-joint-seed-v1');
  assert.equal(fallback.metrics.savedCandidate.precheckStatus,'INVALID');
  assert.equal(fallback.metrics.savedCandidate.adopted,false);
  assert.equal(fallback.validation.status,'VERIFIED');
  assert.equal((await post('/check',{input,assignments:fallback.assignments})).status,'VERIFIED');
  const changed = structuredClone(result.assignments);
  changed.find(a => a.shift).shift.workedMinutes += 1;
  assert.equal((await post('/check', { input, assignments: changed })).status, 'INVALID');
  console.log('Non-root health, multi-task HTTP solve, checked saved-candidate profile/fallback, independent check and mutation rejection verified');
} finally {
  if (created) {
    docker(['stop', '--time', '1', name]);
    await waitForOwnedContainerRemoval(() => docker([
      'ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.ID}}',
    ]));
  }
}
