CREATE TABLE schedule_publication_head (
 company_id TEXT NOT NULL,team_id TEXT NOT NULL,month TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,publication_id TEXT,
 PRIMARY KEY(company_id,team_id,month),FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 CHECK((revision=0 AND publication_id IS NULL) OR (revision>0 AND publication_id IS NOT NULL))
);
CREATE TABLE schedule_publication_version (
 company_id TEXT NOT NULL,id TEXT NOT NULL,team_id TEXT NOT NULL,month TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('job','draft')),source_id TEXT NOT NULL,source_job_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
 input_revision INTEGER NOT NULL,applied_revision INTEGER NOT NULL CHECK(applied_revision=input_revision+1),
 expected_draft_revision INTEGER NOT NULL CHECK(expected_draft_revision>=0),expected_publication_revision INTEGER NOT NULL CHECK(expected_publication_revision>=0),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),object_key TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 8000000),assignment_count INTEGER NOT NULL CHECK(assignment_count BETWEEN 1 AND 15500),
 shortage_acknowledged INTEGER NOT NULL CHECK(shortage_acknowledged IN (0,1)),recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),UNIQUE(company_id,team_id,month,expected_publication_revision),
 FOREIGN KEY(company_id,source_job_id) REFERENCES compute_job(company_id,id),FOREIGN KEY(company_id,snapshot_id) REFERENCES input_snapshot(company_id,id),
 FOREIGN KEY(company_id,team_id,month) REFERENCES schedule_publication_head(company_id,team_id,month)
);
CREATE TABLE schedule_publication_assignment (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,team_id TEXT NOT NULL,staff_id TEXT NOT NULL,date TEXT NOT NULL,
 shift TEXT NOT NULL CHECK(json_valid(shift)),worked_minutes INTEGER NOT NULL CHECK(typeof(worked_minutes)='integer' AND worked_minutes BETWEEN 0 AND 1440),
 staff_number TEXT NOT NULL,staff_name TEXT NOT NULL,
 PRIMARY KEY(company_id,publication_id,staff_id,date),FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id),
 FOREIGN KEY(company_id,team_id,staff_id) REFERENCES staff(company_id,team_id,id)
);
CREATE TABLE schedule_publication_event (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,team_id TEXT NOT NULL,month TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,publication_id),FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id)
);
CREATE TABLE schedule_publication_notice (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,team_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES user(id),read_at INTEGER,
 PRIMARY KEY(company_id,publication_id,user_id),FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_event(company_id,publication_id)
);
CREATE TABLE schedule_publication_commit (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,PRIMARY KEY(company_id,publication_id),
 FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id)
);
CREATE TRIGGER publication_version_guard BEFORE INSERT ON schedule_publication_version
BEGIN
 SELECT RAISE(ABORT,'PUBLICATION_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
  OR NOT (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
   OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'PUBLICATION_INPUT_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.input_revision)
  OR NOT EXISTS(SELECT 1 FROM compute_job j JOIN input_snapshot s ON s.company_id=j.company_id AND s.id=j.snapshot_id
   WHERE j.company_id=NEW.company_id AND j.id=NEW.source_job_id AND j.team_id=NEW.team_id AND j.snapshot_id=NEW.snapshot_id AND j.input_revision=NEW.input_revision
    AND j.state='SUCCEEDED' AND s.month=NEW.month AND s.input_revision=NEW.input_revision);
 SELECT RAISE(ABORT,'PUBLICATION_VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month AND revision=NEW.expected_publication_revision);
 SELECT RAISE(ABORT,'PUBLICATION_DRAFT_CONFLICT') WHERE COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month),0)!=NEW.expected_draft_revision
  OR (NEW.source_kind='draft' AND NOT EXISTS(SELECT 1 FROM schedule_draft_head h JOIN schedule_draft_version d ON d.company_id=h.company_id AND d.id=h.draft_id
   WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month AND h.draft_id=NEW.source_id AND d.source_job_id=NEW.source_job_id AND d.snapshot_id=NEW.snapshot_id AND d.input_revision=NEW.input_revision))
  OR (NEW.source_kind='job' AND (NEW.source_id!=NEW.source_job_id OR EXISTS(SELECT 1 FROM schedule_draft_head h LEFT JOIN input_snapshot_draft r ON r.company_id=h.company_id AND r.snapshot_id=NEW.snapshot_id
   WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month AND h.draft_id IS NOT NULL AND (r.draft_id IS NULL OR r.draft_id!=h.draft_id OR r.draft_revision!=h.revision))));
 SELECT RAISE(ABORT,'PUBLICATION_ASSIGNMENT_COUNT') WHERE NEW.assignment_count!=(SELECT count(*) FROM staff WHERE company_id=NEW.company_id AND team_id=NEW.team_id)*CAST(strftime('%d',date(NEW.month||'-01','+1 month','-1 day')) AS INTEGER);
END;
CREATE TRIGGER publication_assignment_guard BEFORE INSERT ON schedule_publication_assignment
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION') WHERE EXISTS(SELECT 1 FROM schedule_publication_commit WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id);
 SELECT RAISE(ABORT,'PUBLICATION_ASSIGNMENT_SCOPE') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_version p JOIN staff s ON s.company_id=p.company_id AND s.team_id=p.team_id
  WHERE p.company_id=NEW.company_id AND p.id=NEW.publication_id AND p.team_id=NEW.team_id AND s.id=NEW.staff_id AND substr(NEW.date,1,7)=p.month
   AND date(NEW.date,'+0 days')=NEW.date AND NEW.worked_minutes=COALESCE(json_extract(NEW.shift,'$.workedMinutes'),0));
