-- Cancellation is a distinct immutable source. Base publications and plans remain historical.
ALTER TABLE schedule_publication_version ADD COLUMN origin TEXT NOT NULL DEFAULT 'schedule' CHECK(origin IN ('schedule','cancellation'));
CREATE TABLE leave_cancellation_operation (
 company_id TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,team_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),
 parent_publication_id TEXT NOT NULL,parent_sha256 TEXT NOT NULL CHECK(length(parent_sha256)=64),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),applied_revision INTEGER NOT NULL CHECK(applied_revision=expected_revision+1),
 request_revision INTEGER NOT NULL CHECK(request_revision>0),publication_revision INTEGER NOT NULL CHECK(publication_revision>0),
 planning_id TEXT NOT NULL,candidate_sha256 TEXT NOT NULL CHECK(length(candidate_sha256)=64),input_sha256 TEXT NOT NULL CHECK(length(input_sha256)=64),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),removed_count INTEGER NOT NULL CHECK(removed_count>=0),recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
 PRIMARY KEY(company_id,id),UNIQUE(company_id,request_id),
 FOREIGN KEY(company_id,request_id) REFERENCES leave_record(company_id,id),
 FOREIGN KEY(company_id,parent_publication_id) REFERENCES schedule_publication_version(company_id,id),
 FOREIGN KEY(company_id,planning_id) REFERENCES work_input_version(company_id,operation_id)
);
CREATE TABLE planning_participation_removal (
 company_id TEXT NOT NULL,operation_id TEXT NOT NULL,planning_id TEXT NOT NULL,event_id TEXT NOT NULL,staff_id TEXT NOT NULL,date TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,
 PRIMARY KEY(company_id,operation_id,event_id,staff_id),
 FOREIGN KEY(company_id,operation_id) REFERENCES leave_cancellation_operation(company_id,id)
);
CREATE TABLE leave_cancellation_notice (
 company_id TEXT NOT NULL,event_id TEXT NOT NULL,request_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES user(id),
 kind TEXT NOT NULL CHECK(kind IN ('APPROVED','CANCELLATION_CONFIRMED')),recorded_at INTEGER NOT NULL,read_at INTEGER,
 PRIMARY KEY(company_id,event_id,user_id),FOREIGN KEY(company_id,event_id) REFERENCES leave_cancellation_operation(company_id,id)
);
CREATE VIEW leave_effective_head AS
 SELECT h.company_id,h.request_id,h.revision+CASE WHEN x.id IS NULL THEN 0 ELSE 1 END revision,
 CASE WHEN x.id IS NULL THEN h.status WHEN r.kind='ABSENCE_FACT' THEN 'CANCELLATION_CONFIRMED' ELSE 'APPROVED' END status,
 COALESCE(x.id,h.decision_id) decision_id
 FROM leave_head h JOIN leave_record r ON r.company_id=h.company_id AND r.id=h.request_id
 LEFT JOIN (SELECT o.* FROM leave_cancellation_operation o JOIN schedule_publication_commit c ON c.company_id=o.company_id AND c.publication_id=o.id) x
 ON x.company_id=h.company_id AND x.request_id=h.request_id;
