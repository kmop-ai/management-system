-- 004_password_sign_in — email + password sign-in, for installations without
-- a mail server (a local office install). Magic links stay; SSO can follow.

-- One password per person, kept apart from users so the users table never
-- carries a credential, and so removing passwords is dropping one table.
-- PBKDF2-SHA256; iterations stored per row so the cost can be raised later
-- without invalidating existing passwords. must_change is set on every
-- password an administrator hands out: the person picks their own on first
-- sign-in, so the administrator never knows anyone's real password.
CREATE TABLE password_credentials (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  hash        TEXT NOT NULL,
  salt        TEXT NOT NULL,
  iterations  INTEGER NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 1,
  set_by      INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