END;
CREATE TRIGGER publication_commit_guard BEFORE INSERT ON schedule_publication_commit
BEGIN
 SELECT RAISE(ABORT,'PUBLICATION_COMMIT_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_version p JOIN company c ON c.id=p.company_id
  JOIN schedule_publication_head h ON h.company_id=p.company_id AND h.team_id=p.team_id AND h.month=p.month
  JOIN access_state a ON a.user_id=p.actor_id
  WHERE p.company_id=NEW.company_id AND p.id=NEW.publication_id AND c.revision=p.input_revision AND h.revision=p.expected_publication_revision
   AND COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=p.company_id AND team_id=p.team_id AND month=p.month),0)=p.expected_draft_revision
   AND a.enabled=1 AND a.must_change_password=0 AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=p.company_id AND user_id=p.actor_id)
    OR EXISTS(SELECT 1 FROM team_member WHERE company_id=p.company_id AND team_id=p.team_id AND user_id=p.actor_id AND role='team_admin'))
   AND EXISTS(SELECT 1 FROM compute_job j WHERE j.company_id=p.company_id AND j.id=p.source_job_id AND j.team_id=p.team_id AND j.snapshot_id=p.snapshot_id AND j.input_revision=p.input_revision AND j.state='SUCCEEDED')
   AND p.assignment_count=(SELECT count(*) FROM schedule_publication_assignment WHERE company_id=p.company_id AND publication_id=p.id)
   AND EXISTS(SELECT 1 FROM product_audit WHERE company_id=p.company_id AND id=p.id AND actor_id=p.actor_id AND kind='schedule:published' AND revision=p.applied_revision)
   AND EXISTS(SELECT 1 FROM schedule_publication_event WHERE company_id=p.company_id AND publication_id=p.id AND team_id=p.team_id AND month=p.month)
   AND NOT EXISTS(SELECT 1 FROM team_member t JOIN access_state x ON x.user_id=t.user_id WHERE t.company_id=p.company_id AND t.team_id=p.team_id AND x.enabled=1
    AND NOT EXISTS(SELECT 1 FROM schedule_publication_notice WHERE company_id=p.company_id AND publication_id=p.id AND user_id=t.user_id)));
