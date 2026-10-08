-- 005_roles_modules_google — the access model of the brief, and Google sign-in.
--
-- Access has two separate dimensions:
--   * a ROLE per person: super_admin, admin, member, supervisor;
--   * MODULE access: one row per person per module, read or write.
-- The sidebar is built from module access, so a person without a module
-- sees no page at all rather than a locked one. Supervisors (funders,
-- board, external evaluators) are additionally scoped to named projects.
-- Passwords are gone: sign-in is a personal link (hash only) or Google.

DROP TABLE password_credentials;

-- One role per person. super_admin can also be forced from configuration
-- (SUPER_ADMINS), so the people who run the system can never be locked out
-- by a mistake made in the UI.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin','admin','member','supervisor'));

-- The person's own order for the sidebar: a JSON array of page keys.
-- Pages they gain later are appended; pages they lose simply disappear.
ALTER TABLE users ADD COLUMN sidebar_order TEXT;

-- Module access. No row = no access, and no page in the sidebar. The list
-- of valid modules is owned by the server (src/lib/modules.js), not by a
-- CHECK here, so adding a page is a code change, not a migration.
CREATE TABLE module_grants (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  module     TEXT NOT NULL,
  access     TEXT NOT NULL CHECK (access IN ('read','write')),
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, module)
);

-- Which projects a supervisor may see. A supervisor needs BOTH the module
-- (e.g. reporting: read) and the project here; either alone shows nothing.
CREATE TABLE supervisor_projects (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, project_id)
);
CREATE INDEX idx_supervisor_projects_project ON supervisor_projects(project_id);

-- Connections to outside services, configured in Team and Access:
--   'google_oauth' — the OAuth client used for Google sign-in and for
--                    connecting the mailbox (client_id / client_secret);
--   'gmail'        — the organisation mailbox the system reads and sends
--                    sign-in links from (refresh token).
-- Secrets are write-only through the API: they are never sent to a browser.
CREATE TABLE integrations (
  key           TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'not_connected',  -- not_connected | connected | error
  account_email TEXT,
  client_id     TEXT,
  client_secret TEXT,
  refresh_token TEXT,
  access_token  TEXT,
  expires_at    TEXT,
  scopes        TEXT,
  last_error    TEXT,
  connected_by  INTEGER REFERENCES users(id),
  connected_at  TEXT,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Every sign-in attempt that did not end in a session, with the real
-- reason. The response to the browser is deliberately identical whatever
-- happened (no account enumeration); this table is where an administrator
-- finds out that a link was never delivered, or a domain was refused.
CREATE TABLE auth_events (
  id         INTEGER PRIMARY KEY,
  at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  email      TEXT,
  user_id    INTEGER,
  method     TEXT NOT NULL,        -- link | google
  outcome    TEXT NOT NULL,        -- sent | send_failed | unknown_email | domain_not_allowed | inactive | rate_limited | denied | signed_in
  detail     TEXT,                 -- the real reason, e.g. the mail provider's error
  ip         TEXT
);
CREATE INDEX idx_auth_events_at ON auth_events(at);

-- Carry existing people into the new roles. Their old role grants stay in
-- user_roles for the record but no longer decide access.
UPDATE users SET role = 'super_admin' WHERE id IN (SELECT user_id FROM user_roles WHERE role = 'super_admin' AND revoked_at IS NULL);
UPDATE users SET role = 'admin' WHERE role = 'member' AND id IN (SELECT user_id FROM user_roles WHERE role IN ('general_manager','upper_management') AND revoked_at IS NULL);
UPDATE users SET role = 'supervisor' WHERE role = 'member' AND (is_external = 1 OR id IN (SELECT user_id FROM user_roles WHERE role IN ('auditor','external_partner') AND revoked_at IS NULL));

-- Existing staff keep working: write on every staff module.
INSERT OR IGNORE INTO module_grants (user_id, module, access)
  SELECT u.id, m.value, 'write' FROM users u, json_each('["dashboard","projects","ka1","proposals","calls","partners","organisations","people","reporting","evaluation","tasks"]') m
   WHERE u.role IN ('member','admin') AND u.deleted_at IS NULL;
-- Existing guests and auditors: read on projects and oversight, for the projects they were in.
INSERT OR IGNORE INTO module_grants (user_id, module, access)
  SELECT u.id, m.value, 'read' FROM users u, json_each('["dashboard","projects","reporting","evaluation"]') m
   WHERE u.role = 'supervisor' AND u.deleted_at IS NULL;
INSERT OR IGNORE INTO supervisor_projects (user_id, project_id)
  SELECT pm.user_id, pm.project_id FROM project_members pm JOIN users u ON u.id = pm.user_id
   WHERE u.role = 'supervisor' AND pm.removed_at IS NULL;
