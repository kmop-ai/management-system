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
