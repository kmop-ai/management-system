-- 001_foundation — entities, people, access, audit, activity, notifications.
-- Nothing domain-specific lives here: this is the floor every module stands on.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

-- Small key/value switches that admins change from the UI without a deploy
-- (retention windows, whether people see their own metrics, digest defaults).
-- Anything with structure gets its own table; this is only for scalars.
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by  INTEGER
);

-- ---------------------------------------------------------------------------
-- Entities and organisation
-- ---------------------------------------------------------------------------

-- The KMOP entities. They share management but are separate legal persons,
-- so nothing in the schema ever sums across them implicitly: every project,
-- contract, budget line and person-cost carries an entity_id, and reports
-- that span entities say so out loud.
CREATE TABLE entities (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,          -- short handle used in project codes and filters: ASSOC, POLICY, EDU
  name        TEXT NOT NULL,
  legal_name  TEXT,                          -- as it appears on grant agreements; may differ from the everyday name
  country     TEXT NOT NULL,                 -- ISO 3166-1 alpha-2; drives public holidays and VAT rules later
  city        TEXT,
  vat_number  TEXT,
  pic         TEXT,                          -- EU Participant Identification Code, needed on every EU proposal
  oid         TEXT,                          -- Erasmus+ Organisation ID; the National Agencies use this, not the PIC
  currency    TEXT NOT NULL DEFAULT 'EUR',
  timezone    TEXT NOT NULL DEFAULT 'Europe/Athens', -- digests and "due today" are computed in the entity's local time
  color       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);

-- Departments / teams. entity_id is nullable on purpose: some teams
-- (management, communications) work across all three entities and pretending
-- they belong to one would put the wrong entity on their people's cost lines.
CREATE TABLE departments (
  id           INTEGER PRIMARY KEY,
  entity_id    INTEGER REFERENCES entities(id),
  parent_id    INTEGER REFERENCES departments(id),
  name         TEXT NOT NULL,
  name_el      TEXT,                         -- Greek name, shown when the interface is in Greek
  head_user_id INTEGER,                      -- who receives this department's escalations; FK added logically (users is defined below)
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at   TEXT
);

-- People. One row per human, whichever entity employs them, so the same
-- person works across all three entities with one sign-in. entity_id is the
-- employing entity (whose payroll and leave calendar apply); access to other
-- entities comes from user_roles, never from this column.
CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL,
  title            TEXT,                     -- job title, free text: "Project Manager", "Υπεύθυνη Οικονομικών"
  entity_id        INTEGER REFERENCES entities(id),
  department_id    INTEGER REFERENCES departments(id),
  manager_id       INTEGER REFERENCES users(id),   -- line manager, for 1:1s and escalation when no department head applies
  is_external      INTEGER NOT NULL DEFAULT 0,     -- partner-organisation guests; never counted in KMOP capacity or headcount
  external_org     TEXT,                     -- the guest's own organisation, shown next to their name
  locale           TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en','el')),
  theme            TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system','light','dark')),
  timezone         TEXT,                     -- overrides the entity timezone (someone working from Brussels for a Greek entity)
  -- Capacity. Workload is honest only if part-time is modelled: 40h over five
  -- days is not the same person as 24h over three.
  weekly_hours     REAL NOT NULL DEFAULT 40,
  work_days        TEXT NOT NULL DEFAULT '12345',  -- ISO weekdays worked, 1=Mon … 7=Sun
  digest_frequency TEXT NOT NULL DEFAULT 'daily' CHECK (digest_frequency IN ('daily','weekly','off')),
  digest_hour      INTEGER NOT NULL DEFAULT 8,     -- local hour the digest goes out
  last_digest_at   TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  -- Bumped to revoke every session for this person instantly (lost laptop,
  -- leaver, role change). Sessions carry the version they were minted with.
  token_version    INTEGER NOT NULL DEFAULT 1,
  last_login_at    TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT
);
CREATE INDEX idx_users_entity ON users(entity_id, department_id);

-- How a person proves who they are. Magic link is provider 'email'; adding
-- Microsoft or Google SSO later is a new provider row per person, and
-- nothing that calls "who is signed in" changes.
CREATE TABLE auth_identities (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  provider     TEXT NOT NULL,                -- 'email', later 'microsoft', 'google'
  subject      TEXT NOT NULL,                -- the provider's stable id; the address itself for 'email'
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at TEXT,
  UNIQUE (provider, subject)
);

