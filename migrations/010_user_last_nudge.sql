-- Up Migration
-- Track the message_id of the most recently sent inactivity nudge so the
-- worker can delete the previous one before sending the next. Keeps the
-- nudge channel feeling like a single rolling card instead of a stack.
ALTER TABLE users ADD COLUMN last_nudge_message_id INT;

-- Down Migration
ALTER TABLE users DROP COLUMN last_nudge_message_id;
