-- Preserve the exact minimized model input alongside its source hashes. The
-- earlier private PoC records remain identifiable; do not rewrite old traces.
ALTER TABLE schedule_explanation ADD COLUMN packet TEXT CHECK(packet IS NULL OR length(CAST(packet AS BLOB))<=16000);
ALTER TABLE schedule_explanation ADD COLUMN grounds_version TEXT;
CREATE TRIGGER schedule_explanation_packet_guard BEFORE INSERT ON schedule_explanation
BEGIN
 SELECT RAISE(ABORT,'EXPLANATION_PACKET_REQUIRED') WHERE NEW.packet IS NULL OR NEW.grounds_version IS NOT 'explanation-v1';
END;
CREATE TRIGGER schedule_explanation_packet_immutable BEFORE UPDATE ON schedule_explanation
BEGIN
 SELECT RAISE(ABORT,'IMMUTABLE_EXPLANATION') WHERE NEW.packet IS NOT OLD.packet OR NEW.grounds_version IS NOT OLD.grounds_version;
END;
