-- Keep existing immutable product operations and calendar FKs intact.
-- Revocations have their own immutable command ledger and share the company
-- revision/audit with existing promotions and all other product mutations.
CREATE TABLE team_admin_revocation (
  company_id TEXT NOT NULL REFERENCES company(id),
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES user(id),
  team_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL REFERENCES user(id),
  expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
  fingerprint TEXT NOT NULL,
  PRIMARY KEY(company_id,id),
  FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id)
);
CREATE TRIGGER team_admin_revocation_guard BEFORE INSERT ON team_admin_revocation
BEGIN
  SELECT RAISE(ABORT,'PRODUCT_FORBIDDEN') WHERE NOT EXISTS (
    SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
  ) OR NOT EXISTS (
    SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id
  );
  SELECT RAISE(ABORT,'PRODUCT_VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision
  );
  SELECT RAISE(ABORT,'PRODUCT_INVALID_REFERENCE') WHERE NOT EXISTS (
    SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id
      AND user_id=NEW.target_user_id AND staff_id IS NOT NULL
  );
END;
CREATE TRIGGER team_admin_revocation_apply AFTER INSERT ON team_admin_revocation
BEGIN
  UPDATE team_member SET role='staff'
    WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.target_user_id;
  UPDATE company SET revision=revision+1 WHERE id=NEW.company_id;
END;
CREATE TRIGGER team_admin_revocation_no_update BEFORE UPDATE ON team_admin_revocation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
CREATE TRIGGER team_admin_revocation_no_delete BEFORE DELETE ON team_admin_revocation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
