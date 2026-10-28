-- Email and username are unique regardless of case. Signup already rejected
-- case-insensitive duplicates in the application, but users_email_key and
-- users_username_key are case-sensitive, so two concurrent signups for "Alice" and
-- "alice" could both succeed. These indexes make the database the final authority;
-- the signup service maps the unique violation to 409.
--
-- No rows are changed. If case-insensitive duplicates already exist the migration
-- stops with an explanation; resolve them by hand first (none existed in the shared
-- development database on 2026-10-28). The original case-sensitive constraints stay.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1) THEN
        RAISE EXCEPTION 'users has emails that differ only by case; resolve them before applying 009.';
    END IF;
    IF EXISTS (SELECT 1 FROM users GROUP BY LOWER(username) HAVING COUNT(*) > 1) THEN
        RAISE EXCEPTION 'users has usernames that differ only by case; resolve them before applying 009.';
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (LOWER(username));
