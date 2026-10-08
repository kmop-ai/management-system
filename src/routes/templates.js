// Project and task templates.
//
// A project template body is one JSON document:
// {
//   "sections":      [{ "name": "Preparation" }],
//   "labels":        [{ "name": "partner", "color": "#0ea5e9" }],
//   "custom_fields": [{ "name": "Lead partner", "type": "text" }],
//   "tasks": [{
//     "key": "kickoff",                 // unique in the template; used by blocked_by and to trace tasks back
//     "title": "Kick-off meeting",
//     "section": "Preparation",         // section name
//     "start_offset": 0, "due_offset": 30,   // days from project start …
//     "due_month": 2,                   // … or a project month (due on the last day of M2)
//     "estimate_hours": 6, "priority": "high", "is_milestone": false, "is_internal": false,
//     "assign": "creator",              // optional: assign to whoever applies the template
//     "labels": ["partner"], "checklist": ["Book room", "Send agenda"],
//     "blocked_by": ["consortium-call"],
//     "subtasks": [ …same shape… ]
//   }]
// }
// Day offsets keep a template honest across projects that start in
// different months; due_month matches how EU work plans are written.

import { ok, created, readJson, Validator, pageParams, listMeta, param, intParam, notFound, forbidden, invalid } from '../lib/http.js';
import { first, all, insert, update, run, paged, nowIso, today, stmt, expectedVersion, parseJson } from '../lib/db.js';
import { READ, WRITE } from '../lib/rbac.js';
import { loadProject, taskUrl } from '../lib/load.js';
import { addDays, daysBetween, addMonths, toDate, fmt } from '../lib/dates.js';
import { createTaskRow } from './tasks.js';

function lastDayOfProjectMonth(start, m) {
  const first = addMonths(start.slice(0, 8) + '01', m - 1);
  const d = toDate(first); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
  return fmt(d);
}

function flatten(tasks, parentKey = null, out = []) {
  for (const t of tasks || []) {
    out.push({ ...t, parentKey });
    flatten(t.subtasks, t.key, out);
  }
  return out;
}

export function validateBody(body) {
  if (!body || typeof body !== 'object') throw invalid({ body: 'must be an object' });
  const flat = flatten(body.tasks);
  const keys = new Set();
  flat.forEach((t, i) => {
    if (!t.title || typeof t.title !== 'string') throw invalid({ [`tasks[${i}].title`]: 'required' });
    if (!t.key) t.key = `t${i + 1}`;
    if (keys.has(t.key)) throw invalid({ [`tasks[${i}].key`]: `duplicate key ${t.key}` });
    keys.add(t.key);
  });
  for (const t of flat) for (const b of t.blocked_by || []) if (!keys.has(b)) throw invalid({ blocked_by: `unknown task key ${b}` });
  return flat;
}

