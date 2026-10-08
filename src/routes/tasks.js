// The task engine: tasks, subtasks, followers, dependencies, checklists,
// labels, custom field values, recurrence.

import { ok, created, readJson, Validator, pageParams, sortClause, listMeta, param, intParam, idList, notFound, forbidden, badRequest, conflict, invalid } from '../lib/http.js';
import { first, all, insert, update, run, paged, nowIso, today, stmt, expectedVersion, jsonIds } from '../lib/db.js';
import { diff, describeChanges } from '../lib/audit.js';
import { loadProject, loadTask, userNames, taskUrl } from '../lib/load.js';
import { TASK_SELECT, TASK_FROM, decorate, statusCategory, isClosed, onTaskClosed, descendantIds, mentionedIds } from '../lib/tasks.js';
import { nextOccurrence, localParts, addDays } from '../lib/dates.js';

const SORTABLE = {
  position: 't.position', due: 't.due_date', start: 't.start_date', created: 't.created_at', updated: 't.updated_at',
  title: 't.title COLLATE NOCASE', assignee: 'ua.name', status: 'ts.position', project: 'p.name', completed: 't.completed_at',
  priority: `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
  section: 's.position',
};

// Builds WHERE for a task list from query parameters. Shared by the list,
// my-tasks and calendar endpoints so every view filters the same way.
function taskFilters(ctx, url) {
  const v = ctx.access.tasksVisibleSql('t', 'p');
  const where = ['t.deleted_at IS NULL', v.sql];
  const params = [...v.params];
  const projects = idList(url, 'project_id');
  if (projects) { where.push(`t.project_id IN (SELECT value FROM json_each(?))`); params.push(jsonIds(projects)); }
  if (param(url, 'personal') === '1') where.push('t.project_id IS NULL');
  if (param(url, 'archived') !== '1') where.push('(p.id IS NULL OR p.archived_at IS NULL)');
  const assignee = param(url, 'assignee');
  if (assignee === 'me') { where.push('t.assignee_id = ?'); params.push(ctx.user.id); }
  else if (assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (assignee) { where.push(`t.assignee_id IN (SELECT value FROM json_each(?))`); params.push(jsonIds(assignee.split(',').map(Number))); }
  const createdBy = param(url, 'created_by');
  if (createdBy) { where.push('t.created_by = ?'); params.push(createdBy === 'me' ? ctx.user.id : Number(createdBy)); }
  if (param(url, 'following') === '1') { where.push('EXISTS (SELECT 1 FROM task_followers f2 WHERE f2.task_id = t.id AND f2.user_id = ?)'); params.push(ctx.user.id); }
  const status = param(url, 'status');
  if (status) { where.push(`t.status IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(status.split(','))); }
  const state = param(url, 'state') || 'all';
  if (state === 'open') where.push('t.completed_at IS NULL');
  else if (state === 'done') where.push('t.completed_at IS NOT NULL');
  else if (state === 'recent') { where.push('(t.completed_at IS NULL OR t.completed_at >= ?)'); params.push(new Date(Date.now() - 7 * 86400000).toISOString()); }
  const priority = param(url, 'priority');
  if (priority) { where.push(`t.priority IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(priority.split(','))); }
  const section = param(url, 'section_id');
  if (section === 'none') where.push('t.section_id IS NULL');
  else if (section) { where.push('t.section_id = ?'); params.push(Number(section)); }
  const parent = param(url, 'parent');
  if (parent === 'none') where.push('t.parent_id IS NULL');
  else if (parent) { where.push('t.parent_id = ?'); params.push(Number(parent)); }
  const label = idList(url, 'label_id');
  if (label) { where.push(`EXISTS (SELECT 1 FROM task_labels tl2 WHERE tl2.task_id = t.id AND tl2.label_id IN (SELECT value FROM json_each(?)))`); params.push(jsonIds(label)); }
  const dueFrom = param(url, 'due_from'); if (dueFrom) { where.push('t.due_date >= ?'); params.push(dueFrom); }
  const dueTo = param(url, 'due_to'); if (dueTo) { where.push('t.due_date <= ?'); params.push(dueTo); }
  if (param(url, 'overdue') === '1') { where.push('t.completed_at IS NULL AND t.due_date < ?'); params.push(today()); }
  if (param(url, 'no_due') === '1') where.push('t.due_date IS NULL');
  if (param(url, 'milestone') === '1') where.push('t.is_milestone = 1');
  // Tasks overlapping a date window (timeline, calendar, workload).
  const rf = param(url, 'range_from'), rt = param(url, 'range_to');
  if (rf && rt) {
    where.push('COALESCE(t.start_date, t.due_date) <= ? AND COALESCE(t.due_date, t.start_date) >= ?'); params.push(rt, rf);
  }
  const q = param(url, 'q'); if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  // Custom field filters: field.12=value (exact, or option key contained in a multiselect)
  for (const [k, val] of url.searchParams) {
    const m = /^field\.(\d+)$/.exec(k);
    if (!m) continue;
    where.push(`EXISTS (SELECT 1 FROM task_field_values fv2 WHERE fv2.task_id = t.id AND fv2.field_id = ?
                AND (json_extract(fv2.value, '$') = ? OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_type(fv2.value) = 'array' THEN fv2.value ELSE '[]' END) WHERE value = ?)))`);
    params.push(Number(m[1]), isNaN(Number(val)) ? val : Number(val), val);
  }
  return { where, params };
}

async function list(ctx) {
  const { url } = ctx;
  const pg = pageParams(url, { defaultLimit: 100, maxLimit: 500 });
  const { where, params } = taskFilters(ctx, url);
  const fallback = param(url, 'project_id') ? 'section,position' : 'due,priority';
  const { total, rows } = await paged(ctx.env.DB, {
    select: TASK_SELECT, from: TASK_FROM, where, params, order: sortClause(url, SORTABLE, fallback) + ', t.id', ...pg,
  });
  return ok(rows.map(decorate), listMeta(total, pg, rows.length));
}

// My Tasks: everything assigned to me that is open (plus what I closed
// today), bucketed by my local date. One query; the buckets are computed
// here so every client agrees on what "today" means for a person in Athens
// vs one in Brussels.
async function myTasks(ctx) {
  const tz = ctx.user.timezone || (await first(ctx.env.DB, `SELECT timezone FROM entities WHERE id = ?`, ctx.user.entity_id))?.timezone;
  const local = localParts(tz).date;
  const v = ctx.access.tasksVisibleSql('t', 'p');
  const userId = param(ctx.url, 'user_id') ? Number(param(ctx.url, 'user_id')) : ctx.user.id;
  if (userId !== ctx.user.id) throw forbidden('My Tasks shows your own tasks');
  const rows = (await all(ctx.env.DB, `SELECT ${TASK_SELECT} FROM ${TASK_FROM}
     WHERE t.deleted_at IS NULL AND ${v.sql} AND t.assignee_id = ?
       AND (p.id IS NULL OR p.archived_at IS NULL)
       AND (t.completed_at IS NULL OR substr(t.completed_at, 1, 10) >= ?)
     ORDER BY t.due_date IS NULL, t.due_date, t.id LIMIT 1000`, ...v.params, userId, addDays(local, -1))).map(decorate);
  const soon = addDays(local, 7);
  const buckets = { overdue: [], today: [], upcoming: [], later: [], no_date: [], done_today: [] };
  for (const r of rows) {
    if (r.completed_at) buckets.done_today.push(r);
    else if (!r.due_date) buckets.no_date.push(r);
    else if (r.due_date < local) buckets.overdue.push(r);
    else if (r.due_date === local) buckets.today.push(r);
    else if (r.due_date <= soon) buckets.upcoming.push(r);
    else buckets.later.push(r);
  }
  return ok({ today: local, buckets });
}

// ---- detail --------------------------------------------------------------

async function taskDetail(ctx, id) {
  const db = ctx.env.DB;
  const v = ctx.access.tasksVisibleSql('t', 'p');
  const [row, ancestors, subtasks, blockers, blocking, checklist, followers, rec, fields] = await db.batch([
    db.prepare(`SELECT ${TASK_SELECT}, t.description, t.completed_by, uc.name AS completed_by_name, ucr.name AS created_by_name
                  FROM ${TASK_FROM} LEFT JOIN users uc ON uc.id = t.completed_by LEFT JOIN users ucr ON ucr.id = t.created_by WHERE t.id = ?`).bind(id),
    db.prepare(`WITH RECURSIVE a(id, parent_id, title, depth) AS (
                  SELECT id, parent_id, title, 0 FROM tasks WHERE id = (SELECT parent_id FROM tasks WHERE id = ?)
                  UNION ALL SELECT t.id, t.parent_id, t.title, a.depth + 1 FROM tasks t JOIN a ON t.id = a.parent_id WHERE a.depth < 20)
                SELECT id, title FROM a ORDER BY depth DESC`).bind(id),
    db.prepare(`SELECT ${TASK_SELECT} FROM ${TASK_FROM} WHERE t.parent_id = ? AND t.deleted_at IS NULL AND ${v.sql} ORDER BY t.position, t.id`).bind(id, ...v.params),
    db.prepare(`SELECT d.blocker_id AS id, d.lag_days, b.title, b.status, b.due_date, b.completed_at, b.project_id, ub.name AS assignee_name
                  FROM task_dependencies d JOIN tasks b ON b.id = d.blocker_id LEFT JOIN users ub ON ub.id = b.assignee_id
                 WHERE d.blocked_id = ? AND b.deleted_at IS NULL`).bind(id),
    db.prepare(`SELECT d.blocked_id AS id, d.lag_days, b.title, b.status, b.due_date, b.completed_at, b.project_id, ub.name AS assignee_name
                  FROM task_dependencies d JOIN tasks b ON b.id = d.blocked_id LEFT JOIN users ub ON ub.id = b.assignee_id
                 WHERE d.blocker_id = ? AND b.deleted_at IS NULL`).bind(id),
    db.prepare(`SELECT id, text, done, done_by, done_at, position, updated_at FROM checklist_items WHERE task_id = ? AND deleted_at IS NULL ORDER BY position, id`).bind(id),
    db.prepare(`SELECT f.user_id, f.reason, u.name FROM task_followers f JOIN users u ON u.id = f.user_id WHERE f.task_id = ? ORDER BY u.name`).bind(id),
    db.prepare(`SELECT r.* FROM recurrences r JOIN tasks t ON t.recurrence_id = r.id WHERE t.id = ?`).bind(id),
    db.prepare(`SELECT fv.field_id, fv.value FROM task_field_values fv WHERE fv.task_id = ?`).bind(id),
  ]);
  const t = decorate(row.results[0]);
  t.ancestors = ancestors.results;
  t.subtasks = subtasks.results.map(decorate);
  t.blocked_by = blockers.results;
  t.blocking = blocking.results;
  t.checklist = checklist.results;
  t.followers = followers.results;
  t.recurrence = rec.results[0] || null;
  t.fields = Object.fromEntries(fields.results.map(f => [f.field_id, JSON.parse(f.value)]));
  t.following = t.followers.some(f => f.user_id === ctx.user.id);
  return t;
}

async function getTask(ctx, { id }) {
  const { task, project, ta } = await loadTask(ctx, id);
  const t = await taskDetail(ctx, task.id);
  t.access = ta;
  t.project = project ? { id: project.id, name: project.name, code: project.code, start_date: project.start_date, end_date: project.end_date, entity_id: project.entity_id } : null;
  return ok(t);
}

// ---- create --------------------------------------------------------------

const taskFields = (v) => v
  .string('title', { min: 1, max: 500, nullable: false }).text('description', { max: 50000 })
  .string('status', { max: 40, nullable: false }).oneOf('priority', ['none', 'low', 'medium', 'high', 'urgent'])
  .int('assignee_id').int('section_id').int('parent_id').int('project_id')
  .date('start_date').date('due_date').number('estimate_hours', { min: 0, max: 2000 })
  .bool('is_milestone').bool('is_internal').number('position');

async function assertAssignable(ctx, projectId, userId) {
  if (userId == null) return;
  if (!projectId) {
    if (userId !== ctx.user.id) throw invalid({ assignee_id: 'personal tasks can only be assigned to yourself — add the task to a project to assign it to someone else' });
    return;
  }
  const m = await first(ctx.env.DB, `SELECT 1 AS x FROM project_members m JOIN users u ON u.id = m.user_id
    WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL AND m.role <> 'viewer' AND u.active = 1`, projectId, userId);
  if (!m) throw invalid({ assignee_id: 'the assignee must be a member of the project' });
}

async function assertSection(ctx, projectId, sectionId) {
  if (sectionId == null) return;
  const s = await first(ctx.env.DB, `SELECT project_id FROM sections WHERE id = ? AND deleted_at IS NULL`, sectionId);
  if (!s || s.project_id !== projectId) throw invalid({ section_id: 'section does not belong to this project' });
}

// Validate and apply custom field values: { fieldId: value }.
async function fieldStmts(ctx, projectId, taskId, values) {
  if (!values || typeof values !== 'object') return [];
  const defs = await all(ctx.env.DB, `SELECT * FROM custom_fields WHERE project_id = ? AND deleted_at IS NULL`, projectId ?? -1);
  const byId = Object.fromEntries(defs.map(d => [d.id, d]));
  const out = [], errors = {};
  for (const [fid, raw] of Object.entries(values)) {
    const d = byId[fid];
    if (!d) { errors[`fields.${fid}`] = 'unknown field for this project'; continue; }
    if (raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) {
      out.push(stmt(ctx.env.DB, `DELETE FROM task_field_values WHERE task_id = ? AND field_id = ?`, taskId, d.id));
      continue;
    }
    let val = raw, num = null;
    const opts = d.options ? JSON.parse(d.options).map(o => o.key) : [];
    if (d.type === 'number') { val = Number(raw); if (!Number.isFinite(val)) { errors[`fields.${fid}`] = 'must be a number'; continue; } num = val; }
    else if (d.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { errors[`fields.${fid}`] = 'must be a date'; continue; } num = Date.parse(raw) / 86400000; }
    else if (d.type === 'checkbox') { val = !!raw; num = val ? 1 : 0; }
    else if (d.type === 'user') { val = Number(raw); if (!Number.isInteger(val)) { errors[`fields.${fid}`] = 'must be a person'; continue; } num = val; }
    else if (d.type === 'select') { if (!opts.includes(raw)) { errors[`fields.${fid}`] = 'not one of the options'; continue; } }
    else if (d.type === 'multiselect') { if (!Array.isArray(raw) || !raw.every(x => opts.includes(x))) { errors[`fields.${fid}`] = 'not among the options'; continue; } }
    else { val = String(raw).slice(0, 2000); }
    out.push(stmt(ctx.env.DB, `INSERT INTO task_field_values (task_id, field_id, value, value_num) VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, field_id) DO UPDATE SET value = excluded.value, value_num = excluded.value_num`, taskId, d.id, JSON.stringify(val), num));
  }
  if (Object.keys(errors).length) throw invalid(errors);
  return out;
}

async function labelStmts(ctx, projectId, taskId, labelIds, replace = true) {
  if (!labelIds) return [];
  const ok = labelIds.length ? await all(ctx.env.DB, `SELECT id FROM labels WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND (project_id IS NULL OR project_id IS ?)`, jsonIds(labelIds), projectId ?? null) : [];
  if (ok.length !== labelIds.length) throw invalid({ label_ids: 'unknown label for this project' });
  const out = replace ? [stmt(ctx.env.DB, `DELETE FROM task_labels WHERE task_id = ?`, taskId)] : [];
  for (const l of ok) out.push(stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_labels (task_id, label_id) VALUES (?, ?)`, taskId, l.id));
  return out;
}

