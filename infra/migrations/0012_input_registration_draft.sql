CREATE TABLE input_registration_draft (
 company_id TEXT NOT NULL,operation_id TEXT NOT NULL,team_id TEXT NOT NULL,month TEXT NOT NULL,
 draft_id TEXT,draft_revision INTEGER NOT NULL,
 PRIMARY KEY(company_id,operation_id),
 FOREIGN KEY(company_id,operation_id) REFERENCES input_operation(company_id,id),
 FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 FOREIGN KEY(company_id,draft_id) REFERENCES schedule_draft_version(company_id,id),
 CHECK((draft_id IS NULL AND draft_revision=0) OR (draft_id IS NOT NULL AND draft_revision>0))
);
CREATE TRIGGER input_registration_draft_guard BEFORE INSERT ON input_registration_draft
BEGIN
 SELECT RAISE(ABORT,'INPUT_DRAFT_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM input_operation i JOIN work_input_version v ON v.company_id=i.company_id AND v.operation_id=i.id
   LEFT JOIN schedule_draft_head h ON h.company_id=i.company_id AND h.team_id=i.team_id AND h.month=v.effective_from
  WHERE i.company_id=NEW.company_id AND i.id=NEW.operation_id AND i.team_id=NEW.team_id
   AND i.kind IN ('planning','staff_month') AND v.effective_from=NEW.month
   AND h.draft_id IS NEW.draft_id AND COALESCE(h.revision,0)=NEW.draft_revision
 );
END;
CREATE TRIGGER input_registration_draft_no_update BEFORE UPDATE ON input_registration_draft
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_DRAFT_SOURCE'); END;
CREATE TRIGGER input_registration_draft_no_delete BEFORE DELETE ON input_registration_draft
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_DRAFT_SOURCE'); END;
