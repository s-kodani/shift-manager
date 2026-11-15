-- Completion is persisted only after the admitted work has settled. Age is
-- never completion evidence. Old/unmarked leases continue to block freezing.
ALTER TABLE maintenance_lease ADD COLUMN completed_at INTEGER
 CHECK(completed_at IS NULL OR completed_at>=0);
CREATE TRIGGER maintenance_lease_completion_immutable BEFORE UPDATE ON maintenance_lease
 WHEN OLD.completed_at IS NOT NULL AND
 (NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR
  NEW.started_at IS NOT OLD.started_at OR NEW.completed_at IS NOT OLD.completed_at)
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_COMPLETION'); END;

-- Extend the operation kind while retaining every historical receipt.
DROP TRIGGER maintenance_operation_no_update;
DROP TRIGGER maintenance_operation_no_delete;
CREATE TABLE maintenance_operation_next (
 id TEXT PRIMARY KEY,
 principal TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('begin','freeze','resume','reclaim')),
 fingerprint TEXT NOT NULL,
 maintenance_id TEXT,
 mode TEXT NOT NULL CHECK(mode IN ('OPEN','DRAINING','FROZEN')),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
INSERT INTO maintenance_operation_next SELECT * FROM maintenance_operation;
DROP TABLE maintenance_operation;
ALTER TABLE maintenance_operation_next RENAME TO maintenance_operation;
CREATE TRIGGER maintenance_operation_no_update BEFORE UPDATE ON maintenance_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_OPERATION'); END;
CREATE TRIGGER maintenance_operation_no_delete BEFORE DELETE ON maintenance_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_OPERATION'); END;

-- Only recovered completions are archived. Successful ordinary requests do
-- not accumulate an unbounded per-request audit log.
CREATE TABLE maintenance_lease_recovery (
 lease_id TEXT PRIMARY KEY,
 operation_id TEXT NOT NULL REFERENCES maintenance_operation(id),
 kind TEXT NOT NULL CHECK(kind IN ('FOREGROUND','BACKGROUND')),
 started_at INTEGER NOT NULL,
 completed_at INTEGER NOT NULL CHECK(completed_at>=0)
);
CREATE TRIGGER maintenance_lease_recovery_no_update BEFORE UPDATE ON maintenance_lease_recovery
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RECOVERY'); END;
CREATE TRIGGER maintenance_lease_recovery_no_delete BEFORE DELETE ON maintenance_lease_recovery
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RECOVERY'); END;
CREATE TRIGGER maintenance_lease_recovery_completed BEFORE INSERT ON maintenance_lease_recovery
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_operation o ON o.id=NEW.operation_id
  WHERE l.id=NEW.lease_id AND l.completed_at IS NOT NULL AND
   l.kind=NEW.kind AND l.started_at=NEW.started_at AND l.completed_at=NEW.completed_at AND o.action='reclaim')
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_COMPLETION_REQUIRED'); END;

-- A persisted receipt alone is insufficient if a write was silently skipped.
-- The final insert asserts the whole recovery at the transaction boundary.
CREATE TABLE maintenance_recovery_commit (
 operation_id TEXT PRIMARY KEY REFERENCES maintenance_operation(id),
 expected_count INTEGER NOT NULL CHECK(expected_count BETWEEN 1 AND 40)
);
CREATE TRIGGER maintenance_recovery_commit_complete BEFORE INSERT ON maintenance_recovery_commit
 WHEN (SELECT count(*) FROM maintenance_lease_recovery WHERE operation_id=NEW.operation_id)<>NEW.expected_count
  OR EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_lease_recovery r ON r.lease_id=l.id WHERE r.operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM maintenance_operation o JOIN maintenance_state s ON s.id=1
   WHERE o.id=NEW.operation_id AND o.action='reclaim' AND s.mode='DRAINING'
    AND s.last_operation_id=o.id AND s.revision=o.revision AND s.maintenance_id=o.maintenance_id)
 BEGIN SELECT RAISE(ABORT,'INCOMPLETE_MAINTENANCE_RECOVERY'); END;
CREATE TRIGGER maintenance_recovery_commit_no_update BEFORE UPDATE ON maintenance_recovery_commit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RECOVERY'); END;
CREATE TRIGGER maintenance_recovery_commit_no_delete BEFORE DELETE ON maintenance_recovery_commit
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RECOVERY'); END;