function mentionStmts(ctx, task, text, before = '') {
  const prev = new Set(mentionedIds(before));
  const ids = mentionedIds(text).filter(x => !prev.has(x));
  if (!ids.length) return { stmts: [], ids };
  const stmts = ids.map(uid => stmt(ctx.env.DB, `INSERT INTO mentions (object_type, object_id, user_id, author_id) VALUES ('task', ?, ?, ?)`, task.id, uid, ctx.user.id));
  for (const uid of ids) stmts.push(stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'mentioned')`, task.id, uid));
  return { stmts, ids };
}

export async function createTaskRow(ctx, v, extra = {}) {
  const db = ctx.env.DB;
  if (v.position == null) {
    v.position = (await first(db, `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id IS ? AND section_id IS ? AND parent_id IS ?`,
      v.project_id ?? null, v.section_id ?? null, v.parent_id ?? null)).p;
  }
  const cat = await statusCategory(db, v.status || 'todo');
  if (!cat) throw invalid({ status: 'unknown status' });
  const row = {
    ...v, status: v.status || 'todo', created_by: ctx.user.id,
    assigned_at: v.assignee_id ? nowIso() : null,
    completed_at: isClosed(cat) ? nowIso() : null, completed_by: isClosed(cat) ? ctx.user.id : null,
    ...extra,
  };
  return insert(db, 'tasks', row);
}

async function createTask(ctx) {
  const body = await readJson(ctx.req);
  const v = taskFields(new Validator(body)).ids('label_ids').ids('follower_ids').done();
  if (!v.title) throw invalid({ title: 'required' });
  const labelIds = v.label_ids, followerIds = v.follower_ids || []; delete v.label_ids; delete v.follower_ids;
  let project = null;
  if (v.parent_id) {
    const { task: parent, project: pp } = await loadTask(ctx, v.parent_id, 'edit');
    v.project_id = parent.project_id; project = pp;
    if (v.section_id === undefined) v.section_id = null;
    if (v.is_internal === undefined) v.is_internal = parent.is_internal;
  }
  if (v.project_id) {
    const r = await loadProject(ctx, v.project_id, 'work');
    project = r.project;
    await assertSection(ctx, project.id, v.section_id);
  } else { v.section_id = null; v.is_internal = 0; }
  if (v.assignee_id === undefined && !v.project_id) v.assignee_id = ctx.user.id; // a personal task is mine
  await assertAssignable(ctx, v.project_id, v.assignee_id);
  if (v.start_date && v.due_date && v.due_date < v.start_date) throw invalid({ due_date: 'is before the start date' });
  // Validate labels and custom fields before anything is written.
  await labelStmts(ctx, v.project_id, 0, labelIds);
  await fieldStmts(ctx, v.project_id, 0, body.fields);

  const id = await createTaskRow(ctx, v);
  const task = { id, ...v };
  const stmts = [
    stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'creator')`, id, ctx.user.id),
    ...(v.assignee_id ? [stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'assignee')`, id, v.assignee_id)] : []),
    ...followerIds.map(uid => stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) SELECT ?, id, 'manual' FROM users WHERE id = ?`, id, uid)),
    ...await labelStmts(ctx, v.project_id, id, labelIds),
    ...await fieldStmts(ctx, v.project_id, id, body.fields),
  ];
  const m = mentionStmts(ctx, task, v.description);
  stmts.push(...m.stmts);
  if (Array.isArray(body.checklist)) body.checklist.slice(0, 100).forEach((text, i) => {
    if (typeof text === 'string' && text.trim()) stmts.push(stmt(ctx.env.DB, `INSERT INTO checklist_items (task_id, text, position) VALUES (?, ?, ?)`, id, text.trim().slice(0, 500), i + 1));
  });
  await ctx.env.DB.batch(stmts);

  const where = project ? ` in ${project.name}` : ' (personal)';
  ctx.audit({ action: 'create', type: 'task', id, label: v.title, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} created the task "${v.title}"${where}` });
  ctx.activity({ verb: v.parent_id ? 'subtask.created' : 'task.created', type: 'task', id, project_id: project?.id, task_id: v.parent_id || id, payload: { title: v.title } });
  if (v.assignee_id) ctx.notify([v.assignee_id], { kind: 'assigned', object_type: 'task', object_id: id, project_id: project?.id, title: v.title, body: v.due_date ? `Due ${v.due_date}` : null, url: taskUrl(id) });
  if (m.ids.length) ctx.notify(m.ids, { kind: 'mentioned', object_type: 'task', object_id: id, project_id: project?.id, title: v.title, body: v.description?.slice(0, 200), url: taskUrl(id) });
  ctx.touchProject(project?.id);
  const t = await taskDetail(ctx, id);
  t.access = ctx.access.task(t, project);
  return created(t);
}

// ---- update --------------------------------------------------------------

// What an assignee-only editor (a guest working on their own task) may change.
const ASSIGNEE_ONLY_FIELDS = ['status', 'completed', 'estimate_hours'];

async function patchTask(ctx, { id }) {
  const { task, project, ta } = await loadTask(ctx, id, 'edit');
  const body = await readJson(ctx.req);
  const v = taskFields(new Validator(body)).ids('label_ids').bool('completed').done();
  const fullEdit = !project || ctx.access.project(project).work;
  if (!fullEdit) {
    const extra = Object.keys(v).filter(k => !ASSIGNEE_ONLY_FIELDS.includes(k));
    if (extra.length || body.fields) throw forbidden('You can update the status of tasks assigned to you, but not edit them');
  }
  const db = ctx.env.DB;
  const labelIds = v.label_ids; delete v.label_ids;
  const completed = v.completed; delete v.completed;
  const stmts = [];

  // Moving to another project takes subtasks along and drops project-scoped bits.
  let target = project;
  if (v.project_id !== undefined && v.project_id !== task.project_id) {
    if (task.parent_id && v.parent_id === undefined) throw badRequest('Move the parent task, or detach this subtask first');
    if (v.project_id) target = (await loadProject(ctx, v.project_id, 'work')).project; else target = null;
    if (v.section_id === undefined) v.section_id = null;
    const desc = await descendantIds(db, task.id);
    stmts.push(stmt(db, `UPDATE tasks SET project_id = ?, section_id = NULL WHERE id IN (SELECT value FROM json_each(?))`, v.project_id, jsonIds(desc)));
    stmts.push(stmt(db, `DELETE FROM task_labels WHERE task_id IN (SELECT value FROM json_each(?)) AND label_id IN (SELECT id FROM labels WHERE project_id IS NOT NULL)`, jsonIds([task.id, ...desc])));
    stmts.push(stmt(db, `DELETE FROM task_field_values WHERE task_id IN (SELECT value FROM json_each(?))`, jsonIds([task.id, ...desc])));
    if (!v.project_id) { v.is_internal = 0; if (task.assignee_id !== ctx.user.id) v.assignee_id = ctx.user.id; }
  }
  const projectId = v.project_id !== undefined ? v.project_id : task.project_id;
  if (v.section_id !== undefined && v.section_id !== task.section_id) await assertSection(ctx, projectId, v.section_id);
  if (v.assignee_id !== undefined && v.assignee_id !== task.assignee_id) await assertAssignable(ctx, projectId, v.assignee_id);
  if (v.parent_id !== undefined && v.parent_id !== task.parent_id && v.parent_id != null) {
    if (v.parent_id === task.id) throw badRequest('A task cannot be its own parent');
    const { task: parent } = await loadTask(ctx, v.parent_id, 'edit');
    if (parent.project_id !== projectId) throw badRequest('A subtask must be in the same project as its parent');
    const desc = await descendantIds(db, task.id);
    if (desc.includes(v.parent_id)) throw badRequest('That would make the task a subtask of its own subtask');
  }
  const start = v.start_date !== undefined ? v.start_date : task.start_date, due = v.due_date !== undefined ? v.due_date : task.due_date;
  if (start && due && due < start) throw invalid({ due_date: 'is before the start date' });

  // Completion: `completed` is a shortcut; status categories are the truth.
  if (completed !== undefined && v.status === undefined) {
    v.status = completed ? 'done' : (isClosed(await statusCategory(db, task.status)) ? 'todo' : task.status);
  }
  let closedNow = false, reopened = false;
  if (v.status !== undefined && v.status !== task.status) {
    const [before, after] = [await statusCategory(db, task.status), await statusCategory(db, v.status)];
    if (!after) throw invalid({ status: 'unknown status' });
    if (isClosed(after) && !isClosed(before)) { v.completed_at = nowIso(); v.completed_by = ctx.user.id; closedNow = true; }
    if (!isClosed(after) && isClosed(before)) { v.completed_at = null; v.completed_by = null; reopened = true; }
  }
  if (v.assignee_id !== undefined && v.assignee_id !== task.assignee_id) v.assigned_at = v.assignee_id ? nowIso() : null;

  const changes = diff(task, v);
  delete changes.completed_at; delete changes.completed_by; delete changes.assigned_at;
  // Build (and so validate) label and field writes before touching the row.
  const labelWrites = await labelStmts(ctx, projectId, task.id, labelIds);
  const fieldWrites = await fieldStmts(ctx, projectId, task.id, body.fields);
  if (Object.keys(v).length || labelIds || body.fields) await update(db, 'tasks', task.id, v, { expected: expectedVersion(ctx.req, body) });
  stmts.push(...labelWrites, ...fieldWrites);
  if (v.assignee_id) stmts.push(stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'assignee')`, task.id, v.assignee_id));
  const m = v.description !== undefined ? mentionStmts(ctx, task, v.description, task.description) : { stmts: [], ids: [] };
  stmts.push(...m.stmts);
  if (stmts.length) await db.batch(stmts);

  const tgt = target || project;
  const names = changes.assignee_id ? { assignee_id: await userNames(db, changes.assignee_id) } : {};
  if (Object.keys(changes).length || labelIds || body.fields) {
    const what = describeChanges(changes, names) || (labelIds ? 'changed labels' : 'changed custom fields');
    ctx.audit({ action: 'update', type: 'task', id: task.id, label: task.title, entity_id: tgt?.entity_id, project_id: tgt?.id,
      summary: `${ctx.user.name} updated the task "${task.title}": ${what}`, changes });
  }
  const payload = { title: v.title || task.title, changes };
  if (closedNow) ctx.activity({ verb: 'task.completed', type: 'task', id: task.id, project_id: tgt?.id, task_id: task.parent_id || task.id, payload });
  else if (reopened) ctx.activity({ verb: 'task.reopened', type: 'task', id: task.id, project_id: tgt?.id, task_id: task.id, payload });
  else if (Object.keys(changes).length) ctx.activity({ verb: 'task.updated', type: 'task', id: task.id, project_id: tgt?.id, task_id: task.id, payload });

  if (changes.assignee_id && v.assignee_id) {
    ctx.notify([v.assignee_id], { kind: 'assigned', object_type: 'task', object_id: task.id, project_id: tgt?.id, title: v.title || task.title, body: due ? `Due ${due}` : null, url: taskUrl(task.id) });
  }
  if (m.ids.length) ctx.notify(m.ids, { kind: 'mentioned', object_type: 'task', object_id: task.id, project_id: tgt?.id, title: task.title, body: v.description.slice(0, 200), url: taskUrl(task.id) });
  if (closedNow) {
    const followers = (await all(db, `SELECT user_id FROM task_followers WHERE task_id = ?`, task.id)).map(r => r.user_id);
    // People waiting on this task hear that it is done.
    const unblocked = (await all(db, `SELECT b.assignee_id FROM task_dependencies d JOIN tasks b ON b.id = d.blocked_id WHERE d.blocker_id = ? AND b.completed_at IS NULL AND b.deleted_at IS NULL AND b.assignee_id IS NOT NULL`, task.id)).map(r => r.assignee_id);
    ctx.notify([...followers, ...unblocked], { kind: 'completed', object_type: 'task', object_id: task.id, project_id: tgt?.id, title: task.title, url: taskUrl(task.id) });
    const next = await onTaskClosed(db, { ...task, ...v }, ctx.user.id);
    if (next) ctx.activity({ verb: 'task.recurred', type: 'task', id: next, project_id: tgt?.id, task_id: next, payload: { title: task.title } });
  }
  ctx.touchProject(tgt?.id);
  const t = await taskDetail(ctx, task.id);
  t.access = ta;
  return ok(t);
}