// Applies a template to an existing (usually new, empty) project in three
// batches: sections/labels/fields, tasks, then links (parents, dependencies,
// checklists, labels) resolved through template_key in SQL.
export async function applyProjectTemplate(ctx, templateId, projectId, startDate) {
  const tpl = await first(ctx.env.DB, `SELECT * FROM project_templates WHERE id = ? AND deleted_at IS NULL`, templateId);
  if (!tpl) throw notFound('Template not found');
  const body = parseJson(tpl.body, {});
  const flat = validateBody(body);
  const db = ctx.env.DB;
  const start = startDate || today();
  const prefix = `tpl${tpl.id}:`;

  const b1 = [];
  (body.sections || []).forEach((s, i) => b1.push(stmt(db, `INSERT INTO sections (project_id, name, position) VALUES (?, ?, ?)`, projectId, String(s.name).slice(0, 120), i + 1)));
  for (const l of body.labels || []) b1.push(stmt(db, `INSERT INTO labels (project_id, name, color) VALUES (?, ?, ?)`, projectId, String(l.name).slice(0, 60), l.color || '#6b7280'));
  (body.custom_fields || []).forEach((f, i) => b1.push(stmt(db, `INSERT INTO custom_fields (project_id, name, type, options, position) VALUES (?, ?, ?, ?, ?)`,
    projectId, String(f.name).slice(0, 80), f.type || 'text', f.options ? JSON.stringify(f.options) : null, i + 1)));
  if (b1.length) await db.batch(b1);

  const b2 = flat.map((t, i) => {
    const due = t.due_month ? lastDayOfProjectMonth(start, t.due_month) : t.due_offset != null ? addDays(start, t.due_offset) : null;
    const st = t.start_month ? addMonths(start.slice(0, 8) + '01', t.start_month - 1) : t.start_offset != null ? addDays(start, t.start_offset) : null;
    return stmt(db, `INSERT INTO tasks (project_id, section_id, title, description, status, priority, assignee_id, assigned_at, start_date, due_date,
        estimate_hours, is_milestone, is_internal, position, template_key, created_by)
      VALUES (?, (SELECT id FROM sections WHERE project_id = ? AND name = ? AND deleted_at IS NULL ORDER BY id LIMIT 1), ?, ?, 'todo', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, projectId, t.section || null, String(t.title).slice(0, 500), t.description || null,
      ['none', 'low', 'medium', 'high', 'urgent'].includes(t.priority) ? t.priority : 'none',
      t.assign === 'creator' ? ctx.user.id : null, t.assign === 'creator' ? nowIso() : null,
      st && due && st > due ? due : st, due, t.estimate_hours ?? null, t.is_milestone ? 1 : 0, t.is_internal ? 1 : 0, i + 1, prefix + t.key, ctx.user.id);
  });
  for (let i = 0; i < b2.length; i += 50) await db.batch(b2.slice(i, i + 50));

  const byKey = `(SELECT id FROM tasks WHERE project_id = ? AND template_key = ? LIMIT 1)`;
  const b3 = [];
  for (const t of flat) {
    const k = prefix + t.key;
    if (t.parentKey) b3.push(stmt(db, `UPDATE tasks SET parent_id = ${byKey}, section_id = NULL WHERE project_id = ? AND template_key = ?`, projectId, prefix + t.parentKey, projectId, k));
    for (const b of t.blocked_by || []) b3.push(stmt(db, `INSERT OR IGNORE INTO task_dependencies (blocker_id, blocked_id, created_by) VALUES (${byKey}, ${byKey}, ?)`, projectId, prefix + b, projectId, k, ctx.user.id));
    (t.checklist || []).forEach((c, i) => b3.push(stmt(db, `INSERT INTO checklist_items (task_id, text, position) VALUES (${byKey}, ?, ?)`, projectId, k, String(c).slice(0, 500), i + 1)));
    for (const l of t.labels || []) b3.push(stmt(db, `INSERT OR IGNORE INTO task_labels (task_id, label_id) SELECT ${byKey}, id FROM labels WHERE project_id = ? AND name = ? AND deleted_at IS NULL`, projectId, k, projectId, l));
    b3.push(stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (${byKey}, ?, 'creator')`, projectId, k, ctx.user.id));
    if (t.assign === 'creator') b3.push(stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (${byKey}, ?, 'assignee')`, projectId, k, ctx.user.id));
  }
  for (let i = 0; i < b3.length; i += 80) await db.batch(b3.slice(i, i + 80));
  return { name: tpl.name, tasks: flat.length };
}

// ---- project templates ---------------------------------------------------

function canRead(ctx, tpl) {
  return ctx.access.level('templates', tpl.entity_id ?? undefined) >= READ || tpl.created_by === ctx.user.id;
}
function canWrite(ctx, tpl) {
  return ctx.access.level('templates', tpl.entity_id ?? undefined) >= WRITE || tpl.created_by === ctx.user.id;
}

async function listProjectTemplates(ctx) {
  if (ctx.access.level('templates') < READ) throw forbidden('Requires access to templates');
  const pg = pageParams(ctx.url);
  const where = ['t.deleted_at IS NULL'], params = [];
  const entity = intParam(ctx.url, 'entity_id');
  if (entity) { where.push('(t.entity_id IS NULL OR t.entity_id = ?)'); params.push(entity); }
  const q = param(ctx.url, 'q'); if (q) { where.push('(t.name LIKE ? OR t.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  const { total, rows } = await paged(ctx.env.DB, {
    select: `t.id, t.name, t.description, t.entity_id, t.kind, t.created_by, t.created_at, t.updated_at, u.name AS created_by_name,
             json_array_length(t.body, '$.tasks') AS top_tasks,
             (SELECT COUNT(*) FROM projects p WHERE p.template_id = t.id AND p.deleted_at IS NULL) AS used`,
    from: `project_templates t LEFT JOIN users u ON u.id = t.created_by`, where, params, order: 't.name', ...pg,
  });
  return ok(rows, listMeta(total, pg, rows.length));
}

async function getProjectTemplate(ctx, { id }) {
  const t = await first(ctx.env.DB, `SELECT * FROM project_templates WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!t || !canRead(ctx, t)) throw notFound('Template not found');
  return ok({ ...t, body: parseJson(t.body, {}), can_edit: canWrite(ctx, t) });
}

async function createProjectTemplate(ctx) {
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { required: true, max: 160 }).text('description', { max: 5000 }).int('entity_id').string('kind', { max: 30 }).done();
  if (ctx.access.level('templates', v.entity_id ?? undefined) < WRITE) throw forbidden('Requires write access to templates');
  validateBody(body.body || { tasks: [] });
  const id = await insert(ctx.env.DB, 'project_templates', { ...v, body: JSON.stringify(body.body || { tasks: [] }), created_by: ctx.user.id });
  ctx.audit({ action: 'create', type: 'project_template', id, label: v.name, entity_id: v.entity_id, summary: `${ctx.user.name} created the project template "${v.name}"` });
  return created({ id, ...v });
}

