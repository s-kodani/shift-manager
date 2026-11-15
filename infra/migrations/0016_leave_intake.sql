-- Intake is separate from approval/cancellation. It changes neither company
-- input revision nor immutable publication facts. Rejection keeps the request.
CREATE TABLE leave_record (
 company_id TEXT NOT NULL REFERENCES company(id), id TEXT NOT NULL,
 team_id TEXT NOT NULL, staff_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES user(id),
 kind TEXT NOT NULL CHECK(kind IN ('LEAVE_REQUEST','ABSENCE_REQUEST','ABSENCE_FACT')),
 date TEXT NOT NULL CHECK(length(date)=10 AND date(date,'+0 days')=date),
 part TEXT NOT NULL CHECK(part IN ('FULL','AM','PM')),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 publication_id TEXT NOT NULL, publication_revision INTEGER NOT NULL CHECK(publication_revision>0),
 calendar_id TEXT NOT NULL, start INTEGER NOT NULL CHECK(start>=0 AND start%30=0),
 end INTEGER NOT NULL CHECK(end>start AND end<=1440 AND end%30=0),
 fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 FOREIGN KEY(company_id,staff_id) REFERENCES staff(company_id,id),
 FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id),
 FOREIGN KEY(company_id,calendar_id) REFERENCES calendar_settings_version(company_id,operation_id)
);
CREATE TABLE leave_head (
 company_id TEXT NOT NULL, request_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('PENDING','REPORTED','REJECTED')),
 decision_id TEXT,
 PRIMARY KEY(company_id,request_id),
 FOREIGN KEY(company_id,request_id) REFERENCES leave_record(company_id,id)
);
CREATE TABLE leave_rejection (
 company_id TEXT NOT NULL, id TEXT NOT NULL, request_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES user(id), expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
 reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 1000),
 fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL CHECK(recorded_at>=0),
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,request_id) REFERENCES leave_record(company_id,id)
);
CREATE TABLE leave_notice (
 company_id TEXT NOT NULL, event_id TEXT NOT NULL, request_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES user(id), kind TEXT NOT NULL CHECK(kind IN ('RECEIVED','REJECTED')),
 recorded_at INTEGER NOT NULL CHECK(recorded_at>=0), read_at INTEGER,
 PRIMARY KEY(company_id,event_id,user_id),
 FOREIGN KEY(company_id,request_id) REFERENCES leave_record(company_id,id)
);
CREATE INDEX leave_month ON leave_record(company_id,team_id,date,recorded_at DESC,id DESC);
CREATE INDEX leave_staff_month ON leave_record(company_id,team_id,staff_id,date,recorded_at DESC,id DESC);
CREATE INDEX leave_inbox ON leave_notice(company_id,user_id,recorded_at DESC,event_id DESC);
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
  SELECT 1 FROM leave_record r JOIN leave_head h ON h.company_id=r.company_id AND h.request_id=r.id
   WHERE r.company_id=NEW.company_id AND r.team_id=NEW.team_id AND r.staff_id=NEW.staff_id AND r.date=NEW.date
   AND ((r.kind='ABSENCE_FACT')=(NEW.kind='ABSENCE_FACT')) AND h.status IN ('PENDING','REPORTED')
   AND r.start<NEW.end AND NEW.start<r.end
 );
END;
CREATE TRIGGER leave_record_apply AFTER INSERT ON leave_record
BEGIN
 INSERT INTO leave_head(company_id,request_id,revision,status) VALUES (NEW.company_id,NEW.id,1,CASE WHEN NEW.kind='ABSENCE_FACT' THEN 'REPORTED' ELSE 'PENDING' END);
 INSERT INTO leave_notice(company_id,event_id,request_id,user_id,kind,recorded_at)
  SELECT NEW.company_id,NEW.id,NEW.id,user_id,'RECEIVED',NEW.recorded_at FROM staff WHERE company_id=NEW.company_id AND id=NEW.staff_id;
