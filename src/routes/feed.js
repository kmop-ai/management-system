// Read side of the shared streams: audit log, activity, inbox.

import { ok, pageParams, listMeta, param, intParam, sortClause, notFound, forbidden } from '../lib/http.js';
import { all, first, run, paged, nowIso } from '../lib/db.js';
import { READ } from '../lib/rbac.js';
import { loadProject, loadTask } from '../lib/load.js';

// The audit log, readable by humans: filter by person, object, project,
// entity, date range and free text over the summaries. Scope: the 'audit'
// module (entity-scoped rows), plus the PMs of a project for that project.
async function auditList(ctx) {
  const { url, access } = ctx;
  const pg = pageParams(url, { defaultLimit: 100, maxLimit: 500 });
  const where = [], params = [];
  const project = intParam(url, 'project_id');
  if (project) {
    const { pa } = await loadProject(ctx, project);
    if (!pa.manage && access.level('audit') < READ) throw forbidden('Only project managers and auditors can read this project\'s audit trail');
    where.push('a.project_id = ?'); params.push(project);
  } else {
    const s = access.scope('audit', READ);
    if (!s.entities.length) throw forbidden('Requires access to the audit log');
    // Rows without an entity (logins, role changes, settings) are only for
    // people whose audit access covers every entity.
    where.push(`(a.entity_id IN (SELECT value FROM json_each(?)) ${s.all ? 'OR a.entity_id IS NULL' : ''}
                 OR a.project_id IN (SELECT id FROM projects WHERE entity_id IN (SELECT value FROM json_each(?))))`);
    params.push(JSON.stringify(s.entities), JSON.stringify(s.entities));
  }
  const actor = intParam(url, 'actor_id'); if (actor) { where.push('a.actor_id = ?'); params.push(actor); }
  const type = param(url, 'object_type'); if (type) { where.push('a.object_type = ?'); params.push(type); }
  const oid = intParam(url, 'object_id'); if (oid) { where.push('a.object_id = ?'); params.push(oid); }
  const action = param(url, 'action'); if (action) { where.push('a.action = ?'); params.push(action); }
  const entity = intParam(url, 'entity_id'); if (entity) { where.push('a.entity_id = ?'); params.push(entity); }
  const from = param(url, 'from'); if (from) { where.push('a.at >= ?'); params.push(from); }
  const to = param(url, 'to'); if (to) { where.push('a.at < ?'); params.push(to.length === 10 ? to + 'T99' : to); }
  const q = param(url, 'q'); if (q) { where.push('(a.summary LIKE ? OR a.object_label LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const { total, rows } = await paged(ctx.env.DB, {
    select: `a.*, u.name AS actor_name, p.name AS project_name, e.code AS entity_code`,
    from: `audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN entities e ON e.id = a.entity_id`,
    where, params, order: sortClause(url, { at: 'a.at', id: 'a.id' }, '-id'), ...pg,
  });
  for (const r of rows) r.changes = r.changes ? JSON.parse(r.changes) : null;
  return ok(rows, listMeta(total, pg, rows.length));
}

