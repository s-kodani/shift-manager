-- AI metadata is separate from shift input/version/state. UTC daily admission
-- limits count failed and uncertain requests too, before inference starts.
CREATE TABLE schedule_explanation (
 company_id TEXT NOT NULL, id TEXT NOT NULL, team_id TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES user(id),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('job','draft')), source_id TEXT NOT NULL,
 input_revision INTEGER NOT NULL, grounds_digest TEXT NOT NULL CHECK(length(grounds_digest)=64),
 cache_key TEXT NOT NULL CHECK(length(cache_key)=64), fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
 model TEXT NOT NULL, prompt_version TEXT NOT NULL,
 month TEXT NOT NULL, head_id TEXT, head_revision INTEGER NOT NULL, source_digest TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','SUCCEEDED','FAILED')),
 created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)*1000),
 summary TEXT, fact_ids TEXT, reason TEXT, generated_at INTEGER,
 PRIMARY KEY(company_id,id), FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id),
 CHECK((state='PENDING' AND summary IS NULL AND fact_ids IS NULL AND reason IS NULL AND generated_at IS NULL)
  OR (state='SUCCEEDED' AND summary IS NOT NULL AND fact_ids IS NOT NULL AND reason IS NULL AND generated_at IS NOT NULL)
  OR (state='FAILED' AND summary IS NULL AND fact_ids IS NULL AND reason IS NOT NULL AND generated_at IS NOT NULL))
);
CREATE UNIQUE INDEX schedule_explanation_live ON schedule_explanation(company_id,team_id,cache_key) WHERE state IN ('PENDING','SUCCEEDED');
CREATE INDEX schedule_explanation_budget ON schedule_explanation(company_id,created_at);
CREATE TRIGGER schedule_explanation_admit BEFORE INSERT ON schedule_explanation
BEGIN
 SELECT RAISE(ABORT,'EXPLANATION_INVALID_ADMISSION') WHERE NEW.state!='PENDING' OR NEW.created_at!=CAST(strftime('%s','now') AS INTEGER)*1000;
 SELECT RAISE(ABORT,'EXPLANATION_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state WHERE user_id=NEW.actor_id AND enabled=1 AND must_change_password=0)
 OR NOT (EXISTS(SELECT 1 FROM company_admin WHERE company_id=NEW.company_id AND user_id=NEW.actor_id)
  OR EXISTS(SELECT 1 FROM team_member WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND user_id=NEW.actor_id AND role='team_admin'));
 SELECT RAISE(ABORT,'EXPLANATION_STALE') WHERE NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND revision=NEW.input_revision);
 SELECT RAISE(ABORT,'EXPLANATION_STALE') WHERE NEW.head_id IS NOT (SELECT draft_id FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month)
 OR NEW.head_revision!=COALESCE((SELECT revision FROM schedule_draft_head WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND month=NEW.month),0);
 SELECT RAISE(ABORT,'EXPLANATION_STALE') WHERE NOT (
  (NEW.source_kind='job' AND EXISTS(SELECT 1 FROM compute_job j JOIN input_snapshot s ON s.company_id=j.company_id AND s.id=j.snapshot_id WHERE j.company_id=NEW.company_id AND j.team_id=NEW.team_id AND j.id=NEW.source_id AND j.result_sha256=NEW.source_digest AND s.month=NEW.month AND j.input_revision=NEW.input_revision AND j.state IN ('SUCCEEDED','NO_SOLUTION')))
  OR (NEW.source_kind='draft' AND NEW.source_id=NEW.head_id AND EXISTS(SELECT 1 FROM schedule_draft_version WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND id=NEW.source_id AND sha256=NEW.source_digest AND month=NEW.month AND input_revision=NEW.input_revision))
 );
 SELECT RAISE(ABORT,'EXPLANATION_LIMIT') WHERE (SELECT count(*) FROM schedule_explanation WHERE company_id=NEW.company_id AND created_at>=CAST(strftime('%s','now','start of day') AS INTEGER)*1000)>=20;
 SELECT RAISE(ABORT,'EXPLANATION_BUSY') WHERE EXISTS(SELECT 1 FROM schedule_explanation WHERE company_id=NEW.company_id AND team_id=NEW.team_id AND state='PENDING' AND created_at>CAST(strftime('%s','now') AS INTEGER)*1000-30000);
END;
CREATE TRIGGER schedule_explanation_terminal BEFORE UPDATE ON schedule_explanation
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_EXPLANATION') WHERE OLD.state!='PENDING' OR NEW.state='PENDING'
  OR NEW.company_id!=OLD.company_id OR NEW.id!=OLD.id OR NEW.team_id!=OLD.team_id OR NEW.actor_id!=OLD.actor_id
  OR NEW.source_kind!=OLD.source_kind OR NEW.source_id!=OLD.source_id OR NEW.input_revision!=OLD.input_revision
  OR NEW.grounds_digest!=OLD.grounds_digest OR NEW.cache_key!=OLD.cache_key OR NEW.fingerprint!=OLD.fingerprint
  OR NEW.model!=OLD.model OR NEW.prompt_version!=OLD.prompt_version OR NEW.created_at!=OLD.created_at;
 SELECT RAISE(ABORT,'IMMUTABLE_EXPLANATION') WHERE NEW.month!=OLD.month OR NEW.head_id IS NOT OLD.head_id OR NEW.head_revision!=OLD.head_revision OR NEW.source_digest!=OLD.source_digest;
END;
CREATE TRIGGER schedule_explanation_retention BEFORE DELETE ON schedule_explanation
BEGIN
 SELECT RAISE(ABORT,'EXPLANATION_RETENTION') WHERE OLD.created_at>=CAST(strftime('%s','now') AS INTEGER)*1000-2592000000;
END;
