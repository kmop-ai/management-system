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
