-- Q118: scoped validation watermark and durable delivery outbox. No published
-- assignment, break, lock, exception or original certificate is updated here.
CREATE TABLE publication_validation_head (
 company_id TEXT NOT NULL,team_id TEXT NOT NULL,month TEXT NOT NULL,publication_id TEXT NOT NULL,
 required_revision INTEGER NOT NULL,validation_id TEXT,
 PRIMARY KEY(company_id,team_id,month),
 FOREIGN KEY(company_id,team_id,month) REFERENCES schedule_publication_head(company_id,team_id,month),
 FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id)
);
CREATE TABLE publication_revalidation_request (
 company_id TEXT NOT NULL,id TEXT NOT NULL CHECK(length(id)=32),team_id TEXT NOT NULL,month TEXT NOT NULL,publication_id TEXT NOT NULL,
 required_revision INTEGER NOT NULL,reason TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','SUCCEEDED','SUPERSEDED','FAILED')),
 attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0),lease_until INTEGER NOT NULL DEFAULT 0,delivery_due INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000),
 PRIMARY KEY(company_id,id),UNIQUE(company_id,publication_id,required_revision),
 FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id)
);
CREATE INDEX publication_revalidation_delivery ON publication_revalidation_request(state,delivery_due,lease_until);
CREATE TABLE publication_revalidation_source (
 company_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,input_revision INTEGER NOT NULL,
 object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 4000000),
 PRIMARY KEY(company_id,request_id,attempt),FOREIGN KEY(company_id,request_id) REFERENCES publication_revalidation_request(company_id,id)
);
CREATE TABLE publication_revalidation_input (
 company_id TEXT NOT NULL,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,input_revision INTEGER NOT NULL,
 object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 4000000),
 lineage TEXT NOT NULL CHECK(json_valid(lineage)),publication_sha256 TEXT NOT NULL CHECK(length(publication_sha256)=64),
 PRIMARY KEY(company_id,request_id,attempt),FOREIGN KEY(company_id,request_id) REFERENCES publication_revalidation_request(company_id,id)
);
CREATE TABLE publication_revalidation_result (
 company_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,attempt INTEGER NOT NULL,input_revision INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('VERIFIED','HISTORY_UNVERIFIED','INVALID','INPUT_INVALID','FAILED','PROCESS_INTERRUPTED')),
 object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 8000000),
 recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),UNIQUE(company_id,request_id,attempt),
 FOREIGN KEY(company_id,request_id) REFERENCES publication_revalidation_request(company_id,id)
);
CREATE TRIGGER revalidation_input_guard BEFORE INSERT ON publication_revalidation_input BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_ATTEMPT_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE company_id=NEW.company_id AND id=NEW.request_id AND state='RUNNING' AND attempt=NEW.attempt);
END;
CREATE TRIGGER revalidation_source_guard BEFORE INSERT ON publication_revalidation_source BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_ATTEMPT_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE company_id=NEW.company_id AND id=NEW.request_id AND state='RUNNING' AND attempt=NEW.attempt);
END;
CREATE TRIGGER revalidation_result_guard BEFORE INSERT ON publication_revalidation_result BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_ATTEMPT_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM publication_revalidation_request WHERE company_id=NEW.company_id AND id=NEW.request_id AND state='RUNNING' AND attempt=NEW.attempt);
 SELECT RAISE(ABORT,'REVALIDATION_INPUT_MISSING') WHERE NEW.status IN ('VERIFIED','HISTORY_UNVERIFIED','INVALID') AND NOT EXISTS(SELECT 1 FROM publication_revalidation_input WHERE company_id=NEW.company_id AND request_id=NEW.request_id AND attempt=NEW.attempt AND input_revision=NEW.input_revision);
END;
-- The adoption decision uses live SQL state, not an earlier Worker read. A
-- certificate remains immutable even when it loses the input/publication race.
CREATE TRIGGER revalidation_result_apply AFTER INSERT ON publication_revalidation_result BEGIN
 UPDATE publication_validation_head SET validation_id=NEW.id WHERE company_id=NEW.company_id
  AND NEW.status IN ('VERIFIED','HISTORY_UNVERIFIED','INVALID','INPUT_INVALID')
  AND (SELECT revision FROM company WHERE id=NEW.company_id)=NEW.input_revision
  AND EXISTS(SELECT 1 FROM publication_revalidation_request r WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id
   AND r.publication_id=publication_validation_head.publication_id AND r.required_revision=publication_validation_head.required_revision);
 UPDATE publication_revalidation_request SET state=CASE
  WHEN NOT EXISTS(SELECT 1 FROM publication_validation_head h WHERE h.company_id=NEW.company_id AND h.publication_id=publication_revalidation_request.publication_id AND h.required_revision=publication_revalidation_request.required_revision) THEN 'SUPERSEDED'
  WHEN NEW.status IN ('FAILED','PROCESS_INTERRUPTED') THEN CASE WHEN attempt>=3 THEN 'FAILED' ELSE 'PENDING' END
  WHEN (SELECT revision FROM company WHERE id=NEW.company_id)!=NEW.input_revision THEN 'PENDING'
  ELSE 'SUCCEEDED' END,lease_until=0,delivery_due=0 WHERE company_id=NEW.company_id AND id=NEW.request_id;
