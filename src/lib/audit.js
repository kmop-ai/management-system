// Audit log and activity stream.
//
// Routes call ctx.audit(...) and ctx.activity(...) as they work; the
// statements are queued on the request context and written in one batch
// when the handler returns successfully (see worker.js). A handler that
// throws leaves no audit row for a write that did not happen.

import { stmt } from './db.js';

// Field-level before/after for the fields that actually changed.
export function diff(before, after, fields) {
  const out = {};
  for (const f of fields || Object.keys(after)) {
    if (!(f in after)) continue;
    const a = before ? before[f] : undefined;
    const b = after[f];
    if ((a ?? null) !== (b ?? null)) out[f] = [a ?? null, b ?? null];
  }
  return out;
}

const FIELD_LABELS = {
  title: 'title', name: 'name', status: 'status', priority: 'priority', assignee_id: 'assignee',
  due_date: 'due date', start_date: 'start date', end_date: 'end date', estimate_hours: 'estimate',
  section_id: 'section', parent_id: 'parent task', description: 'description', project_id: 'project',
  entity_id: 'entity', department_id: 'department', role: 'role', is_internal: 'internal flag',
  visibility: 'visibility', active: 'active', email: 'email', weekly_hours: 'weekly hours',
};

// Turns a diff into readable clauses: "changed due date from 2026-10-12 to
// 2026-10-19; changed status from todo to done". names maps ids to labels
// (assignee ids to people's names) so the sentence reads without lookups.
export function describeChanges(changes, names = {}) {
  const parts = [];
  for (const [k, [a, b]] of Object.entries(changes)) {
    if (k === 'updated_at' || k === 'position') continue;
    const label = FIELD_LABELS[k] || k.replace(/_/g, ' ');
    const show = (v) => v == null || v === '' ? 'nothing' : (names[k] && names[k][v]) || (typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '…' : String(v));
    if (k === 'description') parts.push('edited the description');
    else if (a == null || a === '') parts.push(`set ${label} to ${show(b)}`);
    else if (b == null || b === '') parts.push(`cleared ${label} (was ${show(a)})`);
    else parts.push(`changed ${label} from ${show(a)} to ${show(b)}`);
  }
  return parts.join('; ');
}

export function auditStmt(ctx, e) {
  return stmt(ctx.env.DB,
    `INSERT INTO audit_log (actor_id, action, object_type, object_id, object_label, entity_id, project_id, summary, changes, ip, request_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.actor_id !== undefined ? e.actor_id : (ctx.user ? ctx.user.id : null),
    e.action, e.type, e.id ?? null, e.label ?? null, e.entity_id ?? null, e.project_id ?? null,
    e.summary, e.changes && Object.keys(e.changes).length ? JSON.stringify(e.changes) : null,
    ctx.ip || null, ctx.requestId || null);
}

export function activityStmt(ctx, e) {
  return stmt(ctx.env.DB,
    `INSERT INTO activity (actor_id, verb, object_type, object_id, project_id, task_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ctx.user ? ctx.user.id : null, e.verb, e.type, e.id, e.project_id ?? null, e.task_id ?? null,
    e.payload ? JSON.stringify(e.payload) : null);
}

export function actorName(ctx) {
  return ctx.user ? ctx.user.name : 'System';
}