// CSV export of the same filtered audit trail, for auditors. Exporting is
// itself audited.
async function auditExport(ctx) {
  ctx.url.searchParams.set('limit', '500');
  const all = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    ctx.url.searchParams.set('offset', String(offset));
    const r = await (await auditList(ctx)).json();
    all.push(...r.data);
    if (r.meta.next_offset == null) break;
  }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['at', 'actor', 'action', 'object_type', 'object_id', 'object', 'entity', 'project', 'summary'].join(',')];
  for (const r of all) lines.push([r.at, r.actor_name || 'System', r.action, r.object_type, r.object_id, r.object_label, r.entity_code, r.project_name, r.summary].map(esc).join(','));
  ctx.audit({ action: 'export', type: 'audit_log', summary: `${ctx.user.name} exported ${all.length} audit entries as CSV` });
  return new Response(lines.join('\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="kmop-hq-audit-${nowIso().slice(0, 10)}.csv"` } });
}

// Activity feed for a project or a task.
async function activityList(ctx) {
  const { url } = ctx;
  const pg = pageParams(url, { defaultLimit: 50 });
  const where = [], params = [];
  const task = intParam(url, 'task_id'), project = intParam(url, 'project_id');
  if (task) { await loadTask(ctx, task); where.push('a.task_id = ?'); params.push(task); }
  else if (project) {
    const { pa } = await loadProject(ctx, project);
    where.push('a.project_id = ?'); params.push(project);
    if (pa.guest) { where.push(`(a.task_id IS NULL OR a.task_id IN (SELECT id FROM tasks WHERE project_id = ? AND is_internal = 0))`); params.push(project); }
  } else {
    // Everything visible to me: activity on projects I can see.
    const pv = ctx.access.projectsVisibleSql('p');
    where.push(`a.project_id IN (SELECT p.id FROM projects p WHERE p.deleted_at IS NULL AND ${pv.sql})`);
    params.push(...pv.params);
  }
  const { total, rows } = await paged(ctx.env.DB, {
    select: `a.*, u.name AS actor_name, p.name AS project_name, t.title AS task_title`,
    from: `activity a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN tasks t ON t.id = a.task_id`,
    where, params, order: 'a.id DESC', ...pg,
  });
  for (const r of rows) r.payload = r.payload ? JSON.parse(r.payload) : null;
  return ok(rows, listMeta(total, pg, rows.length));
}

// ---- inbox ---------------------------------------------------------------

async function inbox(ctx) {
  const { url } = ctx;
  const pg = pageParams(url, { defaultLimit: 50 });
  const where = ['n.user_id = ?'], params = [ctx.user.id];
  const box = param(url, 'box') || 'inbox';
  if (box === 'inbox') where.push('n.archived_at IS NULL');
  else if (box === 'unread') where.push('n.archived_at IS NULL AND n.read_at IS NULL');
  else if (box === 'archived') where.push('n.archived_at IS NOT NULL');
  const kind = param(url, 'kind'); if (kind) { where.push('n.kind = ?'); params.push(kind); }
  const { total, rows } = await paged(ctx.env.DB, {
    select: `n.*, a.name AS actor_name, p.name AS project_name, p.code AS project_code`,
    from: `notifications n LEFT JOIN users a ON a.id = n.actor_id LEFT JOIN projects p ON p.id = n.project_id`,
    where, params, order: 'n.created_at DESC, n.id DESC', ...pg,
  });
  const unread = await first(ctx.env.DB, `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL`, ctx.user.id);
  return ok(rows, { ...listMeta(total, pg, rows.length), unread: unread.n });
}

async function count(ctx) {
  const r = await first(ctx.env.DB, `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL`, ctx.user.id);
  return ok({ unread: r.n });
}

async function mark(ctx, id, sql) {
  const r = await run(ctx.env.DB, `UPDATE notifications SET ${sql} WHERE id = ? AND user_id = ?`, nowIso(), Number(id), ctx.user.id);
  if (!r.meta.changes) throw notFound('Notification not found');
  return ok({ id: Number(id) });
}

const read = (ctx, { id }) => mark(ctx, id, 'read_at = COALESCE(read_at, ?)');
const unread = async (ctx, { id }) => {
  const r = await run(ctx.env.DB, `UPDATE notifications SET read_at = NULL WHERE id = ? AND user_id = ?`, Number(id), ctx.user.id);
  if (!r.meta.changes) throw notFound('Notification not found');
  return ok({ id: Number(id) });
};
const archive = (ctx, { id }) => mark(ctx, id, 'archived_at = ?, read_at = COALESCE(read_at, archived_at)');

async function readAll(ctx) {
  const r = await run(ctx.env.DB, `UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`, nowIso(), ctx.user.id);
  return ok({ updated: r.meta.changes });
}

async function archiveRead(ctx) {
  const r = await run(ctx.env.DB, `UPDATE notifications SET archived_at = ? WHERE user_id = ? AND read_at IS NOT NULL AND archived_at IS NULL`, nowIso(), ctx.user.id);
  return ok({ updated: r.meta.changes });
}

export default [
  ['GET', '/api/audit', auditList],
  ['GET', '/api/audit/export', auditExport],
  ['GET', '/api/activity', activityList],
  ['GET', '/api/notifications', inbox],
  ['GET', '/api/notifications/count', count],
  ['POST', '/api/notifications/read-all', readAll],
  ['POST', '/api/notifications/archive-read', archiveRead],
  ['POST', '/api/notifications/:id/read', read],
  ['POST', '/api/notifications/:id/unread', unread],
  ['POST', '/api/notifications/:id/archive', archive],
];
