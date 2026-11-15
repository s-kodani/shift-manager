-- A new restore namespace cannot reuse a receipt copied from an older one.
CREATE TABLE recovery_security_receipt(
 id TEXT PRIMARY KEY,restore_id TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,
 fingerprint TEXT NOT NULL,source_database_id TEXT NOT NULL,
 source_maintenance_id TEXT NOT NULL,source_revision INTEGER NOT NULL,
 source_captured_at INTEGER NOT NULL,source_sha256 TEXT NOT NULL,
 maintenance_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,
 created_at INTEGER NOT NULL,counts TEXT NOT NULL
);
CREATE TRIGGER recovery_security_receipt_valid BEFORE INSERT ON recovery_security_receipt
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_state s WHERE s.id=1 AND s.mode='FROZEN'
  AND s.maintenance_id=NEW.maintenance_id AND s.revision=NEW.revision AND s.last_operation_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'INVALID_RECOVERY_SECURITY_RECEIPT'); END;
CREATE TRIGGER recovery_security_receipt_no_update BEFORE UPDATE ON recovery_security_receipt
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECOVERY_SECURITY_RECEIPT'); END;
CREATE TRIGGER recovery_security_receipt_no_delete BEFORE DELETE ON recovery_security_receipt
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECOVERY_SECURITY_RECEIPT'); END;
CREATE TRIGGER recovery_security_operation_unique BEFORE INSERT ON recovery_security_receipt
 WHEN EXISTS(SELECT 1 FROM maintenance_operation WHERE id=NEW.id)
  OR EXISTS(SELECT 1 FROM maintenance_retirement_operation WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_OPERATION_REUSED'); END;
CREATE TRIGGER maintenance_operation_unique_security BEFORE INSERT ON maintenance_operation
 WHEN EXISTS(SELECT 1 FROM recovery_security_receipt WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_OPERATION_REUSED'); END;
CREATE TRIGGER maintenance_retirement_unique_security BEFORE INSERT ON maintenance_retirement_operation
 WHEN EXISTS(SELECT 1 FROM recovery_security_receipt WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_OPERATION_REUSED'); END;