CREATE VIEW leave_all_notice AS SELECT * FROM leave_notice UNION ALL SELECT * FROM leave_cancellation_notice;
CREATE TRIGGER cancellation_operation_guard BEFORE INSERT ON leave_cancellation_operation BEGIN
 SELECT RAISE(ABORT,'LEAVE_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
 OR NOT(EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id) OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'LEAVE_VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM leave_effective_head h JOIN leave_record r ON r.company_id=h.company_id AND r.id=h.request_id
 WHERE h.company_id=NEW.company_id AND h.request_id=NEW.request_id AND r.team_id=NEW.team_id AND h.revision=NEW.request_revision AND h.status IN ('PENDING','REPORTED'));
 SELECT RAISE(ABORT,'VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision);
 SELECT RAISE(ABORT,'LEAVE_PUBLICATION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id
 JOIN schedule_publication_version p ON p.company_id=h.company_id AND p.id=h.publication_id JOIN leave_record r ON r.company_id=h.company_id AND r.id=NEW.request_id
 WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=substr(r.date,1,7) AND h.publication_id=NEW.parent_publication_id AND h.revision=NEW.publication_revision AND p.sha256=NEW.parent_sha256);
 SELECT RAISE(ABORT,'LEAVE_FIXED_RELEASE_REQUIRED') WHERE EXISTS(SELECT 1 FROM published_fixed_lock l JOIN json_each(l.parts) part JOIN leave_record r ON r.company_id=l.company_id AND r.id=NEW.request_id
 WHERE l.company_id=NEW.company_id AND l.publication_id=NEW.parent_publication_id AND l.staff_id=r.staff_id AND l.date=r.date
 AND NOT EXISTS(SELECT 1 FROM published_fixed_release x JOIN published_fixed_release_commit c ON c.company_id=x.company_id AND c.id=x.id JOIN json_each(x.parts) xp
 WHERE x.company_id=l.company_id AND x.publication_id=l.publication_id AND x.staff_id=l.staff_id AND x.date=l.date AND xp.value=part.value));
 SELECT RAISE(ABORT,'VERSION_CONFLICT') WHERE NEW.planning_id!=(SELECT operation_id FROM work_input_version WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND kind='planning' AND effective_from=(SELECT substr(date,1,7) FROM leave_record WHERE company_id=NEW.company_id AND id=NEW.request_id) ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER participation_removal_guard BEFORE INSERT ON planning_participation_removal BEGIN
 SELECT RAISE(ABORT,'INVALID_PARTICIPATION_REMOVAL') WHERE NOT EXISTS(
 SELECT 1 FROM leave_cancellation_operation o JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id JOIN work_input_version v ON v.company_id=o.company_id AND v.operation_id=o.planning_id
 JOIN json_each(v.payload,'$.events') e JOIN json_each(e.value,'$.staffIds') s
 WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id AND NEW.planning_id=o.planning_id AND s.value=NEW.staff_id AND NEW.staff_id=r.staff_id
 AND json_extract(e.value,'$.id')=NEW.event_id AND json_extract(e.value,'$.date')=NEW.date AND NEW.date=r.date
 AND json_extract(e.value,'$.start')=NEW.start AND json_extract(e.value,'$.end')=NEW.end AND NEW.start<r.end AND r.start<NEW.end)
 OR EXISTS(SELECT 1 FROM schedule_publication_commit WHERE company_id=NEW.company_id AND publication_id=NEW.operation_id);
END;
CREATE TRIGGER cancellation_version_guard BEFORE INSERT ON schedule_publication_version WHEN NEW.origin='cancellation' BEGIN
 SELECT RAISE(ABORT,'CANCELLATION_PUBLICATION_CONFLICT') WHERE NOT EXISTS(
 SELECT 1 FROM leave_cancellation_operation o JOIN schedule_publication_version p ON p.company_id=o.company_id AND p.id=o.parent_publication_id JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.id AND o.actor_id=NEW.actor_id AND o.team_id=NEW.team_id AND NEW.month=substr(r.date,1,7)
 AND NEW.source_kind=p.source_kind AND NEW.source_id=p.source_id AND NEW.source_job_id=p.source_job_id AND NEW.snapshot_id=p.snapshot_id
 AND NEW.input_revision=o.expected_revision AND NEW.applied_revision=o.applied_revision AND NEW.expected_publication_revision=o.publication_revision
 AND NEW.expected_draft_revision=COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month),0)
 AND NEW.fingerprint=o.fingerprint);
 SELECT RAISE(ABORT,'PUBLICATION_ASSIGNMENT_COUNT') WHERE NEW.assignment_count!=(SELECT count(*) FROM staff WHERE company_id=NEW.company_id AND team_id=NEW.team_id)*CAST(strftime('%d',date(NEW.month||'-01','+1 month','-1 day')) AS INTEGER);
