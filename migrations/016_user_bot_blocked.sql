-- Track users who have blocked the bot or deleted their Telegram chat, so
-- the inactivity-ping worker can stop re-attempting sends to dead chats.
-- Telegram responds 403 ("bot can't initiate conversation" / "bot was
-- blocked") or 400 ("chat not found") for these users — both terminal until
-- the user /starts again, at which point activityMw can NULL this out.
ALTER TABLE users ADD COLUMN bot_blocked_at TIMESTAMPTZ;
