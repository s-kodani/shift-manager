-- Legacy BACKGROUND admissions remain completion-only. Only newly admitted
-- canonical delivery work has this revocable authority; no scope upgrades.
ALTER TABLE maintenance_lease ADD COLUMN delivery_guard INTEGER NOT NULL DEFAULT 0
 CHECK(delivery_guard IN (0,1) AND (delivery_guard=0 OR
  (kind='BACKGROUND' AND guard_version=0 AND resource_guard=0)));
CREATE TRIGGER maintenance_delivery_guard_immutable BEFORE UPDATE ON maintenance_lease
 WHEN NEW.delivery_guard IS NOT OLD.delivery_guard
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_GUARD'); END;
CREATE TABLE maintenance_delivery_lease_retirement(
 lease_id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES maintenance_retirement_operation(id),
 kind TEXT NOT NULL CHECK(kind='BACKGROUND'),started_at INTEGER NOT NULL,
 delivery_guard INTEGER NOT NULL CHECK(delivery_guard=1),retired_at INTEGER NOT NULL
);
CREATE TRIGGER maintenance_delivery_retirement_valid BEFORE INSERT ON maintenance_delivery_lease_retirement
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_retirement_operation o ON o.id=NEW.operation_id
  WHERE l.id=NEW.lease_id AND l.kind=NEW.kind AND l.started_at=NEW.started_at
   AND l.guard_version=0 AND l.resource_guard=0 AND l.delivery_guard=1
   AND l.completed_at IS NULL AND NEW.retired_at=o.created_at)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_DELIVERY_GUARD_REQUIRED'); END;
CREATE TRIGGER maintenance_delivery_retirement_no_update BEFORE UPDATE ON maintenance_delivery_lease_retirement
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_delivery_retirement_no_delete BEFORE DELETE ON maintenance_delivery_lease_retirement
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_RETIREMENT'); END;
CREATE TRIGGER maintenance_retired_delivery_no_reuse BEFORE INSERT ON maintenance_lease
 WHEN EXISTS(SELECT 1 FROM maintenance_delivery_lease_retirement WHERE lease_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_LEASE_RETIRED'); END;
DROP TRIGGER maintenance_retirement_commit_complete;
CREATE TRIGGER maintenance_retirement_commit_complete BEFORE INSERT ON maintenance_retirement_commit
 WHEN ((SELECT count(*) FROM maintenance_lease_retirement WHERE operation_id=NEW.operation_id)
  +(SELECT count(*) FROM maintenance_delivery_lease_retirement WHERE operation_id=NEW.operation_id))<>NEW.expected_count
  OR EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_lease_retirement r ON r.lease_id=l.id WHERE r.operation_id=NEW.operation_id)
  OR EXISTS(SELECT 1 FROM maintenance_lease l JOIN maintenance_delivery_lease_retirement r ON r.lease_id=l.id WHERE r.operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM maintenance_retirement_operation o JOIN maintenance_state s ON s.id=1
   WHERE o.id=NEW.operation_id AND s.mode='DRAINING' AND s.last_operation_id=o.id
    AND s.revision=o.revision AND s.maintenance_id=o.maintenance_id)
 BEGIN SELECT RAISE(ABORT,'INCOMPLETE_MAINTENANCE_RETIREMENT'); END;