END;
CREATE TRIGGER cancellation_commit_guard BEFORE INSERT ON schedule_publication_commit
 WHEN EXISTS(SELECT 1 FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id AND origin='cancellation') BEGIN
 SELECT RAISE(ABORT,'CANCELLATION_COMMIT_CONFLICT') WHERE NOT EXISTS(
 SELECT 1 FROM leave_cancellation_operation o JOIN schedule_publication_version p ON p.company_id=o.company_id AND p.id=o.id
 JOIN company co ON co.id=o.company_id JOIN schedule_publication_head h ON h.company_id=o.company_id AND h.team_id=o.team_id AND h.month=p.month
 JOIN leave_effective_head l ON l.company_id=o.company_id AND l.request_id=o.request_id JOIN access_state a ON a.user_id=o.actor_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.publication_id AND co.revision=o.expected_revision AND h.publication_id=o.parent_publication_id AND h.revision=o.publication_revision
 AND l.revision=o.request_revision AND l.status IN ('PENDING','REPORTED') AND a.enabled=1 AND a.must_change_password=0
 AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=o.company_id AND user_id=o.actor_id) OR EXISTS(SELECT 1 FROM team_member WHERE company_id=o.company_id AND team_id=o.team_id AND user_id=o.actor_id AND role='team_admin'))
 AND COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=p.company_id AND team_id=p.team_id AND month=p.month),0)=p.expected_draft_revision
 AND p.assignment_count=(SELECT count(*) FROM schedule_publication_assignment WHERE company_id=p.company_id AND publication_id=p.id)
 AND o.removed_count=(SELECT count(*) FROM planning_participation_removal WHERE company_id=o.company_id AND operation_id=o.id)
 AND EXISTS(SELECT 1 FROM product_audit WHERE company_id=p.company_id AND id=p.id AND actor_id=p.actor_id AND kind='schedule:cancelled' AND revision=p.applied_revision)
 AND EXISTS(SELECT 1 FROM schedule_publication_event WHERE company_id=p.company_id AND publication_id=p.id AND team_id=p.team_id AND month=p.month)
 AND NOT EXISTS(SELECT 1 FROM team_member t JOIN access_state x ON x.user_id=t.user_id WHERE t.company_id=p.company_id AND t.team_id=p.team_id AND x.enabled=1
 AND NOT EXISTS(SELECT 1 FROM schedule_publication_notice WHERE company_id=p.company_id AND publication_id=p.id AND user_id=t.user_id)));
 -- The monthly facts must preserve every other staff/day and original times/rest kind.
 SELECT RAISE(ABORT,'CANCELLATION_FACT_CONFLICT') WHERE EXISTS(
 SELECT 1 FROM schedule_publication_assignment n JOIN leave_cancellation_operation o ON o.company_id=n.company_id AND o.id=n.publication_id JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id
 LEFT JOIN schedule_publication_assignment old ON old.company_id=n.company_id AND old.publication_id=o.parent_publication_id AND old.staff_id=n.staff_id AND old.date=n.date
 WHERE n.company_id=NEW.company_id AND n.publication_id=NEW.publication_id AND (old.staff_id IS NULL
 OR ((n.staff_id!=r.staff_id OR n.date!=r.date) AND n.shift!=old.shift)
 OR (n.staff_id=r.staff_id AND n.date=r.date AND (json_type(n.shift)!='object'
 OR json_extract(n.shift,'$.patternId') IS NOT json_extract(old.shift,'$.patternId') OR json_extract(n.shift,'$.start') IS NOT json_extract(old.shift,'$.start') OR json_extract(n.shift,'$.end') IS NOT json_extract(old.shift,'$.end')
 OR json_extract(n.shift,'$.breakKind') IS NOT json_extract(old.shift,'$.breakKind') OR json_extract(n.shift,'$.break') IS NOT json_extract(old.shift,'$.break')))));
 SELECT RAISE(ABORT,'CANCELLATION_FACT_CONFLICT') WHERE EXISTS(
 SELECT 1 FROM schedule_publication_assignment n JOIN leave_cancellation_operation o ON o.company_id=n.company_id AND o.id=n.publication_id
 JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id JOIN schedule_publication_assignment old ON old.company_id=n.company_id AND old.publication_id=o.parent_publication_id AND old.staff_id=n.staff_id AND old.date=n.date
 WHERE n.company_id=NEW.company_id AND n.publication_id=NEW.publication_id AND n.staff_id=r.staff_id AND n.date=r.date AND (
 json_type(n.shift,'$.cancelled') IS NOT 'array'
 OR EXISTS(SELECT 1 FROM json_each(n.shift,'$.cancelled') x WHERE typeof(json_extract(x.value,'$[0]'))!='integer' OR typeof(json_extract(x.value,'$[1]'))!='integer'
 OR json_extract(x.value,'$[0]')<json_extract(old.shift,'$.start') OR json_extract(x.value,'$[1]')>json_extract(old.shift,'$.end') OR json_extract(x.value,'$[0]')>=json_extract(x.value,'$[1]'))
 OR EXISTS(WITH RECURSIVE minute(m) AS (SELECT 0 UNION ALL SELECT m+1 FROM minute WHERE m<1439) SELECT 1 FROM minute
 WHERE (EXISTS(SELECT 1 FROM json_each(n.shift,'$.cancelled') x WHERE m>=json_extract(x.value,'$[0]') AND m<json_extract(x.value,'$[1]')))
 != ((m>=r.start AND m<r.end) OR EXISTS(SELECT 1 FROM json_each(old.shift,'$.cancelled') x WHERE m>=json_extract(x.value,'$[0]') AND m<json_extract(x.value,'$[1]'))))
 OR n.worked_minutes!=(WITH RECURSIVE minute(m) AS (SELECT json_extract(n.shift,'$.start') UNION ALL SELECT m+1 FROM minute WHERE m+1<json_extract(n.shift,'$.end'))
 SELECT count(*) FROM minute WHERE NOT EXISTS(SELECT 1 FROM json_each(n.shift,'$.cancelled') x WHERE m>=json_extract(x.value,'$[0]') AND m<json_extract(x.value,'$[1]'))
 AND (json_type(n.shift,'$.break')='null' OR m<json_extract(n.shift,'$.break[0]') OR m>=json_extract(n.shift,'$.break[1]')))));
 -- Every effective overlapping participation must be removed exactly once.
 SELECT RAISE(ABORT,'INVALID_PARTICIPATION_REMOVAL') WHERE EXISTS(SELECT 1 FROM leave_cancellation_operation o JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id JOIN work_input_version v ON v.company_id=o.company_id AND v.operation_id=o.planning_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.publication_id AND o.removed_count!=(SELECT count(*) FROM json_each(v.payload,'$.events') e
 WHERE json_extract(e.value,'$.date')=r.date AND json_extract(e.value,'$.start')<r.end AND r.start<json_extract(e.value,'$.end') AND EXISTS(SELECT 1 FROM json_each(e.value,'$.staffIds') s WHERE s.value=r.staff_id)
 AND NOT EXISTS(SELECT 1 FROM planning_participation_removal prior JOIN schedule_publication_commit c ON c.company_id=prior.company_id AND c.publication_id=prior.operation_id
 WHERE prior.company_id=o.company_id AND prior.planning_id=o.planning_id AND prior.event_id=json_extract(e.value,'$.id') AND prior.staff_id=r.staff_id)));
