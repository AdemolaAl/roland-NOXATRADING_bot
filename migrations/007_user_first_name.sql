-- Up Migration
-- Add Telegram first_name so broadcast placeholders ({first_name}) can
-- personalize messages without an extra getChat call per recipient.
ALTER TABLE users ADD COLUMN telegram_first_name VARCHAR(128);

-- Down Migration
ALTER TABLE users DROP COLUMN telegram_first_name;
