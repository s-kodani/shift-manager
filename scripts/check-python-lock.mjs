import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const result = spawnSync('uv', ['export', '--project', 'services/optimizer', '--frozen', '--no-dev', '--no-header', '--format', 'requirements-txt'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || 'Cannot export optimizer lock');
const locked = (await readFile('services/optimizer/requirements.lock', 'utf8'))
  .replace(/^# This file[^\n]*\n#\s+uv export[^\n]*\n/, '');
if (locked.trim() !== result.stdout.trim()) {
  throw new Error('requirements.lock differs from uv.lock; run uv export --project services/optimizer --frozen --no-dev --format requirements-txt --output-file services/optimizer/requirements.lock');
}
console.log('Optimizer container requirements match uv.lock');
