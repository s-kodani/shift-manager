import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const definitions = JSON.parse(await readFile(new URL('tools.json', import.meta.url), 'utf8'));
const cache = path.join(root, '.cache/security-downloads');
const bin = path.join(root, '.cache/security-bin');
await mkdir(cache, { recursive: true });
await mkdir(bin, { recursive: true });
for (const [name, definition] of Object.entries(definitions)) {
  const asset = definition[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  const archive = path.join(cache, asset.file);
  let bytes;
  try { bytes = await readFile(archive); } catch {
    const url = `https://github.com/${definition.repo}/releases/download/v${definition.version}/${asset.file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`${name}: download HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`${name}: SHA-256 mismatch; no execution permitted`);
  }
  await writeFile(archive, bytes);
  // Extract only the expected executable from the digest-verified official archive.
  const result = spawnSync('tar', ['-xzf', archive, '-C', bin, name], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${name}: extraction failed`);
  console.log(`Installed ${name} ${definition.version} (digest verified)`);
}