async function deleteTask(ctx, { id }) {
  const { task, project, ta } = await loadTask(ctx, id, 'edit');
  if (project && !ctx.access.project(project).work) throw forbidden();
  const at = nowIso();
  const desc = await descendantIds(ctx.env.DB, task.id);
  await run(ctx.env.DB, `UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`, at, at, jsonIds([task.id, ...desc]));
  ctx.audit({ action: 'delete', type: 'task', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id,
    summary: `${ctx.user.name} deleted the task "${task.title}"${desc.length ? ` and its ${desc.length} subtask(s)` : ''} (restorable)` });
  ctx.activity({ verb: 'task.deleted', type: 'task', id: task.id, project_id: project?.id, task_id: task.parent_id || task.id, payload: { title: task.title } });
  ctx.touchProject(project?.id);
  return ok({ id: task.id, deleted: true, deleted_at: at, subtasks: desc.length, manage: ta.manage });
}

async function restoreTask(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit', { withDeleted: true });
  if (!task.deleted_at) return ok(await taskDetail(ctx, task.id));
  // Restore exactly what was deleted with it, not subtasks deleted earlier on purpose.
  const desc = await descendantIds(ctx.env.DB, task.id, { includeDeleted: true, deletedAt: task.deleted_at });
  await run(ctx.env.DB, `UPDATE tasks SET deleted_at = NULL, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`, nowIso(), jsonIds([task.id, ...desc]));
  ctx.audit({ action: 'restore', type: 'task', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} restored the task "${task.title}"` });
  ctx.touchProject(project?.id);
  return ok(await taskDetail(ctx, task.id));
}

async function duplicateTask(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  if (project && !ctx.access.project(project).work) throw forbidden();
  const db = ctx.env.DB;
  const copy = async (src, parentId, prefix) => {
    const nid = await createTaskRow(ctx, {
      project_id: src.project_id, parent_id: parentId, section_id: src.section_id, title: prefix + src.title, description: src.description,
      status: 'todo', priority: src.priority, assignee_id: src.assignee_id, start_date: src.start_date, due_date: src.due_date,
      estimate_hours: src.estimate_hours, is_milestone: src.is_milestone, is_internal: src.is_internal, position: src.position + 0.5,
    });
    await db.batch([
      stmt(db, `INSERT INTO task_labels (task_id, label_id) SELECT ?, label_id FROM task_labels WHERE task_id = ?`, nid, src.id),
      stmt(db, `INSERT INTO checklist_items (task_id, text, position) SELECT ?, text, position FROM checklist_items WHERE task_id = ? AND deleted_at IS NULL`, nid, src.id),
      stmt(db, `INSERT INTO task_field_values (task_id, field_id, value, value_num) SELECT ?, field_id, value, value_num FROM task_field_values WHERE task_id = ?`, nid, src.id),
      stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'creator')`, nid, ctx.user.id),
    ]);
    const kids = await all(db, `SELECT * FROM tasks WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position`, src.id);
    for (const k of kids) await copy(k, nid, '');
    return nid;
  };
  const nid = await copy(task, task.parent_id, 'Copy of ');
  ctx.audit({ action: 'create', type: 'task', id: nid, label: 'Copy of ' + task.title, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} duplicated the task "${task.title}"` });
  ctx.touchProject(project?.id);
  return created(await taskDetail(ctx, nid));
}

// ---- followers -----------------------------------------------------------

async function follow(ctx, { id }) {
  const { task } = await loadTask(ctx, id);
  const body = ctx.req.headers.get('content-type')?.includes('json') ? await readJson(ctx.req) : {};
  const uid = body.user_id ? Number(body.user_id) : ctx.user.id;
  if (uid !== ctx.user.id) {
    await loadTask(ctx, id, 'edit');
    const target = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL`, uid);
    if (!target) throw notFound('Person not found');
    // Only add people who could see the task anyway; following must never widen access.
    if (task.project_id && !await first(ctx.env.DB, `SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL`, task.project_id, uid)) {
      throw invalid({ user_id: 'only project members can follow this task' });
    }
    if (!task.project_id) throw invalid({ user_id: 'personal tasks cannot have other followers' });
  }
  await run(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'manual')`, task.id, uid);
  return ok((await taskDetail(ctx, task.id)).followers);
}

async function unfollow(ctx, { id, userId }) {
  const { task } = await loadTask(ctx, id);
  const uid = Number(userId);
  if (uid !== ctx.user.id) await loadTask(ctx, id, 'edit');
  await run(ctx.env.DB, `DELETE FROM task_followers WHERE task_id = ? AND user_id = ?`, task.id, uid);
  return ok((await taskDetail(ctx, task.id)).followers);
}

// ---- dependencies --------------------------------------------------------

async function addDependency(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  const v = new Validator(await readJson(ctx.req)).int('blocker_id', { required: true }).int('lag_days', { min: -365, max: 365 }).done();
  if (v.blocker_id === task.id) throw badRequest('A task cannot block itself');
  const { task: blocker } = await loadTask(ctx, v.blocker_id);
  // Refuse cycles: if this task already (transitively) blocks the blocker,
  // the new edge would close a loop and the timeline would have no answer.
  const cycle = await first(ctx.env.DB, `WITH RECURSIVE down(x) AS (
      SELECT blocked_id FROM task_dependencies WHERE blocker_id = ?
      UNION SELECT d.blocked_id FROM task_dependencies d JOIN down ON d.blocker_id = down.x)
    SELECT 1 AS hit FROM down WHERE x = ? LIMIT 1`, task.id, blocker.id);
  if (cycle) throw conflict(`"${blocker.title}" already waits on this task, directly or through others. Adding this would create a loop.`);
  await run(ctx.env.DB, `INSERT INTO task_dependencies (blocker_id, blocked_id, lag_days, created_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET lag_days = excluded.lag_days`, blocker.id, task.id, v.lag_days || 0, ctx.user.id);
  ctx.audit({ action: 'create', type: 'dependency', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id,
    summary: `${ctx.user.name} marked "${task.title}" as blocked by "${blocker.title}"` });
  ctx.activity({ verb: 'dependency.added', type: 'task', id: task.id, project_id: project?.id, task_id: task.id, payload: { blocker: blocker.title, blocker_id: blocker.id } });
  ctx.touchProject(project?.id);
  const t = await taskDetail(ctx, task.id);
  return created({ blocked_by: t.blocked_by, blocking: t.blocking });
}

async function removeDependency(ctx, { id, blockerId }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  const r = await run(ctx.env.DB, `DELETE FROM task_dependencies WHERE blocker_id = ? AND blocked_id = ?`, Number(blockerId), task.id);
  if (!r.meta.changes) throw notFound('Dependency not found');
  ctx.audit({ action: 'delete', type: 'dependency', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id,
    summary: `${ctx.user.name} removed a dependency from "${task.title}" (was blocked by task #${blockerId})` });
  const t = await taskDetail(ctx, task.id);
  return ok({ blocked_by: t.blocked_by, blocking: t.blocking });
}

async function projectDependencies(ctx, { id }) {
  const { project, pa } = await loadProject(ctx, id);
  const rows = await all(ctx.env.DB, `SELECT d.blocker_id, d.blocked_id, d.lag_days FROM task_dependencies d
      JOIN tasks a ON a.id = d.blocker_id JOIN tasks b ON b.id = d.blocked_id
     WHERE (a.project_id = ? OR b.project_id = ?) AND a.deleted_at IS NULL AND b.deleted_at IS NULL
       ${pa.guest ? 'AND a.is_internal = 0 AND b.is_internal = 0' : ''}`, project.id, project.id);
  return ok(rows);
}

// ---- checklist -----------------------------------------------------------

async function addChecklist(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  const v = new Validator(await readJson(ctx.req)).string('text', { required: true, max: 500 }).number('position').done();
  if (v.position == null) v.position = ((await first(ctx.env.DB, `SELECT MAX(position) AS m FROM checklist_items WHERE task_id = ?`, task.id)).m || 0) + 1;
  const cid = await insert(ctx.env.DB, 'checklist_items', { task_id: task.id, ...v });
  ctx.activity({ verb: 'checklist.added', type: 'task', id: task.id, project_id: project?.id, task_id: task.id, payload: { text: v.text } });
  ctx.audit({ action: 'create', type: 'checklist_item', id: cid, label: v.text, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} added "${v.text}" to the checklist of "${task.title}"` });
  ctx.touchProject(project?.id);
  return created(await first(ctx.env.DB, `SELECT * FROM checklist_items WHERE id = ?`, cid));
}

async function loadChecklistItem(ctx, id) {
  const c = await first(ctx.env.DB, `SELECT * FROM checklist_items WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!c) throw notFound('Checklist item not found');
  return { item: c, ...(await loadTask(ctx, c.task_id, 'edit')) };
}

async function patchChecklist(ctx, { id }) {
  const { item, task, project } = await loadChecklistItem(ctx, id);
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('text', { max: 500, nullable: false }).bool('done').number('position', { nullable: false }).done();
  if (v.done !== undefined && v.done !== item.done) { v.done_by = v.done ? ctx.user.id : null; v.done_at = v.done ? nowIso() : null; }
  await update(ctx.env.DB, 'checklist_items', item.id, v, { expected: expectedVersion(ctx.req, body) });
  const changes = diff(item, v); delete changes.done_by; delete changes.done_at; delete changes.position;
  if (Object.keys(changes).length) {
    ctx.audit({ action: 'update', type: 'checklist_item', id: item.id, label: item.text, entity_id: project?.entity_id, project_id: project?.id,
      summary: v.done !== undefined && Object.keys(changes).length === 1 ? `${ctx.user.name} ${v.done ? 'ticked' : 'unticked'} "${item.text}" on "${task.title}"` : `${ctx.user.name} edited a checklist item on "${task.title}": ${describeChanges(changes)}`, changes });
  }
  ctx.touchProject(project?.id);
  return ok(await first(ctx.env.DB, `SELECT * FROM checklist_items WHERE id = ?`, item.id));
}

async function deleteChecklist(ctx, { id }) {
  const { item, task, project } = await loadChecklistItem(ctx, id);
  await run(ctx.env.DB, `UPDATE checklist_items SET deleted_at = ? WHERE id = ?`, nowIso(), item.id);
  ctx.audit({ action: 'delete', type: 'checklist_item', id: item.id, label: item.text, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} removed "${item.text}" from the checklist of "${task.title}"` });
  return ok({ id: item.id, deleted: true });
}

// ---- labels --------------------------------------------------------------

async function listLabels(ctx) {
  const project = intParam(ctx.url, 'project_id');
  if (project) await loadProject(ctx, project);
  return ok(await all(ctx.env.DB, `SELECT l.*, (SELECT COUNT(*) FROM task_labels tl WHERE tl.label_id = l.id) AS uses FROM labels l
    WHERE l.deleted_at IS NULL AND (l.project_id IS NULL ${project ? 'OR l.project_id = ?' : ''}) ORDER BY l.name`, ...(project ? [project] : [])));
}

async function createLabel(ctx) {
  const v = new Validator(await readJson(ctx.req)).string('name', { required: true, max: 60 }).string('color', { max: 20 }).int('project_id').done();
  let project = null;
  if (v.project_id) project = (await loadProject(ctx, v.project_id, 'work')).project;
  else if (ctx.access.level('templates') < 2) throw forbidden('Organisation-wide labels need template write access; add a project label instead');
  const lid = await insert(ctx.env.DB, 'labels', v);
  ctx.audit({ action: 'create', type: 'label', id: lid, label: v.name, project_id: project?.id, entity_id: project?.entity_id, summary: `${ctx.user.name} created the label "${v.name}"${project ? ` in ${project.name}` : ' for everyone'}` });
  return created(await first(ctx.env.DB, `SELECT * FROM labels WHERE id = ?`, lid));
}

async function loadLabel(ctx, id) {
  const l = await first(ctx.env.DB, `SELECT * FROM labels WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!l) throw notFound('Label not found');
  if (l.project_id) await loadProject(ctx, l.project_id, 'work');
  else if (ctx.access.level('templates') < 2) throw forbidden();
  return l;
}

async function patchLabel(ctx, { id }) {
  const l = await loadLabel(ctx, id);
  const v = new Validator(await readJson(ctx.req)).string('name', { max: 60, nullable: false }).string('color', { max: 20, nullable: false }).done();
  const changes = diff(l, v);
  if (Object.keys(changes).length) {
    await run(ctx.env.DB, `UPDATE labels SET ${Object.keys(v).map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(v), l.id);
    ctx.audit({ action: 'update', type: 'label', id: l.id, label: l.name, project_id: l.project_id, summary: `${ctx.user.name} edited the label "${l.name}": ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM labels WHERE id = ?`, l.id));
}

async function deleteLabel(ctx, { id }) {
  const l = await loadLabel(ctx, id);
  await run(ctx.env.DB, `UPDATE labels SET deleted_at = ? WHERE id = ?`, nowIso(), l.id);
  ctx.audit({ action: 'delete', type: 'label', id: l.id, label: l.name, project_id: l.project_id, summary: `${ctx.user.name} deleted the label "${l.name}"` });
  return ok({ id: l.id, deleted: true });
}

// ---- custom fields -------------------------------------------------------

function cleanOptions(type, options) {
  if (!['select', 'multiselect'].includes(type)) return null;
  if (!Array.isArray(options) || !options.length) throw invalid({ options: 'select fields need at least one option' });
  return JSON.stringify(options.map((o, i) => {
    const label = typeof o === 'string' ? o : o.label;
    if (!label) throw invalid({ options: 'every option needs a label' });
    return { key: (typeof o === 'object' && o.key) || label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 40) || `opt${i}`, label: String(label).slice(0, 80), color: (typeof o === 'object' && o.color) || null };
  }));
}

async function listFields(ctx, { id }) {
  const { project } = await loadProject(ctx, id);
  const rows = await all(ctx.env.DB, `SELECT * FROM custom_fields WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id`, project.id);
  for (const r of rows) r.options = r.options ? JSON.parse(r.options) : null;
  return ok(rows);
}

async function createField(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { required: true, max: 80 })
    .oneOf('type', ['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url'], { required: true }).number('position').done();
  v.options = cleanOptions(v.type, body.options);
  if (v.position == null) v.position = ((await first(ctx.env.DB, `SELECT MAX(position) AS m FROM custom_fields WHERE project_id = ?`, project.id)).m || 0) + 1;
  const fid = await insert(ctx.env.DB, 'custom_fields', { project_id: project.id, ...v });
  ctx.audit({ action: 'create', type: 'custom_field', id: fid, label: v.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} added the custom field "${v.name}" (${v.type}) to ${project.name}` });
  const f = await first(ctx.env.DB, `SELECT * FROM custom_fields WHERE id = ?`, fid);
  f.options = f.options ? JSON.parse(f.options) : null;
  return created(f);
}

async function patchField(ctx, { id }) {
  const f = await first(ctx.env.DB, `SELECT * FROM custom_fields WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!f) throw notFound('Field not found');
  const { project } = await loadProject(ctx, f.project_id, 'manage');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { max: 80, nullable: false }).number('position', { nullable: false }).done();
  if (body.options !== undefined) v.options = cleanOptions(f.type, body.options);
  const changes = diff(f, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'custom_fields', f.id, v, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'custom_field', id: f.id, label: f.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} edited the custom field "${f.name}"`, changes });
  }
  const out = await first(ctx.env.DB, `SELECT * FROM custom_fields WHERE id = ?`, f.id);
  out.options = out.options ? JSON.parse(out.options) : null;
  return ok(out);
}