async function patchProjectTemplate(ctx, { id }) {
  const t = await first(ctx.env.DB, `SELECT * FROM project_templates WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!t || !canRead(ctx, t)) throw notFound('Template not found');
  if (!canWrite(ctx, t)) throw forbidden();
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { max: 160, nullable: false }).text('description', { max: 5000 }).int('entity_id').string('kind', { max: 30 }).done();
  if (body.body !== undefined) { validateBody(body.body); v.body = JSON.stringify(body.body); }
  await update(ctx.env.DB, 'project_templates', t.id, v, { expected: expectedVersion(ctx.req, body) });
  ctx.audit({ action: 'update', type: 'project_template', id: t.id, label: t.name, entity_id: t.entity_id, summary: `${ctx.user.name} edited the project template "${t.name}"` });
  return getProjectTemplate(ctx, { id: t.id });
}

async function deleteProjectTemplate(ctx, { id }) {
  const t = await first(ctx.env.DB, `SELECT * FROM project_templates WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!t || !canRead(ctx, t)) throw notFound('Template not found');
  if (!canWrite(ctx, t)) throw forbidden();
  await run(ctx.env.DB, `UPDATE project_templates SET deleted_at = ? WHERE id = ?`, nowIso(), t.id);
  ctx.audit({ action: 'delete', type: 'project_template', id: t.id, label: t.name, entity_id: t.entity_id, summary: `${ctx.user.name} deleted the project template "${t.name}"` });
  return ok({ id: t.id, deleted: true });
}

