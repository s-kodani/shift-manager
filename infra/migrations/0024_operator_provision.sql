-- Frozen receipts only; no password/hash, raw request or ongoing staff access.
CREATE TABLE operator_provision_operation (
 id TEXT PRIMARY KEY NOT NULL,
 company_id TEXT NOT NULL UNIQUE REFERENCES company(id),
 user_id TEXT NOT NULL UNIQUE REFERENCES user(id),
 principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 120),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 CHECK(company_id=id)
);
CREATE TRIGGER operator_provision_guard BEFORE INSERT ON operator_provision_operation
BEGIN
 SELECT RAISE(ABORT,'OPERATOR_INVALID_PROVISION') WHERE NOT EXISTS(
  SELECT 1 FROM company c JOIN company_admin a ON a.company_id=c.id
  JOIN access_state s ON s.user_id=a.user_id
  WHERE c.id=NEW.company_id AND c.revision=0 AND a.user_id=NEW.user_id
   AND s.enabled=1 AND s.must_change_password=1
 ) OR (SELECT COUNT(*) FROM company_admin WHERE company_id=NEW.company_id)!=1;
END;
CREATE TRIGGER operator_provision_no_update BEFORE UPDATE ON operator_provision_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
CREATE TRIGGER operator_provision_no_delete BEFORE DELETE ON operator_provision_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
