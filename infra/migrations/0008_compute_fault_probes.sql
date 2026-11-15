-- Private PoC fault evidence: never a product command or a secret store.
CREATE TABLE compute_fault_probe (
 id TEXT PRIMARY KEY, probe_id TEXT NOT NULL REFERENCES compute_probe(id),
 attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 3),
 mode TEXT NOT NULL CHECK(mode IN ('restart','crash')),
 before_boot TEXT NOT NULL, requested_at INTEGER NOT NULL,
 after_boot TEXT, after_process_running INTEGER CHECK(after_process_running IN (0,1)), observed_at INTEGER,
 recovery_boot TEXT, recovery_stopped_at INTEGER
);
CREATE TRIGGER compute_fault_identity BEFORE UPDATE ON compute_fault_probe
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_FAULT_IDENTITY') WHERE NEW.id!=OLD.id OR NEW.probe_id!=OLD.probe_id
  OR NEW.attempt!=OLD.attempt OR NEW.mode!=OLD.mode OR NEW.before_boot!=OLD.before_boot OR NEW.requested_at!=OLD.requested_at;
 SELECT RAISE(ABORT,'IMMUTABLE_FAULT_OBSERVATION') WHERE OLD.observed_at IS NOT NULL AND
  (NEW.observed_at IS NOT OLD.observed_at OR NEW.after_boot IS NOT OLD.after_boot OR NEW.after_process_running IS NOT OLD.after_process_running);
 SELECT RAISE(ABORT,'IMMUTABLE_FAULT_RECOVERY') WHERE OLD.recovery_stopped_at IS NOT NULL AND
  (NEW.recovery_stopped_at IS NOT OLD.recovery_stopped_at OR NEW.recovery_boot IS NOT OLD.recovery_boot);
END;
CREATE TRIGGER compute_fault_no_delete BEFORE DELETE ON compute_fault_probe
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FAULT_EVIDENCE'); END;
