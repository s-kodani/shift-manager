CREATE TABLE input_snapshot_draft (
 company_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,draft_id TEXT NOT NULL,
 draft_revision INTEGER NOT NULL CHECK(draft_revision>0),
 PRIMARY KEY(company_id,snapshot_id),
 FOREIGN KEY(company_id,snapshot_id) REFERENCES input_snapshot(company_id,id),
 FOREIGN KEY(company_id,draft_id) REFERENCES schedule_draft_version(company_id,id)
);
CREATE TRIGGER input_snapshot_require_draft BEFORE INSERT ON input_snapshot
WHEN EXISTS (SELECT 1 FROM schedule_draft_head h WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month AND h.draft_id IS NOT NULL)
BEGIN
 SELECT RAISE(ABORT,'INPUT_DRAFT_SOURCE_REQUIRED') WHERE NOT EXISTS (
  SELECT 1 FROM json_each(NEW.lineage) e WHERE json_extract(e.value,'$.kind')='manual_draft'
 );
 SELECT RAISE(ABORT,'INPUT_DRAFT_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM json_each(NEW.lineage) e JOIN schedule_draft_head h
   ON h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=NEW.month
  WHERE json_extract(e.value,'$.kind')='manual_draft' AND json_extract(e.value,'$.version')=h.draft_id
   AND json_extract(e.value,'$.revision')=h.revision
 );
END;
CREATE TRIGGER input_snapshot_draft_guard BEFORE INSERT ON input_snapshot_draft
BEGIN
 SELECT RAISE(ABORT,'INPUT_DRAFT_VERSION_CONFLICT') WHERE NOT EXISTS (
  SELECT 1 FROM input_snapshot s JOIN schedule_draft_version d ON d.company_id=s.company_id AND d.team_id=s.team_id AND d.month=s.month
   JOIN schedule_draft_head h ON h.company_id=d.company_id AND h.team_id=d.team_id AND h.month=d.month
  WHERE s.company_id=NEW.company_id AND s.id=NEW.snapshot_id AND d.id=NEW.draft_id
   AND d.expected_draft_revision+1=NEW.draft_revision AND h.draft_id=d.id AND h.revision=NEW.draft_revision
 );
END;
CREATE TRIGGER input_snapshot_draft_no_update BEFORE UPDATE ON input_snapshot_draft
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT_SOURCE'); END;
CREATE TRIGGER input_snapshot_draft_no_delete BEFORE DELETE ON input_snapshot_draft
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_DRAFT_SOURCE'); END;
CREATE TRIGGER compute_job_draft_accept BEFORE INSERT ON compute_job
BEGIN
 SELECT RAISE(ABORT,'JOB_DRAFT_VERSION_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM input_snapshot s JOIN schedule_draft_head h ON h.company_id=s.company_id AND h.team_id=s.team_id AND h.month=s.month
   LEFT JOIN input_snapshot_draft r ON r.company_id=s.company_id AND r.snapshot_id=s.id
  WHERE s.company_id=NEW.company_id AND s.id=NEW.snapshot_id AND h.draft_id IS NOT NULL
   AND (r.draft_id IS NULL OR h.draft_id!=r.draft_id OR h.revision!=r.draft_revision)
 );
END;
CREATE TRIGGER compute_job_draft_result BEFORE UPDATE ON compute_job WHEN NEW.state IN ('SUCCEEDED','NO_SOLUTION')
BEGIN
 SELECT RAISE(ABORT,'JOB_DRAFT_VERSION_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM input_snapshot s JOIN schedule_draft_head h ON h.company_id=s.company_id AND h.team_id=s.team_id AND h.month=s.month
   LEFT JOIN input_snapshot_draft r ON r.company_id=s.company_id AND r.snapshot_id=s.id
  WHERE s.company_id=NEW.company_id AND s.id=NEW.snapshot_id AND h.draft_id IS NOT NULL
   AND (r.draft_id IS NULL OR h.draft_id!=r.draft_id OR h.revision!=r.draft_revision)
 );
END;
