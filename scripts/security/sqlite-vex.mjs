import assert from 'node:assert/strict';

export function validateSqliteVex(document, now = Date.now()) {
  const issued = Date.parse(document.timestamp), until = Date.parse(document['x-review-until']);
  assert(Number.isFinite(issued) && Number.isFinite(until) && issued <= now && now < until
    && until - issued <= 31 * 86400000, 'SQLITE_VEX_REVIEW_EXPIRED_OR_INVALID');
  assert.equal(document['@context'], 'https://openvex.dev/ns/v0.2.0');
  assert.equal(document.author, 'shift-planner maintainers');
  assert.equal(document.statements.length, 3);
  assert.deepEqual(document.statements.map(s => s.vulnerability.name).sort(),
    ['CVE-2026-119373', 'CVE-2026-119374', 'CVE-2026-119379']);
  for (const statement of document.statements) {
    assert.equal(statement.status, 'fixed');
    assert.deepEqual(statement.products, [{ '@id': 'pkg:deb/debian/libsqlite3-0@3.54.1-2?arch=amd64&distro=debian-13.7' }]);
    assert(statement.status_notes.includes('https://security-tracker.debian.org/tracker/' + statement.vulnerability.name));
    assert(!statement.subcomponents, 'SQLITE_VEX_SCOPE_CHANGED');
  }
}
