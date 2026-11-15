-- Materialized metadata of immutable, digest-checked R2 publication evidence.
-- A seal makes a complete source visible; no business state changes on hydration.
CREATE TABLE published_fixed_source (
 company_id TEXT NOT NULL, publication_id TEXT NOT NULL, document_sha256 TEXT NOT NULL CHECK(length(document_sha256)=64),
 lock_count INTEGER NOT NULL CHECK(lock_count>=0), exception_count INTEGER NOT NULL CHECK(exception_count>=0),
 PRIMARY KEY(company_id,publication_id),
 FOREIGN KEY(company_id,publication_id) REFERENCES schedule_publication_version(company_id,id)
);
CREATE TABLE published_fixed_lock (
 company_id TEXT NOT NULL, publication_id TEXT NOT NULL, id TEXT NOT NULL,staff_id TEXT NOT NULL,date TEXT NOT NULL,
 parts TEXT NOT NULL CHECK(json_valid(parts) AND json_type(parts)='array'),shift TEXT NOT NULL CHECK(json_valid(shift)),
 PRIMARY KEY(company_id,publication_id,id),
 FOREIGN KEY(company_id,publication_id) REFERENCES published_fixed_source(company_id,publication_id)
);
CREATE TABLE published_fixed_exception (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(company_id,publication_id,id),
 FOREIGN KEY(company_id,publication_id) REFERENCES published_fixed_source(company_id,publication_id)
);
CREATE TABLE published_fixed_seal (
 company_id TEXT NOT NULL,publication_id TEXT NOT NULL,PRIMARY KEY(company_id,publication_id),
 FOREIGN KEY(company_id,publication_id) REFERENCES published_fixed_source(company_id,publication_id)
);
CREATE TRIGGER published_fixed_source_guard BEFORE INSERT ON published_fixed_source BEGIN
 SELECT RAISE(ABORT,'PUBLISHED_FIXED_IDENTITY') WHERE NOT EXISTS(
  SELECT 1 FROM schedule_publication_version WHERE company_id=NEW.company_id AND id=NEW.publication_id AND sha256=NEW.document_sha256);
END;
CREATE TRIGGER published_fixed_lock_guard BEFORE INSERT ON published_fixed_lock BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED') WHERE EXISTS(SELECT 1 FROM published_fixed_seal WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id);
 SELECT RAISE(ABORT,'PUBLISHED_FIXED_SCOPE') WHERE NOT EXISTS(SELECT 1 FROM schedule_publication_assignment WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id AND staff_id=NEW.staff_id AND date=NEW.date)
  OR json_array_length(NEW.parts) NOT BETWEEN 1 AND 3
  OR EXISTS(SELECT 1 FROM json_each(NEW.parts) WHERE type!='text' OR value NOT IN ('pattern','time','break'))
  OR (SELECT count(DISTINCT value) FROM json_each(NEW.parts))!=json_array_length(NEW.parts);
END;
CREATE TRIGGER published_fixed_exception_guard BEFORE INSERT ON published_fixed_exception BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED') WHERE EXISTS(SELECT 1 FROM published_fixed_seal WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id);
 SELECT RAISE(ABORT,'PUBLISHED_FIXED_SCOPE') WHERE NEW.id!=json_extract(NEW.payload,'$.id') OR NOT EXISTS(
  SELECT 1 FROM schedule_publication_assignment WHERE company_id=NEW.company_id AND publication_id=NEW.publication_id
   AND staff_id=json_extract(NEW.payload,'$.staffId') AND date=json_extract(NEW.payload,'$.date'));
END;
CREATE TRIGGER published_fixed_seal_guard BEFORE INSERT ON published_fixed_seal BEGIN
 SELECT RAISE(ABORT,'PUBLISHED_FIXED_INCOMPLETE') WHERE NOT EXISTS(
  SELECT 1 FROM published_fixed_source s WHERE s.company_id=NEW.company_id AND s.publication_id=NEW.publication_id
   AND s.lock_count=(SELECT count(*) FROM published_fixed_lock WHERE company_id=s.company_id AND publication_id=s.publication_id)
   AND s.exception_count=(SELECT count(*) FROM published_fixed_exception WHERE company_id=s.company_id AND publication_id=s.publication_id));
END;
CREATE TRIGGER published_fixed_source_update BEFORE UPDATE ON published_fixed_source BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_source_delete BEFORE DELETE ON published_fixed_source BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_lock_update BEFORE UPDATE ON published_fixed_lock BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_lock_delete BEFORE DELETE ON published_fixed_lock BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_exception_update BEFORE UPDATE ON published_fixed_exception BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_exception_delete BEFORE DELETE ON published_fixed_exception BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_seal_update BEFORE UPDATE ON published_fixed_seal BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER published_fixed_seal_delete BEFORE DELETE ON published_fixed_seal BEGIN SELECT RAISE(ABORT,'IMMUTABLE_PUBLISHED_FIXED'); END;
CREATE TRIGGER publication_fixed_complete_guard BEFORE INSERT ON schedule_publication_commit BEGIN
 SELECT RAISE(ABORT,'PUBLISHED_FIXED_INCOMPLETE') WHERE NOT EXISTS(SELECT 1 FROM published_fixed_seal s JOIN published_fixed_source f USING(company_id,publication_id)
  JOIN schedule_publication_version p ON p.company_id=s.company_id AND p.id=s.publication_id
  WHERE s.company_id=NEW.company_id AND s.publication_id=NEW.publication_id AND f.document_sha256=p.sha256);
