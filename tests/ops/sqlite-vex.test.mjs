import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSqliteVex } from '../../scripts/security/sqlite-vex.mjs';
const document = JSON.parse(await readFile('security/sqlite-fixed.openvex.json', 'utf8'));
const now = Date.parse('2026-11-14T12:00:00Z');

test('fixed SQLite VEX accepts only the reviewed component and its three upstream-fixed CVEs', () => {
  validateSqliteVex(document, now);
  for (const change of [
    d => d.statements[0].products[0]['@id'] = 'pkg:deb/debian/libsqlite3-0@3.46.1-7+deb13u2?arch=amd64&distro=debian-13.7',
    d => d.statements[0].products.push({ '@id': 'pkg:deb/debian/other@1' }),
    d => d.statements[0].vulnerability.name = 'CVE-2026-OTHER',
    d => d.statements[0].status = 'not_affected',
  ]) {
    const edited = structuredClone(document); change(edited);
    assert.throws(() => validateSqliteVex(edited, now));
  }
});
test('fixed SQLite VEX expires and cannot be future-issued or given an indefinite review period', () => {
  assert.throws(() => validateSqliteVex(document, Date.parse('2026-12-14T00:00:00Z')));
  assert.throws(() => validateSqliteVex(document, Date.parse('2026-11-13T00:00:00Z')));
  const edited = structuredClone(document); edited['x-review-until'] = '2027-12-14T00:00:00Z';
  assert.throws(() => validateSqliteVex(edited, now));
});
