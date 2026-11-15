CREATE TABLE schedule_draft_head (
 company_id TEXT NOT NULL, team_id TEXT NOT NULL, month TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), draft_id TEXT,
 PRIMARY KEY(company_id,team_id,month),
 FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 CHECK((revision=0 AND draft_id IS NULL) OR (revision>0 AND draft_id IS NOT NULL))
);
CREATE TABLE schedule_draft_version (
 company_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL, month TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES user(id), source_job_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 input_revision INTEGER NOT NULL CHECK(input_revision>=0),
 expected_draft_revision INTEGER NOT NULL CHECK(expected_draft_revision>=0),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 8000000),
 validation_status TEXT NOT NULL CHECK(validation_status IN ('VERIFIED','HISTORY_UNVERIFIED')),
 recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),
 UNIQUE(company_id,team_id,month,expected_draft_revision),
 FOREIGN KEY(company_id,team_id,month) REFERENCES schedule_draft_head(company_id,team_id,month),
 FOREIGN KEY(company_id,source_job_id) REFERENCES compute_job(company_id,id),
 FOREIGN KEY(company_id,snapshot_id) REFERENCES input_snapshot(company_id,id)
);
CREATE TRIGGER schedule_draft_guard BEFORE INSERT ON schedule_draft_version
BEGIN
 SELECT RAISE(ABORT,'DRAFT_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
 ) OR NOT (EXISTS (SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
  OR EXISTS (SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'DRAFT_INPUT_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM company c JOIN input_snapshot s ON s.company_id=c.id
   JOIN compute_job j ON j.company_id=s.company_id AND j.snapshot_id=s.id
  WHERE c.id=NEW.company_id AND c.revision=NEW.input_revision AND s.id=NEW.snapshot_id
   AND s.team_id=NEW.team_id AND s.month=NEW.month AND s.input_revision=NEW.input_revision
   AND j.id=NEW.source_job_id AND j.team_id=NEW.team_id AND j.input_revision=NEW.input_revision AND j.state='SUCCEEDED'
 );
 SELECT RAISE(ABORT,'DRAFT_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id
   AND month=NEW.month AND revision=NEW.expected_draft_revision
 );
END;
CREATE TRIGGER schedule_draft_head_insert BEFORE INSERT ON schedule_draft_head
BEGIN
 SELECT RAISE(ABORT,'DRAFT_INVALID_HEAD') WHERE NEW.revision!=0 OR NEW.draft_id IS NOT NULL;
END;
CREATE TRIGGER schedule_draft_head_update BEFORE UPDATE ON schedule_draft_head
BEGIN
 SELECT RAISE(ABORT,'DRAFT_INVALID_HEAD') WHERE NEW.company_id!=OLD.company_id OR NEW.team_id!=OLD.team_id
  OR NEW.month!=OLD.month OR NEW.revision!=OLD.revision+1 OR NOT EXISTS (
   SELECT 1 FROM schedule_draft_version WHERE company_id=NEW.company_id AND id=NEW.draft_id
    AND team_id=NEW.team_id AND month=NEW.month AND expected_draft_revision=OLD.revision
  );
END;
CREATE TRIGGER schedule_draft_apply AFTER INSERT ON schedule_draft_version
BEGIN
 UPDATE schedule_draft_head SET draft_id=NEW.id,revision=revision+1
  WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month;
END;
CREATE TRIGGER schedule_draft_no_update BEFORE UPDATE ON schedule_draft_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT'); END;
CREATE TRIGGER schedule_draft_no_delete BEFORE DELETE ON schedule_draft_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT'); END;
CREATE TRIGGER schedule_draft_head_no_delete BEFORE DELETE ON schedule_draft_head
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT_HEAD'); END;
