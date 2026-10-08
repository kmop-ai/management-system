// The modules (sidebar pages) — owned by the server. Module access is one
// row per person per module (read | write); the sidebar is built from it, so
// a person without a module never sees the page at all.
//
// Navigation has three levels and never four: sidebar groups → pages → tabs
// inside a record. `group` is the sidebar group; `route` is the hash route;
// `built: false` keeps a page out of every sidebar until it exists, so
// nobody is ever shown a dead link.

export const ROLES = ['super_admin', 'admin', 'member', 'supervisor'];

export const GROUPS = ['main', 'projects', 'development', 'relationships', 'oversight', 'work', 'system'];

export const MODULES = [
  { key: 'dashboard',     group: 'main',          route: '#/dashboard',     built: false },
  { key: 'projects',      group: 'projects',      route: '#/projects',      built: true },
  { key: 'ka1',           group: 'projects',      route: '#/ka1',           built: false },
  { key: 'proposals',     group: 'development',   route: '#/proposals',     built: false },
  { key: 'calls',         group: 'development',   route: '#/calls',         built: false },
  { key: 'partners',      group: 'development',   route: '#/partners',      built: false },
  { key: 'organisations', group: 'relationships', route: '#/organisations', built: false },
  { key: 'people',        group: 'relationships', route: '#/contacts',      built: false },
  { key: 'reporting',     group: 'oversight',     route: '#/reporting',     built: false },
  { key: 'evaluation',    group: 'oversight',     route: '#/evaluation',    built: false },
  { key: 'tasks',         group: 'work',          route: '#/my-tasks',      built: true },
  // Team and Access: super admin only, whatever the grants say.
  { key: 'team',          group: 'system',        route: '#/team',          built: true, superAdminOnly: true },
  // How to use this: everyone, no grant needed.
  { key: 'help',          group: 'system',        route: '#/help',          built: true, everyone: true },
];

export const MODULE_KEYS = MODULES.map(m => m.key);
export const GRANTABLE = MODULES.filter(m => !m.superAdminOnly && !m.everyone).map(m => m.key);

// What a new person from an allowed domain gets on first sign-in. Admins
// widen it in Team and Access.
export const DEFAULT_MEMBER_GRANTS = { dashboard: 'write', projects: 'write', tasks: 'write' };

// Supervisors may only ever read. Their grants are clamped to read here and
// in the API, whatever is stored.
export const SUPERVISOR_MODULES = ['dashboard', 'projects', 'ka1', 'reporting', 'evaluation'];