END;
CREATE TRIGGER revalidation_head_enqueue AFTER UPDATE ON publication_validation_head
 WHEN NEW.publication_id=OLD.publication_id AND NEW.required_revision>OLD.required_revision BEGIN
 INSERT INTO publication_revalidation_request(company_id,id,team_id,month,publication_id,required_revision,reason)
 VALUES(NEW.company_id,lower(hex(randomblob(16))),NEW.team_id,NEW.month,NEW.publication_id,NEW.required_revision,'INPUT_CHANGED');
 UPDATE publication_revalidation_request SET state='SUPERSEDED',lease_until=0 WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id AND required_revision<NEW.required_revision AND state IN ('PENDING','FAILED');
END;
-- Hook head update, rather than another commit AFTER trigger: SQLite does not
-- guarantee ordering among multiple AFTER triggers on the same event.
CREATE TRIGGER revalidation_publication AFTER UPDATE ON schedule_publication_head BEGIN
 INSERT INTO publication_validation_head(company_id,team_id,month,publication_id,required_revision)
 VALUES(NEW.company_id,NEW.team_id,NEW.month,NEW.publication_id,(SELECT applied_revision FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id))
 ON CONFLICT(company_id,team_id,month) DO UPDATE SET publication_id=excluded.publication_id,required_revision=excluded.required_revision,validation_id=NULL;
 UPDATE publication_revalidation_request SET state='SUPERSEDED',lease_until=0 WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month AND publication_id!=NEW.publication_id AND state IN ('PENDING','FAILED');
 UPDATE publication_validation_head SET required_revision=(SELECT applied_revision FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id),validation_id=NULL
 WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month!=NEW.month
 AND date(NEW.month||'-01')<=date(month||'-01','+1 month','-1 day','+31 days')
 AND date(NEW.month||'-01','+1 month','-1 day')>=date(month||'-01','-31 days');
END;
CREATE TRIGGER revalidation_work_input AFTER INSERT ON work_input_version BEGIN
 UPDATE publication_validation_head SET required_revision=NEW.revision,validation_id=NULL WHERE company_id=NEW.company_id
 AND month>=NEW.effective_from AND (NEW.team_id IS NULL OR team_id=NEW.team_id)
 AND (NEW.kind NOT IN ('planning','staff_month') OR month=NEW.effective_from)
 AND NOT EXISTS(SELECT 1 FROM work_input_version v WHERE v.company_id=NEW.company_id AND v.kind=NEW.kind AND v.entity_id=NEW.entity_id AND v.effective_from<=publication_validation_head.month AND (v.effective_from>NEW.effective_from OR (v.effective_from=NEW.effective_from AND v.revision>NEW.revision)))
 AND (NEW.kind!='employment_policy' OR EXISTS(SELECT 1 FROM work_input_version s WHERE s.company_id=NEW.company_id AND s.team_id=publication_validation_head.team_id AND s.kind='staff_contract' AND s.effective_from<=publication_validation_head.month AND json_extract(s.payload,'$.employmentTypeId')=NEW.entity_id
  AND NOT EXISTS(SELECT 1 FROM work_input_version t WHERE t.company_id=s.company_id AND t.kind=s.kind AND t.entity_id=s.entity_id AND t.effective_from<=publication_validation_head.month AND (t.effective_from>s.effective_from OR (t.effective_from=s.effective_from AND t.revision>s.revision)))));
END;
CREATE TRIGGER revalidation_calendar AFTER INSERT ON calendar_settings_version BEGIN
 UPDATE publication_validation_head SET required_revision=NEW.revision,validation_id=NULL WHERE company_id=NEW.company_id AND month>=NEW.effective_from
 AND NOT EXISTS(SELECT 1 FROM calendar_settings_version v WHERE v.company_id=NEW.company_id AND v.effective_from<=publication_validation_head.month AND (v.effective_from>NEW.effective_from OR (v.effective_from=NEW.effective_from AND v.revision>NEW.revision)));
END;
CREATE TRIGGER revalidation_history AFTER INSERT ON work_history_version BEGIN
 UPDATE publication_validation_head SET required_revision=NEW.revision,validation_id=NULL WHERE company_id=NEW.company_id AND team_id=NEW.team_id
 AND NEW.date BETWEEN date(month||'-01','-31 days') AND date(month||'-01','+1 month','-1 day','+31 days') AND substr(NEW.date,1,7)!=month AND required_revision<NEW.revision;