END;
CREATE TRIGGER cancellation_notice_apply AFTER INSERT ON schedule_publication_commit
 WHEN EXISTS(SELECT 1 FROM leave_cancellation_operation WHERE company_id=NEW.company_id AND id=NEW.publication_id) BEGIN
 INSERT INTO leave_cancellation_notice(company_id,event_id,request_id,user_id,kind,recorded_at)
 SELECT o.company_id,o.id,r.id,s.user_id,CASE WHEN r.kind='ABSENCE_FACT' THEN 'CANCELLATION_CONFIRMED' ELSE 'APPROVED' END,o.recorded_at
 FROM leave_cancellation_operation o JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.publication_id;
END;
CREATE TRIGGER cancellation_notice_guard BEFORE INSERT ON leave_cancellation_notice BEGIN
 SELECT RAISE(ABORT,'INVALID_LEAVE_NOTICE') WHERE NOT EXISTS(SELECT 1 FROM leave_cancellation_operation o JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id
 JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id JOIN schedule_publication_commit c ON c.company_id=o.company_id AND c.publication_id=o.id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.event_id AND r.id=NEW.request_id AND s.user_id=NEW.user_id AND NEW.recorded_at=o.recorded_at
 AND NEW.kind=CASE WHEN r.kind='ABSENCE_FACT' THEN 'CANCELLATION_CONFIRMED' ELSE 'APPROVED' END);
END;
CREATE TRIGGER cancellation_notice_update BEFORE UPDATE ON leave_cancellation_notice BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_NOTICE') WHERE NEW.company_id!=OLD.company_id OR NEW.event_id!=OLD.event_id OR NEW.request_id!=OLD.request_id OR NEW.user_id!=OLD.user_id OR NEW.kind!=OLD.kind OR NEW.recorded_at!=OLD.recorded_at OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.read_at<OLD.recorded_at;
END;

DROP TRIGGER publication_version_guard;
CREATE TRIGGER publication_version_guard BEFORE INSERT ON schedule_publication_version WHEN NEW.origin='schedule'
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
DROP TRIGGER publication_commit_guard;
CREATE TRIGGER publication_commit_guard BEFORE INSERT ON schedule_publication_commit WHEN EXISTS(SELECT 1 FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id AND origin='schedule')
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
DROP TRIGGER leave_rejection_guard;
CREATE TRIGGER leave_rejection_guard BEFORE INSERT ON leave_rejection
BEGIN
 SELECT RAISE(ABORT,'LEAVE_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM leave_record r JOIN access_state a ON a.user_id=NEW.actor_id
   WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id AND a.enabled=1 AND a.must_change_password=0
    AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=r.company_id AND user_id=NEW.actor_id)
     OR EXISTS(SELECT 1 FROM team_member WHERE company_id=r.company_id AND team_id=r.team_id AND user_id=NEW.actor_id AND role='team_admin'))
 );
 SELECT RAISE(ABORT,'LEAVE_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM leave_effective_head WHERE company_id=NEW.company_id AND request_id=NEW.request_id AND status='PENDING' AND revision=NEW.expected_revision
 );
