"""Read one terminal owned local fixture's exact snapshot, without starting it."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import uuid


def database(directory):
    files = [p for p in directory.glob('*.sqlite') if p.name != 'metadata.sqlite']
    assert len(files) == 1, 'LOCAL_DATABASE_AMBIGUOUS'
    return sqlite3.connect(files[0].resolve().as_uri() + '?mode=ro', uri=True)


def main():
    assert len(sys.argv) == 3, 'Usage: extract-local-input-order.py runtime-uuid job-uuid'
    runtime_id, job_id = (str(uuid.UUID(arg)) for arg in sys.argv[1:])
    artifact = Path('artifacts/bounded-sdk') / runtime_id
    runtime = json.loads((artifact / 'runtime.json').read_text())
    assert runtime['mode'] == 'local' and runtime['cleanupError'] is None
    assert runtime['workerStopped'] and runtime['ownedContainersRemoved']
    assert runtime['fixtureCredentialsDisabled']
    state = Path('.cache/bounded-sdk') / runtime_id / '.wrangler/state/v3'
    with database(state / 'd1/miniflare-D1DatabaseObject') as db:
        row = db.execute('''SELECT j.company_id,j.team_id,j.state,s.object_key,
            s.sha256,s.byte_length FROM compute_job j JOIN input_snapshot s
            ON s.company_id=j.company_id AND s.id=j.snapshot_id WHERE j.id=?''',
            (job_id,)).fetchone()
        assert row and row[2] in ('SUCCEEDED', 'NO_SOLUTION'), 'TERMINAL_JOB_REQUIRED'
        people = db.execute('''SELECT id,staff_number FROM staff
            WHERE company_id=? AND team_id=? ORDER BY staff_number COLLATE BINARY''',
            row[:2]).fetchall()
        assert len(people) == 500 and all(p[1].startswith('fixture-') for p in people)
    with database(state / 'r2/miniflare-R2BucketObject') as db:
        found = db.execute('SELECT blob_id FROM _mf_objects WHERE key=?', (row[3],)).fetchone()
        assert found, 'SNAPSHOT_OBJECT_MISSING'
    blobs = list((state / 'r2').glob('*/blobs/' + found[0]))
    assert len(blobs) == 1, 'SNAPSHOT_BLOB_AMBIGUOUS'
    raw = blobs[0].read_bytes()
    assert len(raw) == row[5] and len(raw) <= 4_000_000
    assert hashlib.sha256(raw).hexdigest() == row[4], 'SNAPSHOT_DIGEST_MISMATCH'
    data = json.loads(raw)
    assert data['tenantId'] == row[0] and data['teamId'] == row[1]
    assert {p['id'] for p in data['staff']} == {p[0] for p in people}
    destination = Path('artifacts/input-order-comparison') / str(uuid.uuid4())
    destination.mkdir(parents=True, mode=0o700)
    input_path = destination / 'input.json'
    input_path.write_bytes(raw)
    os.chmod(input_path, 0o600)
    manifest = {
        'scope': 'exact retained terminal local fixture; two planned order-only diagnostics',
        'runtimeId': runtime_id, 'jobId': job_id, 'sourceJobState': row[2],
        'inputPath': str(input_path), 'expectedInputSha256': row[4],
        'optimizerImageId': runtime['optimizerImageId'],
        'orderedStaffIds': [p[0] for p in people],
        'sourceStaffNumbers': [p[1] for p in people],
        'cloudflareDeployments': 0, 'cloudflareCalculations': 0,
    }
    manifest_path = destination / 'manifest.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'manifest': str(manifest_path), 'inputSha256': row[4]}))


if __name__ == '__main__':
    main()
