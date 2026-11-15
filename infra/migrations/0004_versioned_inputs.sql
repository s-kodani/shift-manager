CREATE UNIQUE INDEX staff_company_team_id ON staff(company_id,team_id,id);
CREATE TABLE input_operation (
  company_id TEXT NOT NULL REFERENCES company(id), id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id), team_id TEXT, staff_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('company_policy','employment_policy','staff_contract','team_config','planning','staff_month','snapshot')),
  entity_id TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
  FOREIGN KEY(company_id,team_id,staff_id) REFERENCES staff(company_id,team_id,id),
  CHECK((kind IN ('company_policy','employment_policy') AND team_id IS NULL AND staff_id IS NULL)
    OR (kind IN ('staff_contract','staff_month') AND team_id IS NOT NULL AND staff_id IS NOT NULL AND entity_id=staff_id)
    OR (kind IN ('team_config','planning') AND team_id IS NOT NULL AND staff_id IS NULL AND entity_id=team_id)
    OR (kind='snapshot' AND team_id IS NOT NULL AND staff_id IS NULL AND entity_id=id)),
  CHECK(kind!='company_policy' OR entity_id=company_id)
);
CREATE TRIGGER input_operation_guard BEFORE INSERT ON input_operation
BEGIN
  SELECT RAISE(ABORT,'INPUT_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
  ) OR NOT (
    EXISTS (SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
    OR (NEW.kind NOT IN ('company_policy','employment_policy') AND EXISTS (
      SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id
        AND user_id=NEW.actor_id AND role='team_admin'
    ))
  );
  SELECT RAISE(ABORT,'INPUT_VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision
  );
END;
CREATE TRIGGER input_operation_revision AFTER INSERT ON input_operation WHEN NEW.kind!='snapshot'
BEGIN UPDATE company SET revision=revision+1 WHERE id=NEW.company_id; END;
CREATE TRIGGER input_operation_no_update BEFORE UPDATE ON input_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_OPERATION'); END;
CREATE TRIGGER input_operation_no_delete BEFORE DELETE ON input_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_OPERATION'); END;

CREATE TABLE work_input_version (
  company_id TEXT NOT NULL, operation_id TEXT NOT NULL,
  team_id TEXT, staff_id TEXT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '20[0-9][0-9]-[0-9][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12'),
  revision INTEGER NOT NULL CHECK(revision>0), payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(company_id,operation_id),
  FOREIGN KEY(company_id,operation_id) REFERENCES input_operation(company_id,id)
);
CREATE TRIGGER work_input_guard BEFORE INSERT ON work_input_version
BEGIN
  SELECT RAISE(ABORT,'INPUT_OPERATION_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM input_operation WHERE company_id=NEW.company_id AND id=NEW.operation_id
      AND kind=NEW.kind AND entity_id=NEW.entity_id AND team_id IS NEW.team_id AND staff_id IS NEW.staff_id
      AND kind!='snapshot' AND expected_revision+1=NEW.revision
  );
END;
CREATE INDEX work_input_month ON work_input_version(company_id,kind,entity_id,effective_from DESC,revision DESC);
CREATE TRIGGER work_input_no_update BEFORE UPDATE ON work_input_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_VERSION'); END;
CREATE TRIGGER work_input_no_delete BEFORE DELETE ON work_input_version
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_VERSION'); END;

CREATE TABLE input_snapshot (
  company_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL,
  month TEXT NOT NULL, input_revision INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=4000000),
  lineage TEXT NOT NULL CHECK(json_valid(lineage)), created_at INTEGER NOT NULL,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,id) REFERENCES input_operation(company_id,id),
  FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id)
);
CREATE TRIGGER input_snapshot_guard BEFORE INSERT ON input_snapshot
BEGIN
  SELECT RAISE(ABORT,'INPUT_OPERATION_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM input_operation WHERE company_id=NEW.company_id AND id=NEW.id AND kind='snapshot'
      AND team_id=NEW.team_id AND expected_revision=NEW.input_revision
  );
END;
CREATE TRIGGER input_snapshot_no_update BEFORE UPDATE ON input_snapshot
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_SNAPSHOT'); END;
CREATE TRIGGER input_snapshot_no_delete BEFORE DELETE ON input_snapshot
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INPUT_SNAPSHOT'); END;