async function deleteField(ctx, { id }) {
  const f = await first(ctx.env.DB, `SELECT * FROM custom_fields WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!f) throw notFound('Field not found');
  const { project } = await loadProject(ctx, f.project_id, 'manage');
  // Values are kept (soft delete) so restoring the field restores the data.
  await run(ctx.env.DB, `UPDATE custom_fields SET deleted_at = ? WHERE id = ?`, nowIso(), f.id);
  ctx.audit({ action: 'delete', type: 'custom_field', id: f.id, label: f.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} removed the custom field "${f.name}" from ${project.name}` });
  return ok({ id: f.id, deleted: true });
}

// ---- recurrence ----------------------------------------------------------

async function setRecurrence(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  const body = await readJson(ctx.req);
  const v = new Validator(body).oneOf('freq', ['daily', 'weekly', 'monthly', 'yearly'], { required: true }).int('interval_n', { min: 1, max: 52 })
    .string('by_weekday', { max: 7 }).int('by_monthday', { min: -1, max: 28 }).oneOf('mode', ['schedule', 'completion']).date('until_date').done();
  if (v.by_weekday && !/^[1-7]+$/.test(v.by_weekday)) throw invalid({ by_weekday: 'ISO weekdays, e.g. 135' });
  if (v.by_monthday === 0) throw invalid({ by_monthday: '1–28, or -1 for the last day' });
  const rule = { interval_n: 1, mode: 'schedule', ...v };
  const base = task.due_date || today();
  rule.next_due = nextOccurrence(rule, base);
  const db = ctx.env.DB;
  if (task.recurrence_id) {
    await run(db, `UPDATE recurrences SET freq = ?, interval_n = ?, by_weekday = ?, by_monthday = ?, mode = ?, until_date = ?, next_due = ?, source_task_id = ?, ended_at = NULL WHERE id = ?`,
      rule.freq, rule.interval_n, rule.by_weekday ?? null, rule.by_monthday ?? null, rule.mode, rule.until_date ?? null, rule.next_due, task.id, task.recurrence_id);
  } else {
    const rid = await insert(db, 'recurrences', { ...rule, source_task_id: task.id, created_by: ctx.user.id });
    await run(db, `UPDATE tasks SET recurrence_id = ?, updated_at = ? WHERE id = ?`, rid, nowIso(), task.id);
    if (!task.due_date) await run(db, `UPDATE tasks SET due_date = ? WHERE id = ?`, base, task.id);
  }
  ctx.audit({ action: 'update', type: 'task', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id,
    summary: `${ctx.user.name} made "${task.title}" repeat ${rule.freq}${rule.interval_n > 1 ? ` every ${rule.interval_n}` : ''} (${rule.mode === 'completion' ? 'after each completion' : 'on schedule'})` });
  return ok((await taskDetail(ctx, task.id)).recurrence);
}

