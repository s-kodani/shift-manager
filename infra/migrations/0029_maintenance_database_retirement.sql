-- Existing work is unguarded, and never becomes recoverable by its age.
ALTER TABLE maintenance_lease ADD COLUMN guard_version INTEGER NOT NULL DEFAULT 0
 CHECK(guard_version IN (0,1) AND (guard_version=0 OR kind='FOREGROUND'));
CREATE TRIGGER maintenance_guard_version_immutable BEFORE UPDATE ON maintenance_lease
 WHEN NEW.guard_version IS NOT OLD.guard_version
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_GUARD'); END;

-- Keep existing completion receipts and their foreign keys unchanged. A
-- retirement is revocation of SQL authority, never fabricated completion.
CREATE TABLE maintenance_retirement_operation(
 id TEXT PRIMARY KEY,principal TEXT NOT NULL,action TEXT NOT NULL CHECK(action='retire'),
 fingerprint TEXT NOT NULL,maintenance_id TEXT NOT NULL,
 mode TEXT NOT NULL CHECK(mode='DRAINING'),revision INTEGER NOT NULL,
 reason TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TRIGGER maintenance_retirement_operation_no_update BEFORE UPDATE ON maintenance_retirement_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_retirement_operation_no_delete BEFORE DELETE ON maintenance_retirement_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_retirement_operation_unique BEFORE INSERT ON maintenance_retirement_operation
 WHEN EXISTS(SELECT 1 FROM maintenance_operation WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_OPERATION_REUSED'); END;
CREATE TRIGGER maintenance_operation_unique_retirement BEFORE INSERT ON maintenance_operation
 WHEN EXISTS(SELECT 1 FROM maintenance_retirement_operation WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_OPERATION_REUSED'); END;
CREATE TABLE maintenance_lease_retirement(
 lease_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES maintenance_retirement_operation(id),
 kind TEXT NOT NULL CHECK(kind='FOREGROUND'),started_at INTEGER NOT NULL,
 guard_version INTEGER NOT NULL CHECK(guard_version=1),retired_at INTEGER NOT NULL
);
CREATE TRIGGER maintenance_lease_retirement_valid BEFORE INSERT ON maintenance_lease_retirement
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_retirement_operation o ON o.id=NEW.operation_id
  WHERE l.id=NEW.lease_id AND l.kind=NEW.kind AND l.started_at=NEW.started_at
   AND l.guard_version=1 AND l.completed_at IS NULL AND NEW.retired_at=o.created_at)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DATABASE_GUARD_REQUIRED'); END;
CREATE TRIGGER maintenance_lease_retirement_no_update BEFORE UPDATE ON maintenance_lease_retirement
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_lease_retirement_no_delete BEFORE DELETE ON maintenance_lease_retirement
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TABLE maintenance_retirement_commit(
 operation_id TEXT PRIMARY KEY REFERENCES maintenance_retirement_operation(id),
 expected_count INTEGER NOT NULL CHECK(expected_count BETWEEN 1 AND 40)
);
CREATE TRIGGER maintenance_retirement_commit_complete BEFORE INSERT ON maintenance_retirement_commit
 WHEN (SELECT count(*) FROM maintenance_lease_retirement WHERE operation_id=NEW.operation_id)<>NEW.expected_count
  OR EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_lease_retirement r ON r.lease_id=l.id WHERE r.operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM maintenance_retirement_operation o JOIN maintenance_state s ON s.id=1
   WHERE o.id=NEW.operation_id AND s.mode='DRAINING' AND s.last_operation_id=o.id
    AND s.revision=o.revision AND s.maintenance_id=o.maintenance_id)
 BEGIN SELECT RAISE(ABORT,'INCOMPLETE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_retirement_commit_no_update BEFORE UPDATE ON maintenance_retirement_commit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_retirement_commit_no_delete BEFORE DELETE ON maintenance_retirement_commit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;

CREATE TRIGGER maintenance_retired_lease_no_reuse BEFORE INSERT ON maintenance_lease
 WHEN EXISTS(SELECT 1 FROM maintenance_lease_retirement WHERE lease_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_LEASE_RETIRED'); END;
