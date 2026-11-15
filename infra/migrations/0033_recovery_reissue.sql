-- Fresh operator verification when the current source cannot be consulted.
-- These receipts do not claim that a frozen source checkpoint was captured.
CREATE TABLE recovery_security_reissue_receipt(
 id TEXT PRIMARY KEY,restore_id TEXT NOT NULL UNIQUE,principal TEXT NOT NULL,
 fingerprint TEXT NOT NULL,backup_id TEXT NOT NULL,source_database_id TEXT NOT NULL,
 isolation_evidence_ref TEXT NOT NULL,verified_at INTEGER NOT NULL,
 maintenance_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,
 created_at INTEGER NOT NULL,confirmations TEXT NOT NULL,counts TEXT NOT NULL
);
CREATE VIEW recovery_security_authorization AS
 SELECT restore_id FROM recovery_security_receipt
 UNION ALL SELECT restore_id FROM recovery_security_reissue_receipt;
CREATE TRIGGER recovery_reissue_valid BEFORE INSERT ON recovery_security_reissue_receipt
 WHEN NOT EXISTS(SELECT 1 FROM maintenance_state s WHERE s.id=1 AND s.mode='FROZEN'
  AND s.maintenance_id=NEW.maintenance_id AND s.revision=NEW.revision AND s.last_operation_id=NEW.id)
  OR EXISTS(SELECT 1 FROM recovery_security_receipt WHERE restore_id=NEW.restore_id OR id=NEW.id)
  OR EXISTS(SELECT 1 FROM maintenance_operation WHERE id=NEW.id)
  OR EXISTS(SELECT 1 FROM maintenance_retirement_operation WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'INVALID_RECOVERY_REISSUE_RECEIPT'); END;
CREATE TRIGGER recovery_reissue_no_update BEFORE UPDATE ON recovery_security_reissue_receipt
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECOVERY_REISSUE_RECEIPT'); END;
CREATE TRIGGER recovery_reissue_no_delete BEFORE DELETE ON recovery_security_reissue_receipt
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECOVERY_REISSUE_RECEIPT'); END;
CREATE TRIGGER checkpoint_reissue_exclusive BEFORE INSERT ON recovery_security_receipt
 WHEN EXISTS(SELECT 1 FROM recovery_security_reissue_receipt WHERE restore_id=NEW.restore_id OR id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_ALREADY_RECONCILED'); END;
CREATE TRIGGER maintenance_reissue_unique BEFORE INSERT ON maintenance_operation
 WHEN EXISTS(SELECT 1 FROM recovery_security_reissue_receipt WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_OPERATION_REUSED'); END;
CREATE TRIGGER maintenance_retirement_reissue_unique BEFORE INSERT ON maintenance_retirement_operation
 WHEN EXISTS(SELECT 1 FROM recovery_security_reissue_receipt WHERE id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'RECOVERY_OPERATION_REUSED'); END;