-- Outstanding magic links. Only the SHA-256 of the token is stored, so a
-- database read never yields a working link. Single use: used_at is set on
-- redemption and a second click is refused.
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  ip         TEXT,
  redirect   TEXT                            -- hash route to land on after sign-in, so links in emails open the right task
);
CREATE INDEX idx_magic_links_user ON magic_links(user_id, created_at);

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

-- Roles are configuration, not code: label, description and default module
-- access are rows, so a new role ("communications officer") is an admin task.
-- rank only orders roles in pickers and decides who can grant what (you can
-- never grant a role ranked above your own).
CREATE TABLE roles (
  key         TEXT PRIMARY KEY,
  label_en    TEXT NOT NULL,
  label_el    TEXT NOT NULL,
  description TEXT,
  rank        INTEGER NOT NULL,
  requires_expiry INTEGER NOT NULL DEFAULT 0, -- auditor access must be time-boxed; the API refuses a grant without valid_until
  is_system   INTEGER NOT NULL DEFAULT 0    -- system roles cannot be deleted, only re-labelled
);

-- Modules are the units access is granted on. 'sensitive' marks the ones
-- whose data is personal or salary-level, which the UI flags when granting.
CREATE TABLE modules (
  key         TEXT PRIMARY KEY,
  label_en    TEXT NOT NULL,
  label_el    TEXT NOT NULL,
  description TEXT,
  sensitive   INTEGER NOT NULL DEFAULT 0
);

-- Default access per role per module. Levels: 0 none, 1 read, 2 write,
-- 3 admin. A level here applies across the scope of the user_roles row that
-- grants the role (all entities, one entity, or one department).
CREATE TABLE role_module_access (
  role   TEXT NOT NULL REFERENCES roles(key),
  module TEXT NOT NULL REFERENCES modules(key),
  level  INTEGER NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 3),
  PRIMARY KEY (role, module)
);

-- Who holds which role, and where. entity_id NULL means every entity;
-- department_id narrows a department head to their own department. A person
-- can hold several rows (PM everywhere, finance only in KMOP ASSOCIATION),
-- which is how the same person spans entities without three logins and
-- without seeing another entity's salary data by accident.
CREATE TABLE user_roles (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  role          TEXT NOT NULL REFERENCES roles(key),
  entity_id     INTEGER REFERENCES entities(id),
  department_id INTEGER REFERENCES departments(id),
  valid_from    TEXT,
  valid_until   TEXT,                        -- auditors and temporary cover expire on their own; nobody has to remember to revoke
  granted_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at    TEXT
);
CREATE INDEX idx_user_roles_user ON user_roles(user_id) WHERE revoked_at IS NULL;