async function clearRecurrence(ctx, { id }) {
  const { task, project } = await loadTask(ctx, id, 'edit');
  if (!task.recurrence_id) return ok(null);
  await ctx.env.DB.batch([
    stmt(ctx.env.DB, `UPDATE recurrences SET ended_at = ? WHERE id = ?`, nowIso(), task.recurrence_id),
    stmt(ctx.env.DB, `UPDATE tasks SET recurrence_id = NULL, updated_at = ? WHERE id = ?`, nowIso(), task.id),
  ]);
  ctx.audit({ action: 'update', type: 'task', id: task.id, label: task.title, entity_id: project?.entity_id, project_id: project?.id, summary: `${ctx.user.name} stopped "${task.title}" from repeating` });
  return ok(null);
}

// Bulk edit from multi-select: same rules as PATCH, applied per task.
async function bulk(ctx) {
  const body = await readJson(ctx.req);
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 200) : [];
  if (!ids.length) throw badRequest('ids is required');
  const results = [];
  for (const id of ids) {
    const sub = new Request(ctx.req.url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.patch || {}) });
    const subCtx = { ...ctx, req: sub };
    try { await patchTask(subCtx, { id }); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.code || 'error', message: e.message }); }
  }
  return ok(results);
}

export default [
  ['GET', '/api/tasks', list],
  ['POST', '/api/tasks', createTask],
  ['PATCH', '/api/tasks', bulk],
  ['GET', '/api/my-tasks', myTasks],
  ['GET', '/api/tasks/:id', getTask],
  ['PATCH', '/api/tasks/:id', patchTask],
  ['DELETE', '/api/tasks/:id', deleteTask],
  ['POST', '/api/tasks/:id/restore', restoreTask],
  ['POST', '/api/tasks/:id/duplicate', duplicateTask],
  ['POST', '/api/tasks/:id/followers', follow],
  ['DELETE', '/api/tasks/:id/followers/:userId', unfollow],
  ['POST', '/api/tasks/:id/dependencies', addDependency],
  ['DELETE', '/api/tasks/:id/dependencies/:blockerId', removeDependency],
  ['GET', '/api/projects/:id/dependencies', projectDependencies],
  ['POST', '/api/tasks/:id/checklist', addChecklist],
  ['PATCH', '/api/checklist/:id', patchChecklist],
  ['DELETE', '/api/checklist/:id', deleteChecklist],
  ['PUT', '/api/tasks/:id/recurrence', setRecurrence],
  ['DELETE', '/api/tasks/:id/recurrence', clearRecurrence],
  ['GET', '/api/labels', listLabels],
  ['POST', '/api/labels', createLabel],
  ['PATCH', '/api/labels/:id', patchLabel],
  ['DELETE', '/api/labels/:id', deleteLabel],
  ['GET', '/api/projects/:id/fields', listFields],
  ['POST', '/api/projects/:id/fields', createField],
  ['PATCH', '/api/fields/:id', patchField],
  ['DELETE', '/api/fields/:id', deleteField],
];
