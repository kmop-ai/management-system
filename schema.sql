-- KMOP HQ — canonical schema.
--
-- This file is the documentation of the data model: read the comments, they
-- say why each table and non-obvious column exists. A fresh database can be
-- built from this file alone; live databases get here through migrations/
-- (applied by `wrangler d1 migrations apply`, recorded in schema_migrations).
-- scripts/check-schema.mjs fails the build if the two ever disagree, so every
-- change is made twice: here, and as the next numbered migration.
--
-- Conventions
--   * INTEGER PRIMARY KEY ids; timestamps are ISO-8601 UTC strings with
--     milliseconds (they double as optimistic-concurrency versions in
--     updated_at); dates are 'YYYY-MM-DD'.
--   * Nothing a person can delete is hard-deleted: deleted_at is set, and only
--     the retention job (src/cron.js) removes rows for good.
--   * Funder vocabulary is configuration, not CHECK constraints. The CHECKs
--     that remain are on things the code itself reasons about.
--   * Every row that belongs to an organisation belongs to one KMOP entity.


-- ============================================================================
-- from 001_foundation.sql
-- ============================================================================
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

-- ============================================================================
-- from 002_pm_core.sql
-- ============================================================================
-- 002_pm_core — projects, members, the task engine, templates, saved views, search.
-- This is the part the team should want to use even without the EU features.

-- ---------------------------------------------------------------------------
-- Projects and membership
-- ---------------------------------------------------------------------------

-- A project is generic here. Phase 2 hangs the programme, call, work packages
-- and deliverables off it; nothing in this table assumes Erasmus+ or ESPA.
-- start_date matters more than it looks: EU projects run on project months
-- (M1 = the month containing start_date), and every M-number in the UI is
-- derived from it rather than stored next to each date.
CREATE TABLE projects (
  id            INTEGER PRIMARY KEY,
  entity_id     INTEGER NOT NULL REFERENCES entities(id),   -- which KMOP entity holds the contract; never inferred from the PM
  department_id INTEGER REFERENCES departments(id),
  code          TEXT,                        -- internal short code / acronym: "YOUTHLINK", "CERV-SAFE"
  name          TEXT NOT NULL,
  description   TEXT,                        -- Markdown
  kind          TEXT NOT NULL DEFAULT 'eu',  -- eu | national | internal | other; refined by the programme record in Phase 2
  funder        TEXT,                        -- free text until Phase 2 links a programme: "Erasmus+ KA220-ADU", "ESPA 2021-27"
  our_role      TEXT,                        -- coordinator | partner | sole beneficiary | contractor; free text for the same reason
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('planning','active','on_hold','closing','closed')),
  start_date    TEXT,
  end_date      TEXT,
  color         TEXT,
  -- Who outside the members may see it. 'members': only members plus roles
  -- with entity-wide project read (GM, upper management, auditor). 'entity':
  -- also everyone employed by the owning entity, for internal projects.
  visibility    TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members','entity')),
  template_id   INTEGER,                     -- the template it was created from, so template improvements can be traced
  last_activity_at TEXT,                     -- touched by every write under the project; "no recent activity" in Phase 5 reads this, not a scan
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  archived_at   TEXT,
  deleted_at    TEXT
);
CREATE INDEX idx_projects_entity ON projects(entity_id, status) WHERE deleted_at IS NULL;

-- Membership is first class from day one, and several PMs per project is the
-- normal case. role is the project-level role: pm (manages the project,
-- edits everything), member (works on tasks), viewer (reads only), guest
-- (an external partner: sees this project and nothing else, and never sees
-- KMOP-internal tasks marked internal).
CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('pm','member','viewer','guest')),
  added_by   INTEGER REFERENCES users(id),
  added_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  removed_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX idx_members_user ON project_members(user_id) WHERE removed_at IS NULL;