-- Per-person exceptions to the role defaults, same idea as ARTIT HQ's
-- module_access but entity-scoped. An override replaces the role-derived
-- level for that module in that scope, so it can grant ("this PM may see
-- finance for ASSOC") or restrict ("this upper manager may not see people
-- metrics"). reason is required by the API: an exception nobody can explain
-- is the first thing an auditor asks about.
CREATE TABLE module_access (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  module      TEXT NOT NULL REFERENCES modules(key),
  entity_id   INTEGER REFERENCES entities(id),
  level       INTEGER NOT NULL CHECK (level BETWEEN 0 AND 3),
  reason      TEXT,
  valid_until TEXT,
  granted_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);
CREATE INDEX idx_module_access_user ON module_access(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Audit, activity, notifications — shared by every module
-- ---------------------------------------------------------------------------

-- Every write, by anyone, through any route. summary is a sentence a human
-- (an auditor, a GM) can read without the schema open: "Eleni Georgiou moved
-- 'Draft D2.1' from In progress to In review". changes holds the field-level
-- before/after for the people who do want the detail. Never updated, never
-- deleted — not even by the retention job.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id    INTEGER,                       -- NULL for the system (cron jobs, retention)
  action      TEXT NOT NULL,                 -- create | update | delete | restore | login | grant | revoke | export | ...
  object_type TEXT NOT NULL,
  object_id   INTEGER,
  object_label TEXT,                         -- the object's name at the time, so the log still reads after a rename or purge
  entity_id   INTEGER,                       -- lets an entity-scoped auditor or finance lead read only their entity's trail
  project_id  INTEGER,
  summary     TEXT NOT NULL,
  changes     TEXT,                          -- JSON {field: [before, after]}
  ip          TEXT,
  request_id  TEXT
);
CREATE INDEX idx_audit_object  ON audit_log(object_type, object_id);
CREATE INDEX idx_audit_project ON audit_log(project_id, at);
CREATE INDEX idx_audit_actor   ON audit_log(actor_id, at);
CREATE INDEX idx_audit_at      ON audit_log(at);

-- The human-facing feed: what happened on a project or task, in the order it
-- happened. Narrower than the audit log (no logins, no permission changes)
-- and shown to everyone who can see the object. verb + payload rather than a
-- prebuilt sentence so it renders in Greek or English for each reader.
CREATE TABLE activity (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_id    INTEGER,
  verb        TEXT NOT NULL,                 -- task.created, task.completed, task.assigned, comment.added, member.added ...
  object_type TEXT NOT NULL,
  object_id   INTEGER NOT NULL,
  project_id  INTEGER,
  task_id     INTEGER,                       -- so a task's history includes its comments and subtasks without a join chain
  payload     TEXT                           -- JSON: names and before/after values the renderer needs
);
CREATE INDEX idx_activity_project ON activity(project_id, at);
CREATE INDEX idx_activity_task    ON activity(task_id, at);

-- One inbox for everything addressed to a person: assignments, mentions,
-- comments on things they follow, due dates, and (Phase 5) nudges from the
-- rules engine. dedupe_key stops the hourly cron from telling someone the
-- same task is due tomorrow twenty-four times.
CREATE TABLE notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,                 -- assigned | mentioned | commented | due_soon | overdue | completed | added_to_project | nudge
  actor_id    INTEGER,
  object_type TEXT,
  object_id   INTEGER,
  project_id  INTEGER,
  title       TEXT NOT NULL,                 -- the object's name, kept so the inbox renders without joins
  body        TEXT,                          -- short excerpt (comment text, old → new due date)
  url         TEXT,                          -- hash route inside the app
  dedupe_key  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  read_at     TEXT,
  archived_at TEXT,
  emailed_at  TEXT,                          -- set when included in an immediate email or a digest, so nothing is sent twice
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX idx_notifications_inbox ON notifications(user_id, archived_at, created_at);

-- Per-person, per-kind delivery choices. No row means the default for that
-- kind (see src/lib/notify.js). 'email' = 'immediate' sends one mail per
-- notification; 'digest' folds it into the daily/weekly digest; 'off' keeps
-- it in-app only.
CREATE TABLE notification_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind    TEXT NOT NULL,
  in_app  INTEGER NOT NULL DEFAULT 1,
  email   TEXT NOT NULL DEFAULT 'digest' CHECK (email IN ('immediate','digest','off')),
  PRIMARY KEY (user_id, kind)
);

-- Outgoing mail goes through a table, not straight to the provider, so a
-- provider outage delays mail instead of losing it, and so local development
-- can read the magic link and digests without a mail server.
CREATE TABLE email_outbox (
  id         INTEGER PRIMARY KEY,
  to_email   TEXT NOT NULL,
  user_id    INTEGER,
  kind       TEXT NOT NULL,                  -- magic_link | notification | digest
  subject    TEXT NOT NULL,
  body_text  TEXT NOT NULL,
  body_html  TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at    TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_outbox_pending ON email_outbox(sent_at, attempts);

-- ---------------------------------------------------------------------------
-- Capacity: leave and holidays
-- ---------------------------------------------------------------------------

-- Public holidays per entity. Belgium and Greece do not share a calendar
-- (Greek Orthodox Easter moves independently), and workload is wrong for a
-- whole week if this is ignored.
CREATE TABLE entity_holidays (
  id        INTEGER PRIMARY KEY,
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  date      TEXT NOT NULL,
  name      TEXT NOT NULL,
  UNIQUE (entity_id, date)
);

-- Personal leave. Only the dates and a coarse type are stored: the reason
-- for sick leave is not the system's business.
CREATE TABLE leave (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'annual' CHECK (kind IN ('annual','sick','training','unpaid','other')),
  half_day   INTEGER NOT NULL DEFAULT 0,     -- a single half day; multi-day half-days are entered as separate rows
  note       TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_leave_user ON leave(user_id, start_date);