END;

CREATE TABLE published_fixed_release (
 company_id TEXT NOT NULL,id TEXT NOT NULL,publication_id TEXT NOT NULL,team_id TEXT NOT NULL,staff_id TEXT NOT NULL,date TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES user(id),expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),publication_revision INTEGER NOT NULL CHECK(publication_revision>0),
 parts TEXT NOT NULL CHECK(json_valid(parts) AND json_type(parts)='array'),fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),recorded_at INTEGER NOT NULL,
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,publication_id) REFERENCES published_fixed_seal(company_id,publication_id)
);
CREATE TABLE published_fixed_release_commit (
 company_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,id) REFERENCES published_fixed_release(company_id,id)
);
CREATE INDEX published_fixed_release_scope ON published_fixed_release(company_id,publication_id,staff_id,date,expected_revision);
CREATE TRIGGER published_fixed_release_guard BEFORE INSERT ON published_fixed_release BEGIN
 SELECT RAISE(ABORT,'FIXED_RELEASE_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
  OR NOT (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
   OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'FIXED_RELEASE_VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.expected_revision);
 SELECT RAISE(ABORT,'FIXED_RELEASE_PUBLICATION_CONFLICT') WHERE NOT EXISTS(
  SELECT 1 FROM schedule_publication_head h JOIN schedule_publication_commit c ON c.company_id=h.company_id AND c.publication_id=h.publication_id
   WHERE h.company_id=NEW.company_id AND h.team_id=NEW.team_id AND h.month=substr(NEW.date,1,7) AND h.publication_id=NEW.publication_id AND h.revision=NEW.publication_revision);
 SELECT RAISE(ABORT,'FIXED_RELEASE_PART_NOT_FIXED') WHERE json_array_length(NEW.parts) NOT BETWEEN 1 AND 3
  OR (SELECT count(DISTINCT value) FROM json_each(NEW.parts))!=json_array_length(NEW.parts)
  OR EXISTS(SELECT 1 FROM json_each(NEW.parts) p WHERE p.type!='text' OR p.value NOT IN ('pattern','time','break') OR NOT EXISTS(
   SELECT 1 FROM published_fixed_lock l,json_each(l.parts) q WHERE l.company_id=NEW.company_id AND l.publication_id=NEW.publication_id AND l.staff_id=NEW.staff_id AND l.date=NEW.date AND q.value=p.value
    AND NOT EXISTS(SELECT 1 FROM published_fixed_release r JOIN published_fixed_release_commit c ON c.company_id=r.company_id AND c.id=r.id,json_each(r.parts) z
     WHERE r.company_id=l.company_id AND r.publication_id=l.publication_id AND r.staff_id=l.staff_id AND r.date=l.date AND z.value=p.value)));
END;
CREATE TRIGGER published_fixed_release_commit_guard BEFORE INSERT ON published_fixed_release_commit BEGIN
 SELECT RAISE(ABORT,'FIXED_RELEASE_COMMIT_CONFLICT') WHERE NOT EXISTS(
  SELECT 1 FROM published_fixed_release r JOIN company x ON x.id=r.company_id JOIN access_state a ON a.user_id=r.actor_id
   JOIN schedule_publication_head h ON h.company_id=r.company_id AND h.team_id=r.team_id AND h.month=substr(r.date,1,7)
   JOIN product_audit u ON u.company_id=r.company_id AND u.id=r.id AND u.actor_id=r.actor_id AND u.kind='schedule:fixed-released' AND u.revision=r.expected_revision+1
   WHERE r.company_id=NEW.company_id AND r.id=NEW.id AND x.revision=r.expected_revision AND h.publication_id=r.publication_id AND h.revision=r.publication_revision
   AND a.enabled=1 AND a.must_change_password=0 AND (EXISTS(SELECT 1 FROM company_admin WHERE company_id=r.company_id AND user_id=r.actor_id)
    OR EXISTS(SELECT 1 FROM team_member WHERE company_id=r.company_id AND team_id=r.team_id AND user_id=r.actor_id AND role='team_admin'))
   AND EXISTS(SELECT 1 FROM publication_validation_head WHERE company_id=r.company_id AND team_id=r.team_id AND month=h.month AND publication_id=r.publication_id));
END;
CREATE TRIGGER published_fixed_release_commit_apply AFTER INSERT ON published_fixed_release_commit BEGIN
 UPDATE company SET revision=revision+1 WHERE id=NEW.company_id;
 UPDATE publication_validation_head SET required_revision=(SELECT expected_revision+1 FROM published_fixed_release WHERE company_id=NEW.company_id AND id=NEW.id),validation_id=NULL
  WHERE company_id=NEW.company_id AND publication_id=(SELECT publication_id FROM published_fixed_release WHERE company_id=NEW.company_id AND id=NEW.id);
END;
CREATE TRIGGER published_fixed_release_update BEFORE UPDATE ON published_fixed_release BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FIXED_RELEASE'); END;
CREATE TRIGGER published_fixed_release_delete BEFORE DELETE ON published_fixed_release BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FIXED_RELEASE'); END;
CREATE TRIGGER published_fixed_release_commit_update BEFORE UPDATE ON published_fixed_release_commit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FIXED_RELEASE'); END;
CREATE TRIGGER published_fixed_release_commit_delete BEFORE DELETE ON published_fixed_release_commit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_FIXED_RELEASE'); END;
