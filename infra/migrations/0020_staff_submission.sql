-- Windows are permission metadata, not optimizer input. Their own revision
-- prevents lost updates without making a calculation stale merely by reopening.
CREATE TABLE staff_submission_window (
 company_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL,
 month TEXT NOT NULL CHECK(month GLOB '20[0-9][0-9]-[0-9][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
 actor_id TEXT NOT NULL REFERENCES user(id), expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 closes_at INTEGER, fingerprint TEXT NOT NULL, recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id), UNIQUE(company_id,team_id,month,expected_revision),
 FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 CHECK(closes_at IS NULL OR (closes_at>0 AND closes_at<=8640000000000000))
);
CREATE TRIGGER staff_submission_window_guard BEFORE INSERT ON staff_submission_window
BEGIN
 SELECT RAISE(ABORT,'INPUT_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
 OR NOT (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
 OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'SUBMISSION_WINDOW_CONFLICT') WHERE NEW.expected_revision!=COALESCE((SELECT MAX(expected_revision)+1 FROM staff_submission_window WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month),0);
 SELECT RAISE(ABORT,'SUBMISSION_WINDOW_EXPIRED') WHERE NEW.closes_at IS NOT NULL AND NEW.closes_at<=CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER);
END;
CREATE TRIGGER staff_submission_window_no_update BEFORE UPDATE ON staff_submission_window
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUBMISSION_WINDOW'); END;
CREATE TRIGGER staff_submission_window_no_delete BEFORE DELETE ON staff_submission_window
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SUBMISSION_WINDOW'); END;

ALTER TABLE input_operation ADD COLUMN submission_month TEXT;
ALTER TABLE input_operation ADD COLUMN submission_calendar_id TEXT;
DROP TRIGGER input_operation_guard;
CREATE TRIGGER input_operation_guard BEFORE INSERT ON input_operation
BEGIN
 SELECT RAISE(ABORT,'INPUT_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
 OR NOT COALESCE((
  (NEW.submission_month IS NULL AND NEW.submission_calendar_id IS NULL AND (
   EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
   OR (NEW.kind NOT IN ('company_policy','employment_policy') AND EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'))
  )) OR (NEW.kind='staff_month' AND NEW.submission_month GLOB '20[0-9][0-9]-[0-9][0-9]' AND substr(NEW.submission_month,6,2) BETWEEN '01' AND '12'
   AND NEW.submission_calendar_id IS NOT NULL AND EXISTS(SELECT 1 FROM staff s JOIN team_member m ON m.company_id=s.company_id AND m.team_id=s.team_id AND m.staff_id=s.id AND m.user_id=s.user_id
    WHERE s.company_id=NEW.company_id AND s.team_id=NEW.team_id AND s.id=NEW.staff_id AND s.user_id=NEW.actor_id))
 ),0);
 SELECT RAISE(ABORT,'INPUT_VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision);
 SELECT RAISE(ABORT,'SUBMISSION_CALENDAR_CONFLICT') WHERE NEW.submission_month IS NOT NULL AND NEW.submission_calendar_id IS NOT (
  SELECT operation_id FROM calendar_settings_version WHERE company_id=NEW.company_id AND effective_from<=NEW.submission_month ORDER BY effective_from DESC,revision DESC LIMIT 1
 );
END;
-- Deadline is calculated again from the selected immutable calendar in SQL.
-- API/client clocks and a client-supplied cutoff cannot grant write permission.
CREATE TRIGGER work_input_self_guard BEFORE INSERT ON work_input_version
WHEN EXISTS(SELECT 1 FROM input_operation WHERE company_id=NEW.company_id AND id=NEW.operation_id AND submission_month IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT,'INPUT_OPERATION_MISMATCH') WHERE NOT EXISTS(SELECT 1 FROM input_operation WHERE company_id=NEW.company_id AND id=NEW.operation_id AND kind='staff_month' AND submission_month=NEW.effective_from);
 SELECT RAISE(ABORT,'SUBMISSION_CLOSED') WHERE NOT COALESCE((
  CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)<(
   SELECT (unixepoch(date(NEW.effective_from||'-01','-1 month','+'||min(CAST(json_extract(c.payload,'$.deadlineDay') AS INTEGER),CAST(strftime('%d',date(NEW.effective_from||'-01','-1 day')) AS INTEGER))||' days'))-32400)*1000
   FROM calendar_settings_version c JOIN input_operation o ON o.company_id=c.company_id AND o.submission_calendar_id=c.operation_id
   WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id
  ) OR CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)<(
   SELECT closes_at FROM staff_submission_window WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.effective_from ORDER BY expected_revision DESC LIMIT 1
  )
 ),0);
END;
