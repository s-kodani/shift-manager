-- Soft deletion retains company-unique staff numbers and immutable history.
ALTER TABLE staff ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
 CHECK(status IN ('active','inactive','deleted'));

CREATE TABLE staff_lifecycle_operation (
 company_id TEXT NOT NULL REFERENCES company(id),
 id TEXT NOT NULL,
 team_id TEXT NOT NULL,
 staff_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES user(id),
 status TEXT NOT NULL CHECK(status IN ('active','inactive','deleted')),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),
 fingerprint TEXT NOT NULL,
 PRIMARY KEY(company_id,id),
 FOREIGN KEY(company_id,team_id,staff_id) REFERENCES staff(company_id,team_id,id)
);
CREATE TRIGGER staff_lifecycle_guard BEFORE INSERT ON staff_lifecycle_operation
BEGIN
 SELECT RAISE(ABORT,'PRODUCT_FORBIDDEN') WHERE NOT EXISTS (
  SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0
 ) OR NOT (
  EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
  OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin')
 );
 SELECT RAISE(ABORT,'PRODUCT_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision
 );
 SELECT RAISE(ABORT,'PRODUCT_INVALID_REFERENCE') WHERE NOT EXISTS (
  SELECT 1 FROM staff WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND id=NEW.staff_id AND status!='deleted'
 );
 SELECT RAISE(ABORT,'STAFF_STATUS_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM staff WHERE company_id=NEW.company_id AND id=NEW.staff_id AND status=NEW.status
 );
 -- Account access is global: never stop oneself, a company administrator or
 -- an account with memberships outside the managed team.
 SELECT RAISE(ABORT,'STAFF_ACCOUNT_PROTECTED') WHERE EXISTS (
  SELECT 1 FROM staff s WHERE s.company_id=NEW.company_id AND s.id=NEW.staff_id AND (
   s.user_id=NEW.actor_id OR EXISTS(SELECT 1 FROM company_admin a WHERE a.user_id=s.user_id)
   OR EXISTS(SELECT 1 FROM team_member m WHERE m.user_id=s.user_id AND (m.company_id!=NEW.company_id OR m.team_id!=NEW.team_id))
  )
 );
 SELECT RAISE(ABORT,'OPERATION_ID_CONFLICT') WHERE
  EXISTS(SELECT 1 FROM product_operation WHERE company_id=NEW.company_id AND id=NEW.id)
  OR EXISTS(SELECT 1 FROM team_admin_revocation WHERE company_id=NEW.company_id AND id=NEW.id);
END;
CREATE TRIGGER staff_lifecycle_apply AFTER INSERT ON staff_lifecycle_operation
BEGIN
 UPDATE staff SET status=NEW.status WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND id=NEW.staff_id;
 UPDATE access_state SET enabled=CASE WHEN NEW.status='active' THEN 1 ELSE 0 END
 WHERE user_id=(SELECT user_id FROM staff WHERE company_id=NEW.company_id AND id=NEW.staff_id);
 UPDATE user SET banned=CASE WHEN NEW.status='active' THEN 0 ELSE 1 END
 WHERE id=(SELECT user_id FROM staff WHERE company_id=NEW.company_id AND id=NEW.staff_id);
 DELETE FROM session WHERE NEW.status!='active' AND userId=(SELECT user_id FROM staff WHERE company_id=NEW.company_id AND id=NEW.staff_id);
 UPDATE company SET revision=revision+1 WHERE id=NEW.company_id;
END;
CREATE TRIGGER staff_lifecycle_no_update BEFORE UPDATE ON staff_lifecycle_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;
CREATE TRIGGER staff_lifecycle_no_delete BEFORE DELETE ON staff_lifecycle_operation
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OPERATION'); END;

-- Match the effective calculation roster while retaining published staff.
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
 SELECT RAISE(ABORT,'PUBLICATION_ASSIGNMENT_COUNT') WHERE NEW.assignment_count!=(SELECT count(*) FROM staff s WHERE s.company_id=NEW.company_id AND s.team_id=NEW.team_id AND (s.status='active' OR EXISTS(
  SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_assignment a ON a.company_id=h.company_id AND a.publication_id=h.publication_id
  WHERE h.company_id=s.company_id AND h.team_id=s.team_id AND h.month=NEW.month AND a.staff_id=s.id)))*CAST(strftime('%d',date(NEW.month||'-01','+1 month','-1 day')) AS INTEGER);
END;

-- Cancellations always preserve the parent publication roster.
DROP TRIGGER cancellation_version_guard;
CREATE TRIGGER cancellation_version_guard BEFORE INSERT ON schedule_publication_version WHEN NEW.origin='cancellation' BEGIN
 SELECT RAISE(ABORT,'CANCELLATION_PUBLICATION_CONFLICT') WHERE NOT EXISTS(
 SELECT 1 FROM leave_cancellation_operation o JOIN schedule_publication_version p ON p.company_id=o.company_id AND p.id=o.parent_publication_id JOIN leave_record r ON r.company_id=o.company_id AND r.id=o.request_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.id AND o.actor_id=NEW.actor_id AND o.team_id=NEW.team_id AND NEW.month=substr(r.date,1,7)
 AND NEW.source_kind=p.source_kind AND NEW.source_id=p.source_id AND NEW.source_job_id=p.source_job_id AND NEW.snapshot_id=p.snapshot_id
 AND NEW.input_revision=o.expected_revision AND NEW.applied_revision=o.applied_revision AND NEW.expected_publication_revision=o.publication_revision
 AND NEW.expected_draft_revision=COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month),0)
 AND NEW.fingerprint=o.fingerprint);
 SELECT RAISE(ABORT,'PUBLICATION_ASSIGNMENT_COUNT') WHERE NEW.assignment_count!=(SELECT p.assignment_count FROM leave_cancellation_operation o JOIN schedule_publication_version p ON p.company_id=o.company_id AND p.id=o.parent_publication_id WHERE o.company_id=NEW.company_id AND o.id=NEW.id);
END;
