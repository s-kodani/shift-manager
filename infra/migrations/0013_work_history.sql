CREATE TABLE work_history_operation (
 company_id TEXT NOT NULL,id TEXT NOT NULL,team_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),
 expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
 target_month TEXT NOT NULL CHECK(target_month GLOB '20[0-9][0-9]-[0-1][0-9]' AND substr(target_month,6,2) BETWEEN '01' AND '12'),
 fingerprint TEXT NOT NULL,recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id)
);
CREATE TRIGGER work_history_operation_guard BEFORE INSERT ON work_history_operation
BEGIN
 SELECT RAISE(ABORT,'HISTORY_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
 ) OR NOT (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
  OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'HISTORY_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision
 );
END;
CREATE TRIGGER work_history_revision AFTER INSERT ON work_history_operation
BEGIN UPDATE company SET revision=revision+1 WHERE id=NEW.company_id; END;
CREATE TABLE work_history_version (
 company_id TEXT NOT NULL,operation_id TEXT NOT NULL,team_id TEXT NOT NULL,staff_id TEXT NOT NULL,
 date TEXT NOT NULL CHECK(date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND date(date,'+0 days') IS NOT NULL AND date(date,'+0 days')=date),
 worked_minutes INTEGER NOT NULL CHECK(typeof(worked_minutes)='integer' AND worked_minutes BETWEEN 0 AND 1440),
 evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 1000),revision INTEGER NOT NULL,
 PRIMARY KEY(company_id,operation_id,staff_id,date),
 FOREIGN KEY(company_id,operation_id) REFERENCES work_history_operation(company_id,id),
 FOREIGN KEY(company_id,team_id,staff_id) REFERENCES staff(company_id,team_id,id)
);
CREATE TRIGGER work_history_version_guard BEFORE INSERT ON work_history_version
BEGIN
 SELECT RAISE(ABORT,'HISTORY_OPERATION_MISMATCH') WHERE NOT EXISTS (
  SELECT 1 FROM work_history_operation WHERE company_id=NEW.company_id AND id=NEW.operation_id
   AND team_id=NEW.team_id AND expected_revision+1=NEW.revision
   AND NEW.date BETWEEN date(target_month||'-01','-31 days') AND date(target_month||'-01','+1 month','-1 day','+31 days')
   AND substr(NEW.date,1,7)!=target_month
 );
 SELECT RAISE(ABORT,'HISTORY_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM work_history_operation o JOIN access_state a ON a.user_id=o.actor_id
   WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id AND a.enabled=1 AND a.must_change_password=0
   AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=o.company_id AND user_id=o.actor_id)
    OR EXISTS(SELECT 1 FROM team_member WHERE company_id=o.company_id AND team_id=o.team_id AND user_id=o.actor_id AND role='team_admin'))
 );
END;
CREATE INDEX work_history_day ON work_history_version(company_id,team_id,staff_id,date,revision DESC);
CREATE TRIGGER work_history_operation_no_update BEFORE UPDATE ON work_history_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_OPERATION'); END;
CREATE TRIGGER work_history_operation_no_delete BEFORE DELETE ON work_history_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_OPERATION'); END;
CREATE TRIGGER work_history_version_no_update BEFORE UPDATE ON work_history_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_VERSION'); END;
CREATE TRIGGER work_history_version_no_delete BEFORE DELETE ON work_history_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_VERSION'); END;
