CREATE TABLE demand_csv_receipt (
  company_id TEXT NOT NULL, operation_id TEXT NOT NULL, team_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, month TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  csv_sha256 TEXT NOT NULL CHECK(length(csv_sha256)=64),
  preview_sha256 TEXT NOT NULL CHECK(length(preview_sha256)=64),
  imported_rows INTEGER NOT NULL CHECK(imported_rows BETWEEN 1 AND 10000),
  rejected_rows INTEGER NOT NULL CHECK(rejected_rows BETWEEN 0 AND 10000),
  added INTEGER NOT NULL CHECK(added>=0), replaced INTEGER NOT NULL CHECK(replaced>=0),
  errors TEXT NOT NULL CHECK(json_valid(errors) AND json_type(errors)='array'),
  CHECK(added+replaced=imported_rows),
  CHECK(json_array_length(errors)=rejected_rows AND imported_rows+rejected_rows<=10000),
  PRIMARY KEY(company_id,operation_id),
  FOREIGN KEY(company_id,operation_id) REFERENCES input_operation(company_id,id),
  FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id)
);
CREATE TRIGGER demand_csv_receipt_guard BEFORE INSERT ON demand_csv_receipt
BEGIN
  SELECT RAISE(ABORT,'CSV_OPERATION_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM input_operation o JOIN work_input_version v
      ON v.company_id=o.company_id AND v.operation_id=o.id
    WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id
      AND o.kind='planning' AND o.team_id=NEW.team_id AND o.actor_id=NEW.actor_id
      AND o.expected_revision+1=NEW.revision AND v.effective_from=NEW.month
      AND v.kind='planning' AND v.entity_id=NEW.team_id AND v.revision=NEW.revision
  );
END;
CREATE TRIGGER demand_csv_receipt_no_update BEFORE UPDATE ON demand_csv_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_RECEIPT'); END;
CREATE TRIGGER demand_csv_receipt_no_delete BEFORE DELETE ON demand_csv_receipt
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_RECEIPT'); END;