END;
DROP TRIGGER leave_record_guard;
CREATE TRIGGER leave_record_guard BEFORE INSERT ON leave_record
BEGIN
 SELECT RAISE(ABORT,'LEAVE_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
 ) OR NOT EXISTS (
  SELECT 1 FROM staff s WHERE s.company_id=NEW.company_id AND s.team_id=NEW.team_id AND s.id=NEW.staff_id
  AND EXISTS(SELECT 1 FROM team_member WHERE company_id=s.company_id AND team_id=s.team_id AND staff_id=s.id AND user_id=s.user_id)
  AND ( (NEW.kind!='ABSENCE_FACT' AND s.user_id=NEW.actor_id)
   OR (NEW.kind='ABSENCE_FACT' AND (
    EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
    OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin')
   )))
 );
 SELECT RAISE(ABORT,'LEAVE_FUTURE_FACT') WHERE NEW.kind='ABSENCE_FACT' AND NEW.date>date('now','+9 hours');
 SELECT RAISE(ABORT,'LEAVE_PUBLICATION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id
  JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id
  WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=substr(NEW.date,1,7)
   AND h.publication_id=NEW.publication_id AND h.revision=NEW.publication_revision
   AND a.staff_id=NEW.staff_id AND a.date=NEW.date AND a.worked_minutes>0
 );
 SELECT RAISE(ABORT,'LEAVE_CALENDAR_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM calendar_settings_version WHERE company_id=NEW.company_id AND operation_id=NEW.calendar_id
   AND operation_id=(SELECT operation_id FROM calendar_settings_version WHERE company_id=NEW.company_id
    AND effective_from<=substr(NEW.date,1,7) ORDER BY effective_from DESC,revision DESC LIMIT 1)
 );
 SELECT RAISE(ABORT,'LEAVE_EMPTY_WORK') WHERE NOT EXISTS (
  SELECT 1 FROM schedule_publication_assignment a JOIN calendar_settings_version v ON v.company_id=a.company_id AND v.operation_id=NEW.calendar_id
  WHERE a.company_id=NEW.company_id AND a.publication_id=NEW.publication_id AND a.staff_id=NEW.staff_id AND a.date=NEW.date
   AND NEW.start=max(json_extract(a.shift,'$.start'),CASE WHEN NEW.part='PM' THEN json_extract(v.payload,'$.halfDayDivider') ELSE json_extract(a.shift,'$.start') END)
   AND NEW.end=min(json_extract(a.shift,'$.end'),CASE WHEN NEW.part='AM' THEN json_extract(v.payload,'$.halfDayDivider') ELSE json_extract(a.shift,'$.end') END)
   AND EXISTS (
    WITH RECURSIVE minute(n) AS (SELECT NEW.start UNION ALL SELECT n+1 FROM minute WHERE n+1<NEW.end)
    SELECT 1 FROM minute WHERE (json_type(a.shift,'$.break')='null' OR n<json_extract(a.shift,'$.break[0]') OR n>=json_extract(a.shift,'$.break[1]'))
     AND NOT EXISTS(SELECT 1 FROM json_each(a.shift,'$.cancelled') x WHERE n>=json_extract(x.value,'$[0]') AND n<json_extract(x.value,'$[1]'))
   )
 );
 SELECT RAISE(ABORT,'LEAVE_OVERLAP') WHERE EXISTS (
  SELECT 1 FROM leave_record r JOIN leave_effective_head h ON h.company_id=r.company_id AND h.request_id=r.id
   WHERE r.company_id=NEW.company_id AND r.team_id=NEW.team_id AND r.staff_id=NEW.staff_id AND r.date=NEW.date
   AND ((r.kind='ABSENCE_FACT')=(NEW.kind='ABSENCE_FACT')) AND h.status IN ('PENDING','REPORTED')
   AND r.start<NEW.end AND NEW.start<r.end
 );
END;
CREATE TRIGGER leave_cancellation_operation_no_delete BEFORE DELETE ON leave_cancellation_operation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCELLATION'); END;
CREATE TRIGGER leave_cancellation_operation_no_update BEFORE UPDATE ON leave_cancellation_operation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCELLATION'); END;
CREATE TRIGGER planning_participation_removal_no_delete BEFORE DELETE ON planning_participation_removal BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCELLATION'); END;
CREATE TRIGGER planning_participation_removal_no_update BEFORE UPDATE ON planning_participation_removal BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCELLATION'); END;
CREATE TRIGGER leave_cancellation_notice_no_delete BEFORE DELETE ON leave_cancellation_notice BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CANCELLATION'); END;
