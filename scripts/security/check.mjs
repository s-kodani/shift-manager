import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateSqliteVex } from './sqlite-vex.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
process.chdir(root);
const reports = path.join(root, 'artifacts/security');
await mkdir(reports, { recursive: true });
const environment = {
  ...process.env,
  UV_CACHE_DIR: path.join(root, '.cache/uv'),
  TRIVY_CACHE_DIR: path.join(root, '.cache/trivy'),
  SEMGREP_SEND_METRICS: 'off',
  SEMGREP_ENABLE_VERSION_CHECK: '0',
};
const statuses = [];
function run(name, command, args) {
  console.log(`Security check: ${name}`);
  const result = spawnSync(command, args, { env: environment, stdio: 'inherit' });
  statuses.push({ name, exitCode: result.status ?? 1 });
}
const binary = name => path.join(root, '.cache/security-bin', name);
run('workflow', binary('actionlint'), ['-color']);
run('secret-rules', process.execPath, ['scripts/security/test-secret-rules.mjs']);
const secretRules = path.join(root, '.gitleaks.toml');
run('secrets-history', binary('gitleaks'), ['git', '--config', secretRules, '--redact=100', '--report-format', 'json', '--report-path', `${reports}/secrets-history.json`]);

// Scan current tracked and new non-ignored files too. Never copy local secret files,
// ignored dependency caches or generated reports into a scan bundle.
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
if (listed.status !== 0) throw new Error('Cannot enumerate repository files');
await mkdir(path.join(root, '.cache'), { recursive: true });
const snapshot = await mkdtemp(path.join(root, '.cache/security-source-'));
try {
  for (const relative of new Set(listed.stdout.split('\0').filter(Boolean))) {
    const target = path.join(snapshot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    try { await copyFile(path.join(root, relative), target); } catch (error) {
      if (error.code !== 'ENOENT') throw error; // Deleted working files need no scan.
    }
  }
  run('secrets-worktree', binary('gitleaks'), ['dir', snapshot, '--config', secretRules, '--redact=100', '--report-format', 'json', '--report-path', `${reports}/secrets-worktree.json`]);
} finally { await rm(snapshot, { recursive: true, force: true }); }
run('sast', 'uv', ['run', '--project', 'tools/security', '--frozen', 'semgrep', 'scan', '--config', 'security/rules/project.yml', '--metrics=off', '--disable-version-check', '--error', '--strict', '--exclude', 'security/rules', '--json-output', `${reports}/semgrep.json`, 'apps', 'services', 'scripts']);
run('dependencies-and-container-config', binary('trivy'), ['fs', '--scanners', 'vuln,misconfig', '--include-dev-deps', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '--format', 'json', '--output', `${reports}/trivy-filesystem.json`, '--skip-dirs', 'node_modules,.cache,.git,artifacts,dist,.wrangler,services/optimizer/.venv,tools/security/.venv', '.']);
run('sbom', binary('trivy'), ['fs', '--scanners', 'vuln', '--include-dev-deps', '--format', 'cyclonedx', '--output', `${reports}/sbom.cdx.json`, '--skip-dirs', 'node_modules,.cache,.git,artifacts,dist,.wrangler,services/optimizer/.venv,tools/security/.venv', '.']);
if (process.env.SECURITY_IMAGE) {
  const vex = path.join(root, 'security/sqlite-fixed.openvex.json');
  validateSqliteVex(JSON.parse(await readFile(vex, 'utf8')));
  run('container-image', binary('trivy'), ['image', '--scanners', 'vuln', '--severity', 'HIGH,CRITICAL', '--exit-code', '1', '--vex', vex, '--show-suppressed', '--format', 'json', '--output', `${reports}/trivy-image.json`, process.env.SECURITY_IMAGE]);
  run('container-sbom', binary('trivy'), ['image', '--scanners', 'vuln', '--format', 'cyclonedx', '--output', `${reports}/image-sbom.cdx.json`, process.env.SECURITY_IMAGE]);
}
await writeFile(`${reports}/summary.json`, JSON.stringify({ date: new Date().toISOString(), image: process.env.SECURITY_IMAGE || null, statuses }, null, 2) + '\n');
console.log(JSON.stringify(statuses));
// Reports are retained for review, but failures never become a green check.
if (statuses.some(item => item.exitCode !== 0)) process.exitCode = 1;
