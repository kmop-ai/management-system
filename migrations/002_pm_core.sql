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