// Captures a project's current structure as a new template. Dates become
// offsets from the project start (or from its earliest date).
async function saveAsTemplate(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  if (ctx.access.level('templates', project.entity_id) < WRITE) throw forbidden('Requires write access to templates');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { required: true, max: 160 }).text('description', { max: 5000 }).done();
  const db = ctx.env.DB;
  const [sections, tasks, deps, checklist, labels, tlabels, fields] = await db.batch([
    db.prepare(`SELECT id, name FROM sections WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`).bind(project.id),
    db.prepare(`SELECT * FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id`).bind(project.id),
    db.prepare(`SELECT d.* FROM task_dependencies d JOIN tasks t ON t.id = d.blocked_id WHERE t.project_id = ? AND t.deleted_at IS NULL`).bind(project.id),
    db.prepare(`SELECT c.task_id, c.text FROM checklist_items c JOIN tasks t ON t.id = c.task_id WHERE t.project_id = ? AND c.deleted_at IS NULL ORDER BY c.position`).bind(project.id),
    db.prepare(`SELECT id, name, color FROM labels WHERE project_id = ? AND deleted_at IS NULL`).bind(project.id),
    db.prepare(`SELECT tl.task_id, l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id JOIN tasks t ON t.id = tl.task_id WHERE t.project_id = ? AND l.project_id = ?`).bind(project.id, project.id),
    db.prepare(`SELECT name, type, options FROM custom_fields WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`).bind(project.id),
  ]);
  const ts = tasks.results;
  const dates = ts.flatMap(t => [t.start_date, t.due_date]).filter(Boolean).sort();
  const base = project.start_date || dates[0] || today();
  const secName = Object.fromEntries(sections.results.map(s => [s.id, s.name]));
  const node = (t) => ({
    key: `t${t.id}`, title: t.title, description: t.description || undefined, section: t.section_id ? secName[t.section_id] : undefined,
    start_offset: t.start_date ? daysBetween(base, t.start_date) : undefined, due_offset: t.due_date ? daysBetween(base, t.due_date) : undefined,
    estimate_hours: t.estimate_hours ?? undefined, priority: t.priority !== 'none' ? t.priority : undefined,
    is_milestone: t.is_milestone ? true : undefined, is_internal: t.is_internal ? true : undefined,
    labels: tlabels.results.filter(l => l.task_id === t.id).map(l => l.name),
    checklist: checklist.results.filter(c => c.task_id === t.id).map(c => c.text),
    blocked_by: deps.results.filter(d => d.blocked_id === t.id && ts.some(x => x.id === d.blocker_id)).map(d => `t${d.blocker_id}`),
    subtasks: ts.filter(c => c.parent_id === t.id).map(node),
  });
  const tbody = {
    sections: sections.results.map(s => ({ name: s.name })),
    labels: labels.results.map(l => ({ name: l.name, color: l.color })),
    custom_fields: fields.results.map(f => ({ name: f.name, type: f.type, options: parseJson(f.options) || undefined })),
    tasks: ts.filter(t => !t.parent_id || !ts.some(x => x.id === t.parent_id)).map(node),
  };
  const tid = await insert(db, 'project_templates', { name: v.name, description: v.description ?? null, entity_id: project.entity_id, kind: project.kind, body: JSON.stringify(tbody), created_by: ctx.user.id });
  ctx.audit({ action: 'create', type: 'project_template', id: tid, label: v.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} saved ${project.name} as the template "${v.name}" (${ts.length} tasks)` });
  return created({ id: tid, name: v.name, tasks: ts.length });
}

// ---- task templates ------------------------------------------------------

async function listTaskTemplates(ctx) {
  const project = intParam(ctx.url, 'project_id');
  if (project) await loadProject(ctx, project);
  const rows = await all(ctx.env.DB, `SELECT t.*, u.name AS created_by_name FROM task_templates t LEFT JOIN users u ON u.id = t.created_by
    WHERE t.deleted_at IS NULL AND (t.project_id IS NULL ${project ? 'OR t.project_id = ?' : ''}) ORDER BY t.name`, ...(project ? [project] : []));
  for (const r of rows) r.body = parseJson(r.body, {});
  return ok(rows, { total: rows.length, limit: rows.length, offset: 0, next_offset: null });
}

function validateTaskBody(b) {
  if (!b || typeof b.title !== 'string' || !b.title.trim()) throw invalid({ 'body.title': 'required' });
  return b;
}

async function createTaskTemplate(ctx) {
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { required: true, max: 160 }).int('project_id').done();
  if (v.project_id) await loadProject(ctx, v.project_id, 'work');
  else if (ctx.access.level('templates') < WRITE) throw forbidden('Organisation-wide task templates need template write access');
  const id = await insert(ctx.env.DB, 'task_templates', { ...v, body: JSON.stringify(validateTaskBody(body.body)), created_by: ctx.user.id });
  ctx.audit({ action: 'create', type: 'task_template', id, label: v.name, project_id: v.project_id, summary: `${ctx.user.name} created the task template "${v.name}"` });
  return created({ id, ...v, body: body.body });
}

async function loadTaskTemplate(ctx, id, write = false) {
  const t = await first(ctx.env.DB, `SELECT * FROM task_templates WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!t) throw notFound('Template not found');
  if (t.project_id) await loadProject(ctx, t.project_id, write ? 'work' : 'see');
  else if (write && ctx.access.level('templates') < WRITE && t.created_by !== ctx.user.id) throw forbidden();
  return t;
}