END;
CREATE TRIGGER leave_rejection_guard BEFORE INSERT ON leave_rejection
BEGIN
 SELECT RAISE(ABORT,'LEAVE_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM leave_record r JOIN access_state a ON a.user_id=NEW.actor_id
   WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id AND a.enabled=1 AND a.must_change_password=0
    AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=r.company_id AND user_id=NEW.actor_id)
     OR EXISTS(SELECT 1 FROM team_member WHERE company_id=r.company_id AND team_id=r.team_id AND user_id=NEW.actor_id AND role='team_admin'))
 );
 SELECT RAISE(ABORT,'LEAVE_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM leave_head WHERE company_id=NEW.company_id AND request_id=NEW.request_id AND status='PENDING' AND revision=NEW.expected_revision
 );
END;
CREATE TRIGGER leave_rejection_apply AFTER INSERT ON leave_rejection
BEGIN
 UPDATE leave_head SET revision=revision+1,status='REJECTED',decision_id=NEW.id WHERE company_id=NEW.company_id AND request_id=NEW.request_id;
 INSERT INTO leave_notice(company_id,event_id,request_id,user_id,kind,recorded_at)
  SELECT r.company_id,NEW.id,r.id,s.user_id,'REJECTED',NEW.recorded_at FROM leave_record r JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
   WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id;
END;
CREATE TRIGGER leave_head_insert_guard BEFORE INSERT ON leave_head
BEGIN
 SELECT RAISE(ABORT,'INVALID_LEAVE_HEAD') WHERE NEW.revision!=1 OR NEW.decision_id IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM leave_record WHERE company_id=NEW.company_id AND id=NEW.request_id
   AND NEW.status=CASE WHEN kind='ABSENCE_FACT' THEN 'REPORTED' ELSE 'PENDING' END
 );
END;
CREATE TRIGGER leave_head_update_guard BEFORE UPDATE ON leave_head
BEGIN
 SELECT RAISE(ABORT,'INVALID_LEAVE_HEAD') WHERE NEW.company_id!=OLD.company_id OR NEW.request_id!=OLD.request_id
  OR OLD.status!='PENDING' OR NEW.status!='REJECTED' OR NEW.revision!=OLD.revision+1 OR NOT EXISTS (
   SELECT 1 FROM leave_rejection WHERE company_id=OLD.company_id AND request_id=OLD.request_id AND id=NEW.decision_id AND expected_revision=OLD.revision
  );
END;
CREATE TRIGGER leave_notice_insert_guard BEFORE INSERT ON leave_notice
BEGIN
 SELECT RAISE(ABORT,'INVALID_LEAVE_NOTICE') WHERE NOT EXISTS (
  SELECT 1 FROM leave_record r JOIN staff s ON s.company_id=r.company_id AND s.id=r.staff_id
   WHERE r.company_id=NEW.company_id AND r.id=NEW.request_id AND s.user_id=NEW.user_id
    AND ((NEW.kind='RECEIVED' AND NEW.event_id=r.id AND NEW.recorded_at=r.recorded_at)
     OR (NEW.kind='REJECTED' AND EXISTS(SELECT 1 FROM leave_rejection WHERE company_id=r.company_id AND request_id=r.id AND id=NEW.event_id AND recorded_at=NEW.recorded_at)))
 );
END;
CREATE TRIGGER leave_notice_update_guard BEFORE UPDATE ON leave_notice
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_NOTICE') WHERE NEW.company_id!=OLD.company_id OR NEW.event_id!=OLD.event_id
  OR NEW.request_id!=OLD.request_id OR NEW.user_id!=OLD.user_id OR NEW.kind!=OLD.kind OR NEW.recorded_at!=OLD.recorded_at
  OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.read_at<OLD.recorded_at;
END;
CREATE TRIGGER leave_record_no_update BEFORE UPDATE ON leave_record BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_RECORD'); END;
CREATE TRIGGER leave_record_no_delete BEFORE DELETE ON leave_record BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_RECORD'); END;
CREATE TRIGGER leave_head_no_delete BEFORE DELETE ON leave_head BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_HEAD'); END;
CREATE TRIGGER leave_rejection_no_update BEFORE UPDATE ON leave_rejection BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_DECISION'); END;
CREATE TRIGGER leave_rejection_no_delete BEFORE DELETE ON leave_rejection BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_DECISION'); END;
CREATE TRIGGER leave_notice_no_delete BEFORE DELETE ON leave_notice BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LEAVE_NOTICE'); END;