END;
-- Existing versions may have changed before this migration; conservatively
-- check once. Original publication certificates are never retroactively edited.
INSERT INTO publication_validation_head(company_id,team_id,month,publication_id,required_revision)
 SELECT h.company_id,h.team_id,h.month,h.publication_id,c.revision FROM schedule_publication_head h JOIN company c ON c.id=h.company_id WHERE h.publication_id IS NOT NULL;
INSERT INTO publication_revalidation_request(company_id,id,team_id,month,publication_id,required_revision,reason)
 SELECT company_id,lower(hex(randomblob(16))),team_id,month,publication_id,required_revision,'MIGRATION_RECHECK' FROM publication_validation_head;
CREATE TRIGGER revalidation_input_no_update BEFORE UPDATE ON publication_revalidation_input BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_input_no_delete BEFORE DELETE ON publication_revalidation_input BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_result_no_update BEFORE UPDATE ON publication_revalidation_result BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_result_no_delete BEFORE DELETE ON publication_revalidation_result BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_source_no_update BEFORE UPDATE ON publication_revalidation_source BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_source_no_delete BEFORE DELETE ON publication_revalidation_source BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_request_no_delete BEFORE DELETE ON publication_revalidation_request BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION_REQUEST'); END;
CREATE TRIGGER revalidation_request_identity BEFORE UPDATE ON publication_revalidation_request BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION_REQUEST') WHERE NEW.company_id!=OLD.company_id OR NEW.id!=OLD.id OR NEW.team_id!=OLD.team_id OR NEW.month!=OLD.month OR NEW.publication_id!=OLD.publication_id OR NEW.required_revision!=OLD.required_revision OR NEW.reason!=OLD.reason OR NEW.created_at!=OLD.created_at OR NEW.attempt<OLD.attempt OR NEW.attempt>OLD.attempt+1;
END;
CREATE TABLE publication_revalidation_retry (
 company_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),
 expected_revision INTEGER NOT NULL,expected_attempt INTEGER NOT NULL,required_revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,request_id) REFERENCES publication_revalidation_request(company_id,id)
);
CREATE TRIGGER revalidation_retry_guard BEFORE INSERT ON publication_revalidation_retry BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_RETRY_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM publication_revalidation_request r
 JOIN publication_validation_head h ON h.company_id=r.company_id AND h.team_id=r.team_id AND h.month=r.month
 JOIN company c ON c.id=r.company_id JOIN access_state a ON a.user_id=NEW.actor_id
 WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id AND r.state='FAILED' AND r.attempt=NEW.expected_attempt
 AND r.required_revision=NEW.required_revision AND h.required_revision=r.required_revision AND h.publication_id=r.publication_id AND c.revision=NEW.expected_revision
 AND a.enabled=1 AND a.must_change_password=0 AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
 OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=r.team_id AND user_id=NEW.actor_id AND role='team_admin')));
END;
CREATE TRIGGER revalidation_retry_apply AFTER INSERT ON publication_revalidation_retry BEGIN
 UPDATE publication_revalidation_request SET state='PENDING',delivery_due=0,lease_until=0 WHERE company_id=NEW.company_id AND id=NEW.request_id;
END;
CREATE TRIGGER revalidation_retry_no_update BEFORE UPDATE ON publication_revalidation_retry BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_retry_no_delete BEFORE DELETE ON publication_revalidation_retry BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVALIDATION'); END;
CREATE TRIGGER revalidation_head_no_delete BEFORE DELETE ON publication_validation_head BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VALIDATION_HEAD'); END;
CREATE TRIGGER revalidation_head_insert_guard BEFORE INSERT ON publication_validation_head BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_INVALID_HEAD') WHERE NEW.validation_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month AND h.publication_id=NEW.publication_id AND NEW.required_revision>=p.applied_revision);
END;
CREATE TRIGGER revalidation_head_update_guard BEFORE UPDATE ON publication_validation_head BEGIN
 SELECT RAISE(ABORT,'REVALIDATION_INVALID_HEAD') WHERE NEW.company_id!=OLD.company_id OR NEW.team_id!=OLD.team_id OR NEW.month!=OLD.month
 OR (NEW.publication_id=OLD.publication_id AND NEW.required_revision<OLD.required_revision)
 OR (NEW.publication_id=OLD.publication_id AND NEW.required_revision=OLD.required_revision AND OLD.validation_id IS NOT NULL AND NEW.validation_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month AND h.publication_id=NEW.publication_id AND NEW.required_revision>=p.applied_revision);
 SELECT RAISE(ABORT,'REVALIDATION_INVALID_CERTIFICATE') WHERE NEW.validation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM publication_revalidation_result v JOIN publication_revalidation_request r ON r.company_id=v.company_id AND r.id=v.request_id WHERE v.company_id=NEW.company_id AND v.id=NEW.validation_id AND r.publication_id=NEW.publication_id AND r.required_revision=NEW.required_revision AND v.input_revision>=NEW.required_revision AND v.status IN ('VERIFIED','HISTORY_UNVERIFIED','INVALID','INPUT_INVALID'));
END;
