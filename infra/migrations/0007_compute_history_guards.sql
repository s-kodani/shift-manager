CREATE TRIGGER compute_job_no_delete BEFORE DELETE ON compute_job
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_JOB'); END;
CREATE TRIGGER compute_cancel_no_update BEFORE UPDATE ON compute_cancel_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCEL_OPERATION'); END;
CREATE TRIGGER compute_cancel_no_delete BEFORE DELETE ON compute_cancel_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCEL_OPERATION'); END;
CREATE TRIGGER compute_attempt_identity BEFORE UPDATE ON compute_attempt
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT') WHERE OLD.finished_at IS NOT NULL
  OR NEW.company_id!=OLD.company_id OR NEW.job_id!=OLD.job_id OR NEW.attempt!=OLD.attempt
  OR NEW.lease_token!=OLD.lease_token OR NEW.started_at!=OLD.started_at;
END;
CREATE TRIGGER compute_attempt_no_delete BEFORE DELETE ON compute_attempt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTEMPT'); END;
