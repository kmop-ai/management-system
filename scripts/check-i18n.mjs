#!/usr/bin/env node
// Fails if the interface uses a string key that is missing from
// public/lib/strings.js, or if any key lacks English or Greek.
//
// Scans public/ and src/ for t('key') / t("key") with a literal key.
// Dynamic keys (t('task.priority_' + p)) are listed in DYNAMIC below with
// every value they can take, so they are checked too.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STRINGS } from '../public/lib/strings.js';

const root = new URL('..', import.meta.url).pathname;
const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (!['node_modules', '.wrangler', '.git'].includes(f)) walk(p); }
    else if (p.endsWith('.js') || p.endsWith('.mjs')) files.push(p);
  }
})(join(root, 'public'));
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})(join(root, 'src'));

const used = new Map();
const re = /\bt\(\s*(?:L\s*,\s*|[a-zA-Z_.]+\.locale\s*,\s*)?['"]([a-z0-9_]+\.[a-z0-9_.]+)['"]/g;
for (const f of files) {
  if (f.endsWith('strings.js')) continue;
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(re)) if (!m[1].endsWith('_') && !m[1].endsWith('.') && !used.has(m[1])) used.set(m[1], f.replace(root, ''));
  // keys kept in data tables: ['…', 'shortcut.search'] etc.
  for (const m of src.matchAll(/['"]((?:shortcut|help)\.[a-z0-9_]+)['"]/g)) if (!m[1].endsWith('_') && !used.has(m[1])) used.set(m[1], f.replace(root, ''));
}

// Keys built at runtime: prefix → possible suffixes.
const DYNAMIC = {
  'page.': ['dashboard', 'projects', 'ka1', 'proposals', 'calls', 'partners', 'organisations', 'people', 'reporting', 'evaluation', 'tasks', 'team', 'help'],
  'navgroup.': ['projects', 'development', 'relationships', 'oversight'],
  'role.': ['super_admin', 'admin', 'member', 'supervisor'],
  'team.tab_': ['people', 'signins', 'integrations', 'organisation'],
  'team.access_': ['none', 'read', 'write'],
  'team.method_': ['email', 'google'],
  'team.outcome_': ['sent', 'send_failed', 'unknown_email', 'domain_not_allowed', 'inactive', 'rate_limited', 'denied', 'signed_in'],
  'team.mailbox_': ['connected', 'not_connected', 'error'],
  'help.h_': ['signin', 'sidebar', 'roles', 'supervisors', 'admin'],
  'task.priority_': ['none', 'low', 'medium', 'high', 'urgent'],
  'project.status_': ['planning', 'active', 'on_hold', 'closing', 'closed'],
  'project.kind_': ['eu', 'national', 'internal', 'other'],
  'project.role_': ['pm', 'member', 'viewer', 'guest', 'coordinator', 'partner', 'sole_beneficiary', 'contractor'],
  'project.scope_': ['all', 'mine'],
  'project.tab_': ['tasks', 'workload', 'members', 'files', 'activity', 'settings'],
  'coll.state_': ['open', 'recent', 'done', 'all'],
  'coll.due_': ['overdue', 'week', 'month', 'none'],
  'coll.group_': ['section', 'status', 'due', 'assignee', 'priority', 'project', 'none'],
  'coll.view_': ['list', 'board', 'timeline', 'calendar'],
  'coll.bucket_': ['overdue', 'today', 'week', 'later', 'nodate', 'done'],
  'task.rec_': ['daily', 'weekly', 'monthly', 'yearly'],
  'task.rec_unit_': ['daily', 'weekly', 'monthly', 'yearly'],
  'settings.theme_': ['system', 'light', 'dark'],
  'field.type_': ['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url'],
  'notif.': ['assigned', 'mentioned', 'commented', 'due_soon', 'overdue', 'completed', 'added_to_project', 'nudge'],
  'activity.': ['project_created', 'project_updated', 'task_created', 'subtask_created', 'task_completed', 'task_reopened', 'task_updated', 'task_deleted', 'task_recurred',
    'comment_added', 'member_added', 'member_removed', 'dependency_added', 'checklist_added', 'attachment_added'],
};
for (const [prefix, values] of Object.entries(DYNAMIC)) for (const v of values) if (!used.has(prefix + v)) used.set(prefix + v, '(dynamic)');

let bad = 0;
for (const [k, where] of [...used].sort()) {
  if (!STRINGS[k]) { console.error(`missing  ${k}   (${where})`); bad++; }
}
for (const [k, v] of Object.entries(STRINGS)) {
  if (!Array.isArray(v) || v.length !== 2 || !v[0] || !v[1]) { console.error(`incomplete  ${k}  — needs [English, Greek]`); bad++; }
}
const unused = Object.keys(STRINGS).filter(k => !used.has(k));
if (process.argv.includes('--unused')) for (const k of unused) console.log(`unused  ${k}`);
if (bad) { console.error(`\n${bad} i18n problem(s).`); process.exit(1); }
console.log(`i18n OK: ${Object.keys(STRINGS).length} strings, ${used.size} used keys, EN + EL complete.`);
