-- A guarded business request has SQL authority, immutable R2 writes, validated
-- idempotent delivery and admission-aware checker RPC. Legacy rows stay 0.
ALTER TABLE maintenance_lease ADD COLUMN resource_guard INTEGER NOT NULL DEFAULT 0
 CHECK(resource_guard IN (0,1) AND (resource_guard=0 OR (kind='FOREGROUND' AND guard_version=1)));
CREATE TRIGGER maintenance_resource_guard_immutable BEFORE UPDATE ON maintenance_lease
 WHEN NEW.resource_guard IS NOT OLD.resource_guard
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_GUARD'); END;
ALTER TABLE maintenance_lease_retirement ADD COLUMN resource_guard INTEGER NOT NULL DEFAULT 0
 CHECK(resource_guard IN (0,1));
CREATE TRIGGER maintenance_business_retirement_valid BEFORE INSERT ON maintenance_lease_retirement
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_lease l WHERE l.id=NEW.lease_id AND l.resource_guard=NEW.resource_guard)
 BEGIN SELECT RAISE(ABORT,'MAINTENANCE_RESOURCE_GUARD_REQUIRED'); END;
