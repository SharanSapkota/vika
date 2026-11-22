-- 004_ticket_comment_count: the occurrence count when vika last wrote to a
-- ticket (when it filed it, or its last comment).
--
-- A later run comments again only for a new error group, or when the count
-- has at least doubled since then, so an ongoing error doesn't add a
-- comment on every run. Existing tickets start from their last known count.
ALTER TABLE tickets ADD COLUMN last_commented_count integer;
UPDATE tickets SET last_commented_count = last_known_count;
ALTER TABLE tickets ALTER COLUMN last_commented_count SET NOT NULL;
ALTER TABLE tickets ADD CONSTRAINT tickets_last_commented_count_check CHECK (last_commented_count >= 0);
