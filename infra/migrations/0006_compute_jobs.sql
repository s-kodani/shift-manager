CREATE TABLE compute_job (
  company_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id), snapshot_id TEXT NOT NULL,
  input_revision INTEGER NOT NULL CHECK(input_revision>=0), fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','CANCELLING','SUCCEEDED','NO_SOLUTION','STALE','FAILED','CANCELLED')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
  lease_token TEXT, lease_expires_at INTEGER,
  failure_code TEXT, result_key TEXT, result_sha256 TEXT, result_bytes INTEGER,
  solver_status TEXT, validation_status TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
  FOREIGN KEY(company_id,snapshot_id) REFERENCES input_snapshot(company_id,id),
  CHECK((state IN ('RUNNING','CANCELLING') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (state NOT IN ('RUNNING','CANCELLING') AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK((state IN ('SUCCEEDED','NO_SOLUTION') AND result_key IS NOT NULL AND length(result_sha256)=64 AND result_bytes BETWEEN 1 AND 8000000)
    OR (state NOT IN ('SUCCEEDED','NO_SOLUTION') AND result_key IS NULL AND result_sha256 IS NULL AND result_bytes IS NULL))
);
CREATE UNIQUE INDEX compute_job_one_active_team ON compute_job(company_id,team_id)
 WHERE state IN ('QUEUED','RUNNING','CANCELLING');
CREATE TRIGGER compute_job_accept BEFORE INSERT ON compute_job
BEGIN
  SELECT RAISE(ABORT,'JOB_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
  ) OR NOT (EXISTS (SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
    OR EXISTS (SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
  SELECT RAISE(ABORT,'JOB_VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM input_snapshot s JOIN company c ON c.id=s.company_id
      WHERE s.company_id=NEW.company_id AND s.id=NEW.snapshot_id AND s.team_id=NEW.team_id
        AND s.input_revision=NEW.input_revision AND c.revision=NEW.input_revision
  );
  SELECT RAISE(ABORT,'JOB_INVALID_INITIAL_STATE') WHERE NEW.state!='QUEUED' OR NEW.attempt!=0;
END;
CREATE TRIGGER compute_job_identity BEFORE UPDATE ON compute_job
BEGIN
  SELECT RAISE(ABORT,'IMMUTABLE_JOB_IDENTITY') WHERE NEW.company_id!=OLD.company_id OR NEW.id!=OLD.id
    OR NEW.team_id!=OLD.team_id OR NEW.actor_id!=OLD.actor_id OR NEW.snapshot_id!=OLD.snapshot_id
    OR NEW.input_revision!=OLD.input_revision OR NEW.fingerprint!=OLD.fingerprint OR NEW.created_at!=OLD.created_at;
  SELECT RAISE(ABORT,'JOB_INVALID_TRANSITION') WHERE NOT (
    (OLD.state='QUEUED' AND NEW.state IN ('RUNNING','CANCELLED','STALE','FAILED'))
    OR (OLD.state='RUNNING' AND NEW.state IN ('CANCELLING','SUCCEEDED','NO_SOLUTION','STALE','FAILED','QUEUED','CANCELLED'))
    OR (OLD.state='CANCELLING' AND NEW.state='CANCELLED')
  );
  SELECT RAISE(ABORT,'JOB_INVALID_ATTEMPT') WHERE
    (NEW.state='RUNNING' AND NEW.attempt!=OLD.attempt+1)
    OR (NEW.state!='RUNNING' AND NEW.attempt!=OLD.attempt);
END;
CREATE TRIGGER compute_job_current_result BEFORE UPDATE ON compute_job
 WHEN NEW.state IN ('SUCCEEDED','NO_SOLUTION')
BEGIN
  SELECT RAISE(ABORT,'JOB_VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.input_revision
  );
  SELECT RAISE(ABORT,'JOB_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
  ) OR NOT (EXISTS (SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
    OR EXISTS (SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
END;
CREATE TABLE compute_outbox (
  company_id TEXT NOT NULL, job_id TEXT NOT NULL, next_delivery_at INTEGER NOT NULL,
  deliveries INTEGER NOT NULL DEFAULT 0 CHECK(deliveries>=0), last_sent_at INTEGER,
  PRIMARY KEY(company_id,job_id),
  FOREIGN KEY(company_id,job_id) REFERENCES compute_job(company_id,id)
);
CREATE INDEX compute_outbox_due ON compute_outbox(next_delivery_at);
CREATE TABLE compute_cancel_operation (
  company_id TEXT NOT NULL, id TEXT NOT NULL, job_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id), expected_attempt INTEGER NOT NULL,
  fingerprint TEXT NOT NULL, PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,job_id) REFERENCES compute_job(company_id,id)
);
CREATE TRIGGER compute_cancel_guard BEFORE INSERT ON compute_cancel_operation
BEGIN
  SELECT RAISE(ABORT,'JOB_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state a JOIN compute_job j ON j.company_id=NEW.company_id AND j.id=NEW.job_id
    WHERE a.user_id=NEW.actor_id AND a.enabled=1 AND a.must_change_password=0
      AND (EXISTS (SELECT 1 FROM company_admin WHERE company_id=j.company_id AND user_id=NEW.actor_id)
        OR EXISTS (SELECT 1 FROM team_member WHERE company_id=j.company_id AND team_id=j.team_id AND user_id=NEW.actor_id AND role='team_admin'))
  );
  SELECT RAISE(ABORT,'JOB_ATTEMPT_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM compute_job WHERE company_id=NEW.company_id AND id=NEW.job_id AND attempt=NEW.expected_attempt
      AND state IN ('QUEUED','RUNNING')
  );
END;

CREATE TABLE compute_attempt (
  company_id TEXT NOT NULL, job_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  lease_token TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  final_state TEXT, failure_code TEXT,
  PRIMARY KEY(company_id,job_id,attempt),
  FOREIGN KEY(company_id,job_id) REFERENCES compute_job(company_id,id)
);
CREATE TRIGGER compute_attempt_started AFTER UPDATE ON compute_job WHEN NEW.state='RUNNING'
BEGIN
 INSERT INTO compute_attempt(company_id,job_id,attempt,lease_token,started_at)
 VALUES(NEW.company_id,NEW.id,NEW.attempt,NEW.lease_token,NEW.updated_at);
END;
CREATE TRIGGER compute_attempt_finished AFTER UPDATE ON compute_job
 WHEN OLD.state IN ('RUNNING','CANCELLING') AND NEW.state NOT IN ('RUNNING','CANCELLING')
BEGIN
 UPDATE compute_attempt SET finished_at=NEW.updated_at,final_state=NEW.state,failure_code=NEW.failure_code
 WHERE company_id=NEW.company_id AND job_id=NEW.id AND attempt=NEW.attempt;
END;

-- Dedicated PoC ownership markers. They never contain credentials or contacts.
CREATE TABLE compute_probe (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, team_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL, staff_user_id TEXT NOT NULL,
  results TEXT NOT NULL CHECK(json_valid(results)), expires_at INTEGER NOT NULL,
  cleaned_at INTEGER,
  FOREIGN KEY(company_id,id) REFERENCES compute_job(company_id,id)
);
