-- One database is one maintenance boundary, including auth and all companies.
CREATE TABLE maintenance_state (
 id INTEGER PRIMARY KEY CHECK(id=1),
 mode TEXT NOT NULL CHECK(mode IN ('OPEN','DRAINING','FROZEN')),
 revision INTEGER NOT NULL CHECK(revision>=0),
 maintenance_id TEXT,
 last_operation_id TEXT,
 updated_at INTEGER NOT NULL
);
INSERT INTO maintenance_state VALUES(1,'OPEN',0,NULL,NULL,0);
CREATE TABLE maintenance_lease (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('FOREGROUND','BACKGROUND')),
 started_at INTEGER NOT NULL
);
-- No expiry: elapsed time is not proof that an invocation has stopped.
CREATE TABLE maintenance_operation (
 id TEXT PRIMARY KEY,
 principal TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('begin','freeze','resume')),
 fingerprint TEXT NOT NULL,
 maintenance_id TEXT,
 mode TEXT NOT NULL CHECK(mode IN ('OPEN','DRAINING','FROZEN')),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TRIGGER maintenance_operation_no_update BEFORE UPDATE ON maintenance_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_OPERATION'); END;
CREATE TRIGGER maintenance_operation_no_delete BEFORE DELETE ON maintenance_operation
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MAINTENANCE_OPERATION'); END;