-- Planned effort per person per project over a period. EU projects allocate
-- people in person-months; storing the FTE share for a date range lets the
-- workload view put "allocated 30% to CERV-SAFE" next to what the tasks
-- actually ask of them, which is the reconciliation management needs.
-- person_months is what was promised to the funder, kept for comparison.
CREATE TABLE allocations (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id),
  start_date    TEXT NOT NULL,
  end_date      TEXT NOT NULL,
  fte_pct       REAL NOT NULL CHECK (fte_pct > 0 AND fte_pct <= 100),
  person_months REAL,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT
);
CREATE INDEX idx_allocations_user ON allocations(user_id, start_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_allocations_project ON allocations(project_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Task engine
-- ---------------------------------------------------------------------------

-- Task statuses are configuration. category is what the code reasons about
-- (is it done? is it started?), so labels and extra steps like "partner
-- review" can be added without touching a query.
CREATE TABLE task_statuses (
  key      TEXT PRIMARY KEY,
  label_en TEXT NOT NULL,
  label_el TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('todo','active','done','cancelled')),
  color    TEXT,
  position INTEGER NOT NULL
);

-- Sections are the user's own grouping inside a project ("Preparation",
-- "WP2 — Toolkit", "Backlog"). The board can show columns by section or by
-- status; they answer different questions.
CREATE TABLE sections (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_sections_project ON sections(project_id, position);

-- The task. project_id NULL is a personal task (visible to its creator,
-- assignee and followers only). parent_id makes subtasks recursive to any
-- depth; a subtask always lives in its parent's project. position is a REAL
-- so drag-and-drop inserts between two tasks without renumbering the rest.
CREATE TABLE tasks (
  id              INTEGER PRIMARY KEY,
  project_id      INTEGER REFERENCES projects(id),
  parent_id       INTEGER REFERENCES tasks(id),
  section_id      INTEGER REFERENCES sections(id),
  title           TEXT NOT NULL,
  description     TEXT,                      -- Markdown; rendered client-side after escaping, so stored text can never inject HTML
  status          TEXT NOT NULL DEFAULT 'todo' REFERENCES task_statuses(key),
  priority        TEXT NOT NULL DEFAULT 'none' CHECK (priority IN ('none','low','medium','high','urgent')),
  assignee_id     INTEGER REFERENCES users(id),
  start_date      TEXT,
  due_date        TEXT,
  estimate_hours  REAL,                      -- feeds workload: spread over start→due across the assignee's working days
  is_milestone    INTEGER NOT NULL DEFAULT 0,-- zero-duration marker on the timeline; Phase 2 links real milestones here
  -- Internal tasks are hidden from guests (external partners) on shared
  -- projects: KMOP's own chasing of a late partner is not for that partner.
  is_internal     INTEGER NOT NULL DEFAULT 0,
  position        REAL NOT NULL DEFAULT 0,
  recurrence_id   INTEGER,                   -- series this occurrence belongs to (recurrences.id)
  completed_at    TEXT,
  completed_by    INTEGER REFERENCES users(id),
  -- When the current assignee got it. "How long things sit with a person"
  -- is measured from here, so it must be set on every reassignment.
  assigned_at     TEXT,
  template_key    TEXT,                      -- stable key from the template it came from; lets Phase 2 match tasks to template WPs
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at      TEXT
);
CREATE INDEX idx_tasks_project  ON tasks(project_id, section_id, position) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, due_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_parent   ON tasks(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_tasks_due      ON tasks(due_date) WHERE deleted_at IS NULL AND completed_at IS NULL;

-- Followers (collaborators / watchers). They receive comments and changes.
-- reason distinguishes people who chose to follow from those added
-- automatically (creator, assignee, mentioned), so "unfollow" can be honest.
CREATE TABLE task_followers (
  task_id  INTEGER NOT NULL REFERENCES tasks(id),
  user_id  INTEGER NOT NULL REFERENCES users(id),
  reason   TEXT NOT NULL DEFAULT 'manual' CHECK (reason IN ('manual','creator','assignee','mentioned','commented')),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (task_id, user_id)
);
CREATE INDEX idx_followers_user ON task_followers(user_id);

-- blocks / blocked-by. Finish-to-start is the only kind people actually use;
-- lag_days covers "review starts two days after the draft is done". Cycles
-- are refused by the API (a recursive check before insert), since the
-- critical-path calculation has no answer for them.
CREATE TABLE task_dependencies (
  blocker_id INTEGER NOT NULL REFERENCES tasks(id),
  blocked_id INTEGER NOT NULL REFERENCES tasks(id),
  lag_days   INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX idx_deps_blocked ON task_dependencies(blocked_id);

-- Recurring task series. Two honest modes: 'schedule' creates the next
-- occurrence on the calendar whether or not the last was done (the monthly
-- partner-report chase), 'completion' creates it N units after the previous
-- one is completed (review the risk register a month after you last did).
CREATE TABLE recurrences (
  id           INTEGER PRIMARY KEY,
  freq         TEXT NOT NULL CHECK (freq IN ('daily','weekly','monthly','yearly')),
  interval_n   INTEGER NOT NULL DEFAULT 1,
  by_weekday   TEXT,                         -- weekly only: ISO weekdays, e.g. '1' or '135'
  by_monthday  INTEGER,                      -- monthly only: 1–28, or -1 for the last day of the month
  mode         TEXT NOT NULL DEFAULT 'schedule' CHECK (mode IN ('schedule','completion')),
  next_due     TEXT,                         -- the due date the next occurrence will get ('schedule' mode)
  until_date   TEXT,
  source_task_id INTEGER,                    -- the most recent occurrence; copied (title, checklist, followers) for the next
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at     TEXT
);

-- Checklists: lighter than subtasks — no assignee, no dates, just "did we
-- attach the signed mandate". Items belong to exactly one task.
CREATE TABLE checklist_items (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  done_by    INTEGER REFERENCES users(id),
  done_at    TEXT,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_checklist_task ON checklist_items(task_id, position);

-- Labels. project_id NULL = organisation-wide ("urgent-partner", "finance").
CREATE TABLE labels (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#6b7280',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_labels_project ON labels(project_id);

CREATE TABLE task_labels (
  task_id  INTEGER NOT NULL REFERENCES tasks(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (task_id, label_id)
);
CREATE INDEX idx_task_labels_label ON task_labels(label_id);

-- Custom fields per project, so a project can track "Partner", "Dissemination
-- level" or "Νούμερο πρωτοκόλλου" without a migration. options is a JSON
-- array of {key,label,color} for select types.
CREATE TABLE custom_fields (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name       TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('text','number','date','select','multiselect','user','checkbox','url')),
  options    TEXT,
  position   REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_custom_fields_project ON custom_fields(project_id);

-- One row per task per field. value is the JSON-encoded value (string,
-- number, array of option keys, user id); value_num duplicates numbers and
-- dates-as-text sort keys so filters and sorts stay in SQL.
CREATE TABLE task_field_values (
  task_id   INTEGER NOT NULL REFERENCES tasks(id),
  field_id  INTEGER NOT NULL REFERENCES custom_fields(id),
  value     TEXT,
  value_num REAL,
  PRIMARY KEY (task_id, field_id)
);

-- ---------------------------------------------------------------------------
-- Conversation and files
-- ---------------------------------------------------------------------------

-- Comments are polymorphic (object_type/object_id) because Phase 2 needs
-- them on deliverables, risks and meetings too; one table means one inbox,
-- one mention parser, one search index.
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,                 -- 'task' for now
  object_id   INTEGER NOT NULL,
  project_id  INTEGER,                       -- denormalised so access checks and project feeds need no join through the object
  author_id   INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,                 -- Markdown; mentions are written as @[Name](user:ID)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at   TEXT,
  deleted_at  TEXT
);
CREATE INDEX idx_comments_object ON comments(object_type, object_id, created_at);

-- Who was mentioned where. Kept separately from the comment text so "where
-- was I mentioned" is an index lookup, and so a mention survives edits.
CREATE TABLE mentions (
  id          INTEGER PRIMARY KEY,
  comment_id  INTEGER REFERENCES comments(id),
  object_type TEXT NOT NULL,                 -- where the mention appears (task description or comment's object)
  object_id   INTEGER NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  author_id   INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_mentions_user ON mentions(user_id, created_at);

-- File metadata; the bytes live in R2 under r2_key. Attachments are soft
-- deleted like everything else and only removed from R2 by the retention job.
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  object_type TEXT NOT NULL,
  object_id   INTEGER NOT NULL,
  project_id  INTEGER,
  r2_key      TEXT NOT NULL UNIQUE,
  filename    TEXT NOT NULL,
  mime        TEXT,
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);
CREATE INDEX idx_attachments_object ON attachments(object_type, object_id);

-- ---------------------------------------------------------------------------
-- Templates and saved views
-- ---------------------------------------------------------------------------

-- Project templates: sections, tasks (with subtasks, checklists, labels and
-- dependencies by local key) and due dates as day offsets from the project
-- start, so a new KA2 starts pre-populated on its own calendar. Stored as one
-- JSON document because a template is edited and applied as a whole; Phase 2
-- extends the document with work packages and deliverables.
CREATE TABLE project_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  entity_id   INTEGER REFERENCES entities(id), -- NULL = usable by every entity
  kind        TEXT,                          -- suggested project kind
  body        TEXT NOT NULL,                 -- JSON, see src/routes/templates.js for the shape
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);

-- Task templates for recurring rituals: "Monthly partner report chase",
-- "Quarterly timesheet run". A task template plus a recurrence is how a
-- ritual is set up once and then simply happens.
CREATE TABLE task_templates (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  project_id  INTEGER REFERENCES projects(id), -- NULL = available everywhere
  body        TEXT NOT NULL,                 -- JSON: {title, description, estimate_hours, priority, checklist[], subtasks[]}
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at  TEXT
);

-- Saved filters per user. scope says where the view applies ('my_tasks',
-- 'project:12', 'all_tasks', 'workload'); config is the JSON the front end
-- produced (filters, sort, grouping, visible columns). shared views are
-- offered to everyone who can see the scope.
CREATE TABLE saved_views (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  scope      TEXT NOT NULL,
  name       TEXT NOT NULL,
  view_type  TEXT NOT NULL DEFAULT 'list' CHECK (view_type IN ('list','board','timeline','calendar','workload')),
  config     TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  shared     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at TEXT
);
CREATE INDEX idx_saved_views_user ON saved_views(user_id, scope);

-- ---------------------------------------------------------------------------
-- Search
-- ---------------------------------------------------------------------------

-- One full-text index over projects, tasks and comments, kept in sync by
-- triggers so no write path can forget it. Access filtering happens after the
-- match, in SQL, against the same predicates the list endpoints use.
-- 'unicode61 remove_diacritics 2' folds Greek accents, so "συναντηση" finds
-- "Συνάντηση".
CREATE VIRTUAL TABLE search_fts USING fts5(
  object_type UNINDEXED,
  object_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_tasks_fts_ins AFTER INSERT ON tasks BEGIN
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  VALUES ('task', NEW.id, NEW.project_id, NEW.title, COALESCE(NEW.description, ''));
END;
CREATE TRIGGER trg_tasks_fts_upd AFTER UPDATE OF title, description, project_id, deleted_at ON tasks BEGIN
  DELETE FROM search_fts WHERE object_type = 'task' AND object_id = OLD.id;
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  SELECT 'task', NEW.id, NEW.project_id, NEW.title, COALESCE(NEW.description, '') WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER trg_projects_fts_ins AFTER INSERT ON projects BEGIN
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  VALUES ('project', NEW.id, NEW.id, COALESCE(NEW.code || ' — ', '') || NEW.name, COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.funder, ''));
END;
CREATE TRIGGER trg_projects_fts_upd AFTER UPDATE OF code, name, description, funder, deleted_at ON projects BEGIN
  DELETE FROM search_fts WHERE object_type = 'project' AND object_id = OLD.id;
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  SELECT 'project', NEW.id, NEW.id, COALESCE(NEW.code || ' — ', '') || NEW.name, COALESCE(NEW.description, '') || ' ' || COALESCE(NEW.funder, '') WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER trg_comments_fts_ins AFTER INSERT ON comments BEGIN
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  VALUES ('comment', NEW.id, NEW.project_id, '', NEW.body);
END;
CREATE TRIGGER trg_comments_fts_upd AFTER UPDATE OF body, deleted_at ON comments BEGIN
  DELETE FROM search_fts WHERE object_type = 'comment' AND object_id = OLD.id;
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  SELECT 'comment', NEW.id, NEW.project_id, '', NEW.body WHERE NEW.deleted_at IS NULL;
END;

-- ============================================================================
-- from 003_reference_data.sql
-- ============================================================================
-- 003_reference_data — the configuration rows the code relies on existing.
-- Labels and access levels are edited in the admin UI afterwards; only the
-- keys are load-bearing.

INSERT INTO settings (key, value, description) VALUES
  ('people_metrics_self_visible', '1', 'Each person sees their own evaluation metrics, with the same numbers and definitions management sees. Set to 0 only as a deliberate decision.'),
  ('retention_soft_deleted_days', '180', 'Days a soft-deleted task, comment or attachment stays restorable before the retention job removes it for good. Projects are never purged by this job.'),
  ('magic_link_minutes', '20', 'How long a sign-in link stays valid.'),
  ('session_days', '30', 'How long a session lasts without signing in again.'),
  ('due_soon_days', '2', 'Assignees get a "due soon" notice this many days before a task is due.'),
  ('default_locale', 'en', 'Interface language for new people: en or el.');

-- Roles. rank decides who can grant what: you can never grant above your own.
INSERT INTO roles (key, label_en, label_el, description, rank, requires_expiry, is_system) VALUES
  ('super_admin',      'Super admin',        'Διαχειριστής συστήματος', 'Configures the system: people, roles, entities, settings.', 100, 0, 1),
  ('general_manager',  'General manager',    'Γενικός Διευθυντής',      'Sees and steers every project in every entity.', 90, 0, 1),
  ('upper_management', 'Upper management',   'Ανώτερη Διοίκηση',        'Reads portfolios and people across the entities in scope.', 80, 0, 1),
  ('department_head',  'Department head',    'Προϊστάμενος τμήματος',   'Reads the projects and people of their own department.', 60, 0, 1),
  ('finance',          'Finance',            'Οικονομικά',              'Budgets, payments and person-costs for the entities in scope.', 55, 0, 1),
  ('project_manager',  'Project manager',    'Υπεύθυνος έργου',         'Creates projects and manages the ones they are PM on.', 50, 0, 1),
  ('team_member',      'Team member',        'Μέλος ομάδας',            'Works on the projects they are a member of.', 20, 0, 1),
  ('external_partner', 'External partner',   'Εξωτερικός εταίρος',      'Guest from a partner organisation: sees only the projects they are added to.', 10, 0, 1),
  ('auditor',          'Auditor',            'Ελεγκτής',                'Read-only across everything in scope, for a fixed period.', 5, 1, 1);

INSERT INTO modules (key, label_en, label_el, description, sensitive) VALUES
  ('projects',       'Projects (all in scope)',  'Έργα (όλα στο πεδίο)',     'See (read) or edit (write) every project in the role''s scope, not only the ones you are a member of.', 0),
  ('project_create', 'Create projects',          'Δημιουργία έργων',         'Create new projects and become their PM.', 0),
  ('people',         'People & capacity',        'Άτομα & διαθεσιμότητα',    'Directory, capacity, leave and allocations of other people. Write edits them.', 1),
  ('people_metrics', 'People evaluation metrics','Δείκτες αξιολόγησης',      'On-time rate, overdue items, time-in-hand per person. Restricted by role.', 1),
  ('templates',      'Templates',                'Πρότυπα',                  'Use (read) or maintain (write) project and task templates.', 0),
  ('admin',          'Administration',           'Διαχείριση',               'People, roles, entities, departments, settings.', 1),
  ('audit',          'Audit log',                'Αρχείο ελέγχου',           'Read the human-readable audit trail for the scope.', 1),
  ('finance',        'Finance',                  'Οικονομικά',               'Budgets, commitments, payments (Phase 3).', 1),
  ('salaries',       'Person costs',             'Κόστος προσωπικού',        'Salary-level person-cost data (Phase 3). Entity-scoped by design.', 1),
  ('pipeline',       'Pipeline',                 'Προτάσεις',                'Opportunities and proposals (Phase 4).', 0),
  ('portfolio',      'Portfolio & dashboards',   'Χαρτοφυλάκιο',             'Management dashboards and portfolios (Phase 5).', 0),
  ('rules',          'Nudging rules',            'Κανόνες υπενθυμίσεων',     'Edit the rules engine (Phase 5).', 0);

-- Default access matrix. 0 none, 1 read, 2 write, 3 admin.
INSERT INTO role_module_access (role, module, level) VALUES
  ('super_admin','projects',3),('super_admin','project_create',3),('super_admin','people',3),('super_admin','people_metrics',3),
  ('super_admin','templates',3),('super_admin','admin',3),('super_admin','audit',3),('super_admin','finance',3),
  ('super_admin','salaries',3),('super_admin','pipeline',3),('super_admin','portfolio',3),('super_admin','rules',3),

  ('general_manager','projects',2),('general_manager','project_create',2),('general_manager','people',2),('general_manager','people_metrics',1),
  ('general_manager','templates',3),('general_manager','admin',1),('general_manager','audit',1),('general_manager','finance',1),
  ('general_manager','salaries',1),('general_manager','pipeline',3),('general_manager','portfolio',1),('general_manager','rules',3),

  ('upper_management','projects',1),('upper_management','project_create',2),('upper_management','people',1),('upper_management','people_metrics',1),
  ('upper_management','templates',1),('upper_management','audit',1),('upper_management','finance',1),
  ('upper_management','pipeline',2),('upper_management','portfolio',1),('upper_management','rules',1),

  ('department_head','projects',1),('department_head','project_create',2),('department_head','people',1),('department_head','people_metrics',1),
  ('department_head','templates',2),('department_head','pipeline',1),('department_head','portfolio',1),

  ('finance','projects',1),('finance','people',1),('finance','templates',1),('finance','audit',1),
  ('finance','finance',2),('finance','salaries',2),('finance','pipeline',1),('finance','portfolio',1),

  ('project_manager','project_create',2),('project_manager','people',1),('project_manager','templates',2),('project_manager','pipeline',1),

  ('team_member','people',1),('team_member','templates',1),

  ('auditor','projects',1),('auditor','people',1),('auditor','people_metrics',1),('auditor','templates',1),('auditor','audit',1),
  ('auditor','finance',1),('auditor','salaries',1),('auditor','pipeline',1),('auditor','portfolio',1);

INSERT INTO task_statuses (key, label_en, label_el, category, color, position) VALUES
  ('todo',        'To do',        'Προς υλοποίηση', 'todo',      '#6b7280', 1),
  ('in_progress', 'In progress',  'Σε εξέλιξη',     'active',    '#2563eb', 2),
  ('in_review',   'In review',    'Σε έλεγχο',      'active',    '#9333ea', 3),
  ('blocked',     'Waiting',      'Σε αναμονή',     'active',    '#d97706', 4),
  ('done',        'Done',         'Ολοκληρώθηκε',   'done',      '#16a34a', 5),
  ('cancelled',   'Cancelled',    'Ακυρώθηκε',      'cancelled', '#9ca3af', 6);

-- ============================================================================
-- from 004_password_sign_in.sql (password_credentials, dropped again in 005)
-- ============================================================================
-- Passwords were tried for a local install and removed: sign-in is a personal
-- link or Google only. Nothing remains from this migration.

-- ============================================================================
-- from 005_roles_modules_google.sql
-- ============================================================================
-- 005_roles_modules_google — the access model of the brief, and Google sign-in.
--
-- Access has two separate dimensions:
--   * a ROLE per person: super_admin, admin, member, supervisor;
--   * MODULE access: one row per person per module, read or write.
-- The sidebar is built from module access, so a person without a module
-- sees no page at all rather than a locked one. Supervisors (funders,
-- board, external evaluators) are additionally scoped to named projects.
-- Passwords are gone: sign-in is a personal link (hash only) or Google.

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

-- ============================================================================
-- from 006_crm.sql
-- ============================================================================
-- 006_crm — organisations and people, every message in and out, and the
-- machinery behind the four rules that do not bend:
--   1. A person always wins: manual_fields on every record says which fields
--      a human edited, by whom and when. No automated write overwrites one.
--   2. Disagreement is raised, not resolved: `conflicts` holds both values,
--      a one-sentence reason and the URL that was read. No URL, no conflict.
--   3. Never invent: a fact the source did not state is NULL.
--   4. Provenance everywhere: who added it, human or machine, the exact URL
--      read, the date (created_source / source_url / source_date).
-- Stages, organisation kinds and the free-mail-provider list are owned by
-- the server (src/lib/crm.js), not by CHECK constraints here.

-- Organisations: partners, prospects, funders, schools, host organisations.
-- Proposals, projects and KA1 courses point here rather than keeping their
-- own copy of an organisation's name and address.
CREATE TABLE organisations (
  id                      INTEGER PRIMARY KEY,
  name                    TEXT NOT NULL,
  short_name              TEXT,
  kind                    TEXT,                 -- server list: ngo, university, public, school, company, network, funder, other
  country                 TEXT,                 -- ISO 3166-1 alpha-2
  city                    TEXT,
  website                 TEXT,
  -- Two email fields on purpose. The general inbox (info@) is where a first
  -- contact goes; the named decision maker is who actually says yes. Mixing
  -- them is how a proposal invitation ends up unread in a shared inbox.
  general_email           TEXT,
  decision_maker_name     TEXT,
  decision_maker_email    TEXT,
  decision_maker_id       INTEGER REFERENCES contacts(id),
  -- For organisations that publish no address at all, only a web form.
  contact_form_url        TEXT,
  phone                   TEXT,
  pic                     TEXT,                 -- EU Participant Identification Code
  oid                     TEXT,                 -- Erasmus+ Organisation ID
  notes                   TEXT,                 -- Markdown
  -- Where the relationship stands. The stage list lives on the server; each
  -- stage carries `ours` (is the ball in our court?). The dashboard reads
  -- that flag, never the stage name.
  stage                   TEXT NOT NULL DEFAULT 'prospect',
  stage_changed_at        TEXT,
  owner_id                INTEGER REFERENCES users(id),  -- the KMOP person who looks after this relationship
  last_inbound_at         TEXT,                 -- maintained from messages; "unanswered" = inbound after outbound
  last_outbound_at        TEXT,
  manual_fields           TEXT NOT NULL DEFAULT '{}',  -- {field: {by, at}} — fields a human set; automation never overwrites them
  created_by              INTEGER REFERENCES users(id),
  created_source          TEXT NOT NULL DEFAULT 'human' CHECK (created_source IN ('human','machine')),
  source_url              TEXT,                 -- the exact URL read when a machine created or filled this
  source_date             TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at              TEXT
);
CREATE INDEX idx_organisations_name ON organisations(name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX idx_organisations_stage ON organisations(stage) WHERE deleted_at IS NULL;

-- People outside KMOP (staff are `users`). A person usually belongs to one
-- organisation; email is unique among live contacts so incoming mail can be
-- matched to exactly one person.
CREATE TABLE contacts (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT COLLATE NOCASE,
  phone            TEXT,
  role_title       TEXT,                        -- their job title at the organisation
  organisation_id  INTEGER REFERENCES organisations(id),
  country          TEXT,
  linkedin_url     TEXT,
  languages        TEXT,
  notes            TEXT,
  stage            TEXT NOT NULL DEFAULT 'prospect',
  stage_changed_at TEXT,
  owner_id         INTEGER REFERENCES users(id),
  last_inbound_at  TEXT,
  last_outbound_at TEXT,
  manual_fields    TEXT NOT NULL DEFAULT '{}',
  created_by       INTEGER REFERENCES users(id),
  created_source   TEXT NOT NULL DEFAULT 'human' CHECK (created_source IN ('human','machine')),
  source_url       TEXT,
  source_date      TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT
);
CREATE UNIQUE INDEX idx_contacts_email ON contacts(email) WHERE deleted_at IS NULL AND email IS NOT NULL;
CREATE INDEX idx_contacts_org ON contacts(organisation_id) WHERE deleted_at IS NULL;

-- Every message in and out, whatever the channel. The mailbox sync (a later
-- step) writes here; people log calls, meetings and form submissions by
-- hand. A message that could not be matched to anyone stays here with
-- status 'unmatched' — a queue a person can see and assign — rather than
-- being dropped or guessed.
CREATE TABLE messages (
  id               INTEGER PRIMARY KEY,
  direction        TEXT NOT NULL CHECK (direction IN ('in','out')),
  channel          TEXT NOT NULL DEFAULT 'email',   -- email | form | phone | meeting | other
  status           TEXT NOT NULL DEFAULT 'matched' CHECK (status IN ('matched','unmatched','ignored')),
  organisation_id  INTEGER REFERENCES organisations(id),
  contact_id       INTEGER REFERENCES contacts(id),
  project_id       INTEGER REFERENCES projects(id),
  subject          TEXT,
  body_text        TEXT,
  from_email       TEXT,
  to_emails        TEXT,                       -- comma-separated, as sent
  cc_emails        TEXT,
  sent_at          TEXT NOT NULL,              -- when it was sent or received, not when we stored it
  external_id      TEXT UNIQUE,                -- e.g. the Gmail message id, so a re-sync never duplicates
  thread_id        TEXT,
  -- How the message was tied to its record: by a person, by the exact
  -- address, by the thread, or by the sender's domain (never for free
  -- providers such as gmail.com — see src/lib/crm.js).
  matched_by       TEXT,                       -- human | address | thread | domain
  created_by       INTEGER REFERENCES users(id),
  created_source   TEXT NOT NULL DEFAULT 'human' CHECK (created_source IN ('human','machine')),
  source_url       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at       TEXT
);
CREATE INDEX idx_messages_org ON messages(organisation_id, sent_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_contact ON messages(contact_id, sent_at) WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_unmatched ON messages(status, sent_at) WHERE status = 'unmatched';

-- Disagreements between a person and a machine, raised and kept until a
-- person decides. The human value stays in force meanwhile. A conflict
-- without the URL that was read is refused: "the system thinks" is not a
-- source.
CREATE TABLE conflicts (
  id            INTEGER PRIMARY KEY,
  object_type   TEXT NOT NULL,                 -- organisation | contact | project | …
  object_id     INTEGER NOT NULL,
  field         TEXT NOT NULL,
  human_value   TEXT,
  machine_value TEXT,
  reason        TEXT NOT NULL,                 -- one sentence, written for the person who will decide
  source_url    TEXT NOT NULL CHECK (length(source_url) > 0),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','kept_human','took_machine')),
  raised_by     TEXT NOT NULL DEFAULT 'machine', -- which automation raised it
  raised_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_by   INTEGER REFERENCES users(id),
  resolved_at   TEXT
);
CREATE INDEX idx_conflicts_object ON conflicts(object_type, object_id) WHERE status = 'open';

-- Search covers the CRM too.
CREATE TRIGGER trg_organisations_fts_ins AFTER INSERT ON organisations BEGIN
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  VALUES ('organisation', NEW.id, NULL, NEW.name || COALESCE(' (' || NEW.short_name || ')', ''), COALESCE(NEW.city, '') || ' ' || COALESCE(NEW.notes, ''));
END;
CREATE TRIGGER trg_organisations_fts_upd AFTER UPDATE OF name, short_name, city, notes, deleted_at ON organisations BEGIN
  DELETE FROM search_fts WHERE object_type = 'organisation' AND object_id = OLD.id;
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  SELECT 'organisation', NEW.id, NULL, NEW.name || COALESCE(' (' || NEW.short_name || ')', ''), COALESCE(NEW.city, '') || ' ' || COALESCE(NEW.notes, '') WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER trg_contacts_fts_ins AFTER INSERT ON contacts BEGIN
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  VALUES ('contact', NEW.id, NULL, NEW.name, COALESCE(NEW.email, '') || ' ' || COALESCE(NEW.role_title, '') || ' ' || COALESCE(NEW.notes, ''));
END;
CREATE TRIGGER trg_contacts_fts_upd AFTER UPDATE OF name, email, role_title, notes, deleted_at ON contacts BEGIN
  DELETE FROM search_fts WHERE object_type = 'contact' AND object_id = OLD.id;
  INSERT INTO search_fts (object_type, object_id, project_id, title, body)
  SELECT 'contact', NEW.id, NULL, NEW.name, COALESCE(NEW.email, '') || ' ' || COALESCE(NEW.role_title, '') || ' ' || COALESCE(NEW.notes, '') WHERE NEW.deleted_at IS NULL;
END;