async function patchTaskTemplate(ctx, { id }) {
  const t = await loadTaskTemplate(ctx, id, true);
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { max: 160, nullable: false }).done();
  if (body.body !== undefined) v.body = JSON.stringify(validateTaskBody(body.body));
  await update(ctx.env.DB, 'task_templates', t.id, v, { expected: expectedVersion(ctx.req, body) });
  ctx.audit({ action: 'update', type: 'task_template', id: t.id, label: t.name, project_id: t.project_id, summary: `${ctx.user.name} edited the task template "${t.name}"` });
  const out = await first(ctx.env.DB, `SELECT * FROM task_templates WHERE id = ?`, t.id);
  return ok({ ...out, body: parseJson(out.body, {}) });
}

async function deleteTaskTemplate(ctx, { id }) {
  const t = await loadTaskTemplate(ctx, id, true);
  await run(ctx.env.DB, `UPDATE task_templates SET deleted_at = ? WHERE id = ?`, nowIso(), t.id);
  ctx.audit({ action: 'delete', type: 'task_template', id: t.id, label: t.name, project_id: t.project_id, summary: `${ctx.user.name} deleted the task template "${t.name}"` });
  return ok({ id: t.id, deleted: true });
}

// Creates a task (with subtasks and checklist) from a task template.
async function applyTaskTemplate(ctx, { id }) {
  const t = await loadTaskTemplate(ctx, id);
  const body = await readJson(ctx.req);
  const v = new Validator(body).int('project_id').int('section_id').int('assignee_id').date('due_date').done();
  const b = parseJson(t.body, {});
  const projectId = v.project_id ?? t.project_id ?? null;
  let project = null;
  if (projectId) project = (await loadProject(ctx, projectId, 'work')).project;
  const due = v.due_date || (b.due_offset != null ? addDays(today(), b.due_offset) : null);
  const mk = async (node, parentId) => {
    const tid = await createTaskRow(ctx, {
      project_id: projectId, parent_id: parentId, section_id: parentId ? null : (v.section_id ?? null), title: node.title.slice(0, 500),
      description: node.description || null, priority: node.priority || 'none', estimate_hours: node.estimate_hours ?? null,
      assignee_id: v.assignee_id ?? (projectId ? null : ctx.user.id), due_date: due, is_internal: node.is_internal ? 1 : 0,
    });
    const s = [stmt(ctx.env.DB, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'creator')`, tid, ctx.user.id)];
    (node.checklist || []).forEach((c, i) => s.push(stmt(ctx.env.DB, `INSERT INTO checklist_items (task_id, text, position) VALUES (?, ?, ?)`, tid, String(c).slice(0, 500), i + 1)));
    await ctx.env.DB.batch(s);
    for (const sub of node.subtasks || []) await mk(sub, tid);
    return tid;
  };
  const tid = await mk(b, null);
  ctx.audit({ action: 'create', type: 'task', id: tid, label: b.title, entity_id: project?.entity_id, project_id: projectId,
    summary: `${ctx.user.name} created "${b.title}" from the task template "${t.name}"` });
  if (v.assignee_id) ctx.notify([v.assignee_id], { kind: 'assigned', object_type: 'task', object_id: tid, project_id: projectId, title: b.title, url: taskUrl(tid) });
  ctx.touchProject(projectId);
  return created({ id: tid });
}

export default [
  ['GET', '/api/templates/projects', listProjectTemplates],
  ['POST', '/api/templates/projects', createProjectTemplate],
  ['GET', '/api/templates/projects/:id', getProjectTemplate],
  ['PATCH', '/api/templates/projects/:id', patchProjectTemplate],
  ['DELETE', '/api/templates/projects/:id', deleteProjectTemplate],
  ['POST', '/api/projects/:id/save-as-template', saveAsTemplate],
  ['GET', '/api/templates/tasks', listTaskTemplates],
  ['POST', '/api/templates/tasks', createTaskTemplate],
  ['PATCH', '/api/templates/tasks/:id', patchTaskTemplate],
  ['DELETE', '/api/templates/tasks/:id', deleteTaskTemplate],
  ['POST', '/api/templates/tasks/:id/apply', applyTaskTemplate],
];
