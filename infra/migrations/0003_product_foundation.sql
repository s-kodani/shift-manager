-- Product data is separate from the synthetic A0/A1 probe tables.
CREATE TABLE company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE TABLE company_admin (
  company_id TEXT NOT NULL REFERENCES company(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  PRIMARY KEY(company_id, user_id)
);
CREATE TABLE team (
  company_id TEXT NOT NULL REFERENCES company(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  PRIMARY KEY(company_id, id)
);
CREATE TABLE staff (
  company_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  id TEXT NOT NULL,
  staff_number TEXT NOT NULL CHECK(length(staff_number) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  user_id TEXT NOT NULL REFERENCES user(id),
  PRIMARY KEY(company_id, id),
  UNIQUE(company_id, staff_number),
  UNIQUE(company_id, user_id),
  UNIQUE(company_id, team_id, id, user_id),
  FOREIGN KEY(company_id, team_id) REFERENCES team(company_id, id)
);
CREATE TABLE team_member (
  company_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id),
  role TEXT NOT NULL CHECK(role IN ('team_admin','staff')),
  staff_id TEXT,
  PRIMARY KEY(company_id, team_id, user_id),
  CHECK(role != 'staff' OR staff_id IS NOT NULL),
  FOREIGN KEY(company_id, team_id) REFERENCES team(company_id, id),
  FOREIGN KEY(company_id, team_id, staff_id, user_id) REFERENCES staff(company_id, team_id, id, user_id)
);
CREATE INDEX team_member_user ON team_member(user_id, company_id);
CREATE TABLE product_operation (
  company_id TEXT NOT NULL REFERENCES company(id),
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id),
  team_id TEXT,
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('create_team','create_staff','calendar_settings','grant_team_admin')),
  target_user_id TEXT REFERENCES user(id),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(company_id, id),
  FOREIGN KEY(company_id, team_id) REFERENCES team(company_id, id)
);
-- Authorization and optimistic concurrency are checked inside the write batch,
-- including a revocation between the API's read and its write.
CREATE TRIGGER product_operation_guard BEFORE INSERT ON product_operation
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state WHERE user_id = NEW.actor_id
      AND enabled = 1 AND must_change_password = 0
  ) OR NOT (
    EXISTS (SELECT 1 FROM company_admin WHERE company_id = NEW.company_id AND user_id = NEW.actor_id)
    OR (NEW.kind = 'create_staff' AND EXISTS (
      SELECT 1 FROM team_member WHERE company_id = NEW.company_id AND team_id = NEW.team_id
        AND user_id = NEW.actor_id AND role = 'team_admin'
    ))
  );
  SELECT RAISE(ABORT, 'PRODUCT_VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM company WHERE id = NEW.company_id AND revision = NEW.expected_revision
  );
  SELECT RAISE(ABORT, 'PRODUCT_INVALID_REFERENCE') WHERE NEW.kind = 'grant_team_admin' AND NOT EXISTS (
    SELECT 1 FROM team_member WHERE company_id = NEW.company_id AND team_id = NEW.team_id AND user_id = NEW.target_user_id
  );
END;
CREATE TRIGGER product_operation_revision AFTER INSERT ON product_operation
BEGIN
  UPDATE company SET revision = revision + 1 WHERE id = NEW.company_id;
END;
CREATE TRIGGER product_operation_no_update BEFORE UPDATE ON product_operation
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_OPERATION'); END;
CREATE TRIGGER product_operation_no_delete BEFORE DELETE ON product_operation
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_OPERATION'); END;
CREATE TABLE calendar_settings_version (
  company_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  effective_from TEXT NOT NULL CHECK(effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(effective_from,6,2) BETWEEN '01' AND '12'),
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(company_id, operation_id),
  FOREIGN KEY(company_id, operation_id) REFERENCES product_operation(company_id, id)
);
CREATE INDEX calendar_settings_month ON calendar_settings_version(company_id, effective_from DESC, revision DESC);
CREATE TRIGGER calendar_settings_no_update BEFORE UPDATE ON calendar_settings_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SETTINGS_VERSION'); END;
CREATE TRIGGER calendar_settings_no_delete BEFORE DELETE ON calendar_settings_version
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_SETTINGS_VERSION'); END;
CREATE TABLE product_audit (
  company_id TEXT NOT NULL REFERENCES company(id),
  id TEXT NOT NULL,
  actor_id TEXT REFERENCES user(id),
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY(company_id, id)
);
CREATE TRIGGER product_audit_no_update BEFORE UPDATE ON product_audit
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER product_audit_no_delete BEFORE DELETE ON product_audit
BEGIN SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT'); END;