END;
CREATE TRIGGER publication_commit_apply AFTER INSERT ON schedule_publication_commit
BEGIN
 UPDATE schedule_publication_head SET publication_id=NEW.publication_id,revision=revision+1 WHERE company_id=NEW.company_id AND team_id=(SELECT team_id FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id) AND month=(SELECT month FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id);
 UPDATE company SET revision=revision+1 WHERE id=NEW.company_id;
END;
CREATE TRIGGER publication_head_insert BEFORE INSERT ON schedule_publication_head
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INVALID_HEAD') WHERE NEW.revision!=0 OR NEW.publication_id IS NOT NULL; END;
CREATE TRIGGER publication_head_update BEFORE UPDATE ON schedule_publication_head
BEGIN SELECT RAISE(ABORT,'PUBLICATION_INVALID_HEAD') WHERE NEW.company_id!=OLD.company_id OR NEW.team_id!=OLD.team_id OR NEW.month!=OLD.month OR NEW.revision!=OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM schedule_publication_commit c JOIN schedule_publication_version p ON p.company_id=c.company_id AND p.id=c.publication_id WHERE c.company_id=NEW.company_id AND c.publication_id=NEW.publication_id AND p.team_id=NEW.team_id AND p.month=NEW.month AND p.expected_publication_revision=OLD.revision); END;
CREATE TRIGGER publication_notice_guard BEFORE INSERT ON schedule_publication_notice
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION') WHERE EXISTS(SELECT 1 FROM schedule_publication_commit WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id);
 SELECT RAISE(ABORT,'PUBLICATION_NOTICE_SCOPE') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_event e JOIN team_member t ON t.company_id=e.company_id AND t.team_id=e.team_id WHERE e.company_id=NEW.company_id AND e.publication_id=NEW.publication_id AND e.team_id=NEW.team_id AND t.user_id=NEW.user_id); END;
CREATE TRIGGER publication_notice_update BEFORE UPDATE ON schedule_publication_notice
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_NOTICE') WHERE NEW.company_id!=OLD.company_id OR NEW.publication_id!=OLD.publication_id OR NEW.team_id!=OLD.team_id OR NEW.user_id!=OLD.user_id OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL; END;
CREATE TRIGGER publication_version_no_update BEFORE UPDATE ON schedule_publication_version BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_version_no_delete BEFORE DELETE ON schedule_publication_version BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_assignment_no_update BEFORE UPDATE ON schedule_publication_assignment BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_assignment_no_delete BEFORE DELETE ON schedule_publication_assignment BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_commit_no_update BEFORE UPDATE ON schedule_publication_commit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_commit_no_delete BEFORE DELETE ON schedule_publication_commit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION'); END;
CREATE TRIGGER publication_head_no_delete BEFORE DELETE ON schedule_publication_head BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION_HEAD'); END;
CREATE TRIGGER publication_event_no_update BEFORE UPDATE ON schedule_publication_event BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION_EVENT'); END;
CREATE TRIGGER publication_event_no_delete BEFORE DELETE ON schedule_publication_event BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION_EVENT'); END;
CREATE TRIGGER publication_notice_no_delete BEFORE DELETE ON schedule_publication_notice BEGIN SELECT RAISE(ABORT,'IMMUTABLE_NOTICE'); END;

CREATE TRIGGER publication_event_guard BEFORE INSERT ON schedule_publication_event BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLICATION') WHERE EXISTS(SELECT 1 FROM schedule_publication_commit WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id); END;
CREATE TRIGGER history_publication_guard BEFORE INSERT ON work_history_version BEGIN SELECT RAISE(ABORT,'PUBLISHED_HISTORY_READ_ONLY') WHERE EXISTS(SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND a.staff_id=NEW.staff_id AND a.date=NEW.date); END;
