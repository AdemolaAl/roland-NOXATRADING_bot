-- Up Migration
-- Add optional media payload to broadcasts so admins can send photos/videos/
-- documents/animations along with the personalized caption text.
ALTER TABLE broadcasts
  ADD COLUMN media_kind   VARCHAR(16),
  ADD COLUMN media_file_id TEXT;

-- Down Migration
ALTER TABLE broadcasts
  DROP COLUMN media_file_id,
  DROP COLUMN media_kind;
