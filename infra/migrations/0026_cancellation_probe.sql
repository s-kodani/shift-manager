-- Dedicated private fictional PoC ownership; product router does not import it.
CREATE TABLE cancellation_probe (
 id TEXT PRIMARY KEY,company_id TEXT,team_id TEXT,admin_user_id TEXT,staff_user_id TEXT,
 stage TEXT NOT NULL,metadata TEXT NOT NULL CHECK(json_valid(metadata)),results TEXT NOT NULL CHECK(json_valid(results)),
 lease TEXT,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,cleaned_at INTEGER,
 FOREIGN KEY(company_id) REFERENCES company(id)
);
