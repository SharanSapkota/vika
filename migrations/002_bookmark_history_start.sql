-- 002_bookmark_history_start: when each log source's history starts.
--
-- first_read_at is the timestamp of the earliest log line in the first
-- batch read from that source (log time, not wall-clock time), so logs
-- read after the fact still have the right history start. It is set once,
-- the first time it is known, and never changed (the store writes it with
-- COALESCE). The detector uses it as historyStart: a deploy with less
-- than 24 hours of history before it is not judged.
ALTER TABLE bookmarks ADD COLUMN first_read_at timestamptz;
