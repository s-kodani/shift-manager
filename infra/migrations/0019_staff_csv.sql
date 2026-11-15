-- One atomic import: identity updates and per-person immutable input versions.
CREATE TABLE staff_csv_operation (
 company_id TEXT NOT NULL REFERENCES company(id),id TEXT NOT NULL,team_id TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),
 expected_revision INTEGER NOT NULL CHECK(expected_revision>=0),fingerprint TEXT NOT NULL,
 PRIMARY KEY(company_id,id),FOREIGN KEY(company_id,team_id) REFERENCES team(company_id,id)
);
CREATE TRIGGER staff_csv_operation_guard BEFORE INSERT ON staff_csv_operation BEGIN
 SELECT RAISE(ABORT,'CSV_FORBIDDEN') WHERE NOT EXISTS(SELECT 1 FROM access_state a WHERE a.user_id=NEW.actor_id AND a.enabled=1 AND a.must_change_password=0)
 OR NOT (EXISTS(SELECT 1 FROM company_admin a WHERE a.company_id=NEW.company_id AND a.user_id=NEW.actor_id)
 OR EXISTS(SELECT 1 FROM team_member m WHERE m.company_id=NEW.company_id AND m.team_id=NEW.team_id AND m.user_id=NEW.actor_id AND m.role='team_admin'));
 SELECT RAISE(ABORT,'CSV_VERSION_CONFLICT') WHERE NOT EXISTS(SELECT 1 FROM company c WHERE c.id=NEW.company_id AND c.revision=NEW.expected_revision);
END;
CREATE TRIGGER staff_csv_operation_revision AFTER INSERT ON staff_csv_operation BEGIN
 UPDATE company SET revision=revision+1 WHERE id=NEW.company_id;
END;
CREATE TRIGGER staff_csv_operation_no_update BEFORE UPDATE ON staff_csv_operation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_OPERATION'); END;
CREATE TRIGGER staff_csv_operation_no_delete BEFORE DELETE ON staff_csv_operation BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_OPERATION'); END;
CREATE TABLE staff_csv_receipt (
 company_id TEXT NOT NULL,operation_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(company_id,operation_id),FOREIGN KEY(company_id,operation_id) REFERENCES staff_csv_operation(company_id,id)
);
CREATE TRIGGER staff_csv_receipt_guard BEFORE INSERT ON staff_csv_receipt BEGIN
 SELECT RAISE(ABORT,'CSV_RECEIPT_MISMATCH') WHERE json_extract(NEW.payload,'$.id')!=NEW.operation_id OR json_extract(NEW.payload,'$.revision')!=NEW.revision
 OR json_extract(NEW.payload,'$.replayed')!=0
 OR json_extract(NEW.payload,'$.added')+json_extract(NEW.payload,'$.updated')!=json_array_length(NEW.payload,'$.rows')
 OR json_extract(NEW.payload,'$.rejectedRows')!=json_array_length(NEW.payload,'$.errors')
 OR json_array_length(NEW.payload,'$.rows') NOT BETWEEN 1 AND 100
 OR NOT EXISTS(SELECT 1 FROM staff_csv_operation o JOIN company c ON c.id=o.company_id WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id
 AND c.revision=NEW.revision AND NEW.revision=o.expected_revision+1+json_array_length(NEW.payload,'$.rows'))
 OR EXISTS(SELECT 1 FROM json_each(NEW.payload,'$.rows') r WHERE NOT EXISTS(SELECT 1 FROM work_input_version v JOIN staff_csv_operation o ON o.company_id=v.company_id
 WHERE o.company_id=NEW.company_id AND o.id=NEW.operation_id AND v.operation_id=json_extract(r.value,'$.contractVersion') AND v.kind='staff_contract'
 AND v.team_id=o.team_id AND v.staff_id=json_extract(r.value,'$.staffId') AND v.effective_from=json_extract(NEW.payload,'$.month')
 AND v.revision=o.expected_revision+2+CAST(r.key AS INTEGER)));
END;
CREATE TRIGGER staff_csv_receipt_no_update BEFORE UPDATE ON staff_csv_receipt BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_RECEIPT'); END;
CREATE TRIGGER staff_csv_receipt_no_delete BEFORE DELETE ON staff_csv_receipt BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CSV_RECEIPT'); END;
