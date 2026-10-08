// Projects, membership, allocations and sections.

import { ok, created, readJson, Validator, pageParams, sortClause, listMeta, param, intParam, idList, notFound, forbidden, badRequest, conflict } from '../lib/http.js';
import { first, all, insert, update, run, paged, nowIso, stmt, expectedVersion, jsonIds } from '../lib/db.js';
import { WRITE, READ } from '../lib/rbac.js';
import { diff, describeChanges } from '../lib/audit.js';
import { loadProject, projectUrl } from '../lib/load.js';
import { applyProjectTemplate } from './templates.js';

const SORTABLE = {
  name: 'p.name', code: 'p.code', start: 'p.start_date', end: 'p.end_date', status: 'p.status',
  updated: 'p.updated_at', activity: 'p.last_activity_at', entity: 'e.code', overdue: 'tc.overdue',
};

const PROJECT_SELECT = `p.*, e.code AS entity_code, e.name AS entity_name, d.name AS department_name,
  COALESCE(tc.open, 0) AS open_tasks, COALESCE(tc.overdue, 0) AS overdue_tasks, COALESCE(tc.total, 0) AS total_tasks, COALESCE(tc.done, 0) AS done_tasks,
  (SELECT group_concat(u.name, ', ') FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = p.id AND m.role = 'pm' AND m.removed_at IS NULL) AS pm_names,
  (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id AND m.removed_at IS NULL) AS member_count`;

const PROJECT_FROM = `projects p
  LEFT JOIN entities e ON e.id = p.entity_id
  LEFT JOIN departments d ON d.id = p.department_id
  LEFT JOIN (SELECT project_id,
                    SUM(completed_at IS NULL) AS open,
                    SUM(completed_at IS NULL AND due_date < date('now')) AS overdue,
                    SUM(completed_at IS NOT NULL) AS done,
                    COUNT(*) AS total
               FROM tasks WHERE deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id) tc ON tc.project_id = p.id`;

async function list(ctx) {
  const { url, access } = ctx;
  const pg = pageParams(url, { defaultLimit: 100 });
  const pv = access.projectsVisibleSql('p');
  const where = ['p.deleted_at IS NULL', pv.sql];
  const params = [...pv.params];
  const archived = param(url, 'archived');
  if (archived === '1') where.push('p.archived_at IS NOT NULL');
  else if (archived !== 'all') where.push('p.archived_at IS NULL');
  const entities = idList(url, 'entity_id'); if (entities) { where.push(`p.entity_id IN (SELECT value FROM json_each(?))`); params.push(jsonIds(entities)); }
  const dept = intParam(url, 'department_id'); if (dept) { where.push('p.department_id = ?'); params.push(dept); }
  const status = param(url, 'status'); if (status) { where.push(`p.status IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(status.split(','))); }
  const kind = param(url, 'kind'); if (kind) { where.push('p.kind = ?'); params.push(kind); }
  const q = param(url, 'q'); if (q) { where.push('(p.name LIKE ? OR p.code LIKE ? OR p.funder LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const member = param(url, 'member');
  if (member) {
    const uid = member === 'me' ? ctx.user.id : Number(member);
    where.push(`EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ? AND m.removed_at IS NULL)`); params.push(uid);
  }
  const pm = intParam(url, 'pm_id');
  if (pm) { where.push(`EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ? AND m.role = 'pm' AND m.removed_at IS NULL)`); params.push(pm); }

  const { total, rows } = await paged(ctx.env.DB, {
    select: PROJECT_SELECT, from: PROJECT_FROM, where, params, order: sortClause(url, SORTABLE, 'name'), ...pg,
  });
  for (const r of rows) r.my_role = access.projectRole(r.id);
  return ok(rows, listMeta(total, pg, rows.length));
}

const projectFields = (v) => v
  .string('name', { min: 2, max: 200, nullable: false }).string('code', { max: 40 }).text('description', { max: 20000 })
  .int('entity_id').int('department_id').string('kind', { max: 30, nullable: false }).string('funder', { max: 160 })
  .string('our_role', { max: 60 }).oneOf('status', ['planning', 'active', 'on_hold', 'closing', 'closed'])
  .date('start_date').date('end_date').string('color', { max: 20 }).oneOf('visibility', ['members', 'entity']);

async function createProject(ctx) {
  const body = await readJson(ctx.req);
  const v = projectFields(new Validator(body)).int('template_id').ids('member_ids').done();
  if (!v.name) throw badRequest('name is required');
  if (!v.entity_id) throw badRequest('entity_id is required: every project belongs to one KMOP entity');
  if (ctx.access.level('project_create', v.entity_id, v.department_id ?? null) < WRITE) throw forbidden('You cannot create projects in this entity');
  if (v.start_date && v.end_date && v.end_date < v.start_date) throw badRequest('end_date is before start_date');
  const memberIds = v.member_ids || []; delete v.member_ids;
  const templateId = v.template_id; delete v.template_id;
  const id = await insert(ctx.env.DB, 'projects', { ...v, template_id: templateId ?? null, created_by: ctx.user.id, last_activity_at: nowIso() });
  const stmts = [stmt(ctx.env.DB, `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, 'pm', ?)`, id, ctx.user.id, ctx.user.id)];
  for (const uid of memberIds) if (uid !== ctx.user.id) {
    stmts.push(stmt(ctx.env.DB, `INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by)
      SELECT ?, id, CASE WHEN is_external = 1 THEN 'guest' ELSE 'member' END, ? FROM users WHERE id = ? AND deleted_at IS NULL`, id, ctx.user.id, uid));
  }
  await ctx.env.DB.batch(stmts);
  ctx.access.membership.set(id, 'pm');
  let templateResult = null;
  if (templateId) templateResult = await applyProjectTemplate(ctx, templateId, id, v.start_date);
  ctx.audit({ action: 'create', type: 'project', id, label: v.name, entity_id: v.entity_id, project_id: id,
    summary: `${ctx.user.name} created the project ${v.name}${templateResult ? ` from the template "${templateResult.name}" (${templateResult.tasks} tasks)` : ''}` });
  ctx.activity({ verb: 'project.created', type: 'project', id, project_id: id, payload: { name: v.name } });
  ctx.notify(memberIds, { kind: 'added_to_project', object_type: 'project', object_id: id, project_id: id, title: v.name, url: projectUrl(id) });
  return created(await getProjectData(ctx, id));
}

async function getProjectData(ctx, id) {
  const db = ctx.env.DB;
  const [proj, members, sections, fields, labels] = await db.batch([
    db.prepare(`SELECT ${PROJECT_SELECT} FROM ${PROJECT_FROM} WHERE p.id = ?`).bind(id),
    db.prepare(`SELECT m.user_id, m.role, m.added_at, u.name, u.email, u.title, u.is_external, u.external_org, u.entity_id
                  FROM project_members m JOIN users u ON u.id = m.user_id
                 WHERE m.project_id = ? AND m.removed_at IS NULL AND u.deleted_at IS NULL
                 ORDER BY CASE m.role WHEN 'pm' THEN 0 WHEN 'member' THEN 1 WHEN 'viewer' THEN 2 ELSE 3 END, u.name`).bind(id),
    db.prepare(`SELECT id, name, position, updated_at FROM sections WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id`).bind(id),
    db.prepare(`SELECT id, name, type, options, position, updated_at FROM custom_fields WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id`).bind(id),
    db.prepare(`SELECT id, project_id, name, color FROM labels WHERE (project_id = ? OR project_id IS NULL) AND deleted_at IS NULL ORDER BY name`).bind(id),
  ]);
  const p = proj.results[0];
  const pa = ctx.access.project(p);
  for (const f of fields.results) f.options = f.options ? JSON.parse(f.options) : null;
  return { ...p, my_role: pa.role, access: pa, members: members.results, sections: sections.results, custom_fields: fields.results, labels: labels.results };
}

async function getProject(ctx, { id }) {
  const { project } = await loadProject(ctx, id);
  return ok(await getProjectData(ctx, project.id));
}

async function patchProject(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const body = await readJson(ctx.req);
  const v = projectFields(new Validator(body)).done();
  if (v.entity_id && v.entity_id !== project.entity_id && ctx.access.level('project_create', v.entity_id) < WRITE) {
    throw forbidden('You cannot move a project into an entity where you cannot create projects');
  }
  const start = v.start_date !== undefined ? v.start_date : project.start_date, end = v.end_date !== undefined ? v.end_date : project.end_date;
  if (start && end && end < start) throw badRequest('end_date is before start_date');
  const changes = diff(project, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'projects', project.id, { ...v, last_activity_at: nowIso() }, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'project', id: project.id, label: project.name, entity_id: v.entity_id || project.entity_id, project_id: project.id,
      summary: `${ctx.user.name} updated the project ${project.name}: ${describeChanges(changes)}`, changes });
    ctx.activity({ verb: 'project.updated', type: 'project', id: project.id, project_id: project.id, payload: { changes } });
  }
  return ok(await getProjectData(ctx, project.id));
}

async function deleteProject(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  await run(ctx.env.DB, `UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), project.id);
  ctx.audit({ action: 'delete', type: 'project', id: project.id, label: project.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} deleted the project ${project.name} (restorable)` });
  return ok({ id: project.id, deleted: true });
}

async function restoreProject(ctx, { id }) {
  const p = await first(ctx.env.DB, `SELECT * FROM projects WHERE id = ? AND deleted_at IS NOT NULL`, Number(id));
  if (!p) throw notFound('Project not found');
  const a = ctx.access.project(p);
  if (!a.manage) throw forbidden();
  await run(ctx.env.DB, `UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), p.id);
  ctx.audit({ action: 'restore', type: 'project', id: p.id, label: p.name, entity_id: p.entity_id, project_id: p.id, summary: `${ctx.user.name} restored the project ${p.name}` });
  return ok(await getProjectData(ctx, p.id));
}

async function archiveProject(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const { archived } = new Validator(await readJson(ctx.req)).bool('archived').done();
  const at = archived === 0 ? null : nowIso();
  await run(ctx.env.DB, `UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?`, at, nowIso(), project.id);
  ctx.audit({ action: 'update', type: 'project', id: project.id, label: project.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} ${at ? 'archived' : 'unarchived'} the project ${project.name}` });
  return ok(await getProjectData(ctx, project.id));
}

// ---- members -------------------------------------------------------------

async function listMembers(ctx, { id }) {
  const { project } = await loadProject(ctx, id);
  return ok((await getProjectData(ctx, project.id)).members);
}

async function addMember(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const v = new Validator(await readJson(ctx.req)).int('user_id', { required: true }).oneOf('role', ['pm', 'member', 'viewer', 'guest']).done();
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND active = 1`, v.user_id);
  if (!u) throw notFound('Person not found');
  let role = v.role || (u.is_external ? 'guest' : 'member');
  // External partners never manage KMOP projects or see internal tasks.
  if (u.is_external && !['guest', 'viewer'].includes(role)) role = 'guest';
  const existing = await first(ctx.env.DB, `SELECT * FROM project_members WHERE project_id = ? AND user_id = ?`, project.id, u.id);
  if (existing && !existing.removed_at) throw conflict(`${u.name} is already a member`);
  await run(ctx.env.DB, `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)
    ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role, removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at`,
    project.id, u.id, role, ctx.user.id);
  // A supervisor added to a project supervises it (read and comment only).
  if (u.role === 'supervisor') await run(ctx.env.DB, `INSERT OR IGNORE INTO supervisor_projects (user_id, project_id, granted_by) VALUES (?, ?, ?)`, u.id, project.id, ctx.user.id);
  ctx.audit({ action: 'create', type: 'project_member', id: u.id, label: u.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} added ${u.name} to ${project.name} as ${u.role === 'supervisor' ? 'supervisor' : role}` });
  ctx.activity({ verb: 'member.added', type: 'user', id: u.id, project_id: project.id, payload: { name: u.name, role } });
  ctx.notify([u.id], { kind: 'added_to_project', object_type: 'project', object_id: project.id, project_id: project.id, title: project.name, url: projectUrl(project.id) });
  ctx.touchProject(project.id);
  return created((await getProjectData(ctx, project.id)).members);
}

async function patchMember(ctx, { id, userId }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const { role } = new Validator(await readJson(ctx.req)).oneOf('role', ['pm', 'member', 'viewer', 'guest'], { required: true }).done();
  const m = await first(ctx.env.DB, `SELECT m.*, u.name, u.is_external FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL`, project.id, Number(userId));
  if (!m) throw notFound('Member not found');
  if (m.is_external && !['guest', 'viewer'].includes(role)) throw badRequest('External partners can only be guests or viewers');
  if (m.role === 'pm' && role !== 'pm') await ensureAnotherPm(ctx, project.id, m.user_id);
  await run(ctx.env.DB, `UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?`, role, project.id, m.user_id);
  ctx.audit({ action: 'update', type: 'project_member', id: m.user_id, label: m.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} changed ${m.name}'s role on ${project.name} from ${m.role} to ${role}`, changes: { role: [m.role, role] } });
  return ok((await getProjectData(ctx, project.id)).members);
}

async function ensureAnotherPm(ctx, projectId, leavingUserId) {
  const r = await first(ctx.env.DB, `SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND role = 'pm' AND removed_at IS NULL AND user_id <> ?`, projectId, leavingUserId);
  if (!r.n) throw badRequest('A project needs at least one project manager. Make someone else PM first.');
}

async function removeMember(ctx, { id, userId }) {
  const { project } = await loadProject(ctx, id, 'manage');
  const m = await first(ctx.env.DB, `SELECT m.*, u.name FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL`, project.id, Number(userId));
  if (!m) throw notFound('Member not found');
  if (m.role === 'pm') await ensureAnotherPm(ctx, project.id, m.user_id);
  await run(ctx.env.DB, `UPDATE project_members SET removed_at = ? WHERE project_id = ? AND user_id = ?`, nowIso(), project.id, m.user_id);
  await run(ctx.env.DB, `DELETE FROM supervisor_projects WHERE project_id = ? AND user_id = ?`, project.id, m.user_id);
  ctx.audit({ action: 'delete', type: 'project_member', id: m.user_id, label: m.name, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} removed ${m.name} from ${project.name}` });
  ctx.activity({ verb: 'member.removed', type: 'user', id: m.user_id, project_id: project.id, payload: { name: m.name } });
  return ok({ removed: true });
}

// ---- allocations ---------------------------------------------------------

async function listAllocations(ctx) {
  const { url, access } = ctx;
  const where = ['a.deleted_at IS NULL', 'p.deleted_at IS NULL'], params = [];
  const user = param(url, 'user_id');
  const project = intParam(url, 'project_id');
  if (project) { await loadProject(ctx, project); where.push('a.project_id = ?'); params.push(project); }
  else {
    const pv = access.projectsVisibleSql('p');
    const ps = access.scope('people', READ);
    // Your own allocations, those on projects you can see, or those of people you can see.
    where.push(`(a.user_id = ? OR ${pv.sql} OR u.entity_id IN (SELECT value FROM json_each(?)))`);
    params.push(ctx.user.id, ...pv.params, JSON.stringify(ps.entities));
  }
  if (user) { where.push('a.user_id = ?'); params.push(user === 'me' ? ctx.user.id : Number(user)); }
  const from = param(url, 'from'); if (from) { where.push('a.end_date >= ?'); params.push(from); }
  const to = param(url, 'to'); if (to) { where.push('a.start_date <= ?'); params.push(to); }
  const pg = pageParams(url, { defaultLimit: 200, maxLimit: 500 });
  const { total, rows } = await paged(ctx.env.DB, {
    select: `a.*, u.name AS user_name, p.name AS project_name, p.code AS project_code`,
    from: `allocations a JOIN users u ON u.id = a.user_id JOIN projects p ON p.id = a.project_id`,
    where, params, order: sortClause(url, { start: 'a.start_date', user: 'u.name', project: 'p.name' }, 'start'), ...pg,
  });
  return ok(rows, listMeta(total, pg, rows.length));
}

const allocFields = (v) => v.date('start_date').date('end_date').number('fte_pct', { min: 1, max: 100 }).number('person_months', { min: 0, max: 500 }).string('note', { max: 300 });

async function createAllocation(ctx) {
  const v = allocFields(new Validator(await readJson(ctx.req)).int('user_id', { required: true }).int('project_id', { required: true })).done();
  if (!v.start_date || !v.end_date || !v.fte_pct) throw badRequest('start_date, end_date and fte_pct are required');
  if (v.end_date < v.start_date) throw badRequest('end_date is before start_date');
  const { project } = await loadProject(ctx, v.project_id, 'manage');
  const u = await first(ctx.env.DB, `SELECT id, name FROM users WHERE id = ? AND deleted_at IS NULL`, v.user_id);
  if (!u) throw notFound('Person not found');
  const id = await insert(ctx.env.DB, 'allocations', { ...v, created_by: ctx.user.id });
  ctx.audit({ action: 'create', type: 'allocation', id, label: `${u.name} → ${project.name}`, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} allocated ${u.name} to ${project.name} at ${v.fte_pct}% from ${v.start_date} to ${v.end_date}` });
  return created(await first(ctx.env.DB, `SELECT * FROM allocations WHERE id = ?`, id));
}

async function patchAllocation(ctx, { id }) {
  const a = await first(ctx.env.DB, `SELECT a.*, u.name AS user_name FROM allocations a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.deleted_at IS NULL`, Number(id));
  if (!a) throw notFound('Allocation not found');
  const { project } = await loadProject(ctx, a.project_id, 'manage');
  const body = await readJson(ctx.req);
  const v = allocFields(new Validator(body)).done();
  const changes = diff(a, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'allocations', a.id, v, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'allocation', id: a.id, label: `${a.user_name} → ${project.name}`, entity_id: project.entity_id, project_id: project.id,
      summary: `${ctx.user.name} changed ${a.user_name}'s allocation to ${project.name}: ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM allocations WHERE id = ?`, a.id));
}

async function deleteAllocation(ctx, { id }) {
  const a = await first(ctx.env.DB, `SELECT a.*, u.name AS user_name FROM allocations a JOIN users u ON u.id = a.user_id WHERE a.id = ? AND a.deleted_at IS NULL`, Number(id));
  if (!a) throw notFound('Allocation not found');
  const { project } = await loadProject(ctx, a.project_id, 'manage');
  await run(ctx.env.DB, `UPDATE allocations SET deleted_at = ? WHERE id = ?`, nowIso(), a.id);
  ctx.audit({ action: 'delete', type: 'allocation', id: a.id, label: `${a.user_name} → ${project.name}`, entity_id: project.entity_id, project_id: project.id,
    summary: `${ctx.user.name} removed ${a.user_name}'s allocation to ${project.name}` });
  return ok({ id: a.id, deleted: true });
}

// ---- sections ------------------------------------------------------------

async function listSections(ctx, { id }) {
  const { project } = await loadProject(ctx, id);
  return ok(await all(ctx.env.DB, `SELECT * FROM sections WHERE project_id = ? AND deleted_at IS NULL ORDER BY position, id`, project.id));
}

async function createSection(ctx, { id }) {
  const { project } = await loadProject(ctx, id, 'work');
  const v = new Validator(await readJson(ctx.req)).string('name', { required: true, max: 120 }).number('position').done();
  if (v.position == null) v.position = ((await first(ctx.env.DB, `SELECT MAX(position) AS m FROM sections WHERE project_id = ?`, project.id)).m || 0) + 1;
  const sid = await insert(ctx.env.DB, 'sections', { project_id: project.id, ...v });
  ctx.audit({ action: 'create', type: 'section', id: sid, label: v.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} added the section "${v.name}" to ${project.name}` });
  ctx.touchProject(project.id);
  return created(await first(ctx.env.DB, `SELECT * FROM sections WHERE id = ?`, sid));
}

async function patchSection(ctx, { id }) {
  const s = await first(ctx.env.DB, `SELECT * FROM sections WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!s) throw notFound('Section not found');
  const { project } = await loadProject(ctx, s.project_id, 'work');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { max: 120, nullable: false }).number('position', { nullable: false }).done();
  const changes = diff(s, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'sections', s.id, v, { expected: expectedVersion(ctx.req, body) });
    if (changes.name) ctx.audit({ action: 'update', type: 'section', id: s.id, label: s.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} renamed the section "${s.name}" to "${v.name}"`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM sections WHERE id = ?`, s.id));
}

async function deleteSection(ctx, { id }) {
  const s = await first(ctx.env.DB, `SELECT * FROM sections WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!s) throw notFound('Section not found');
  const { project } = await loadProject(ctx, s.project_id, 'work');
  // Tasks are never deleted with their section; they move to "no section".
  await ctx.env.DB.batch([
    stmt(ctx.env.DB, `UPDATE sections SET deleted_at = ? WHERE id = ?`, nowIso(), s.id),
    stmt(ctx.env.DB, `UPDATE tasks SET section_id = NULL WHERE section_id = ?`, s.id),
  ]);
  ctx.audit({ action: 'delete', type: 'section', id: s.id, label: s.name, entity_id: project.entity_id, project_id: project.id, summary: `${ctx.user.name} removed the section "${s.name}"; its tasks moved to no section` });
  return ok({ id: s.id, deleted: true });
}

export default [
  ['GET', '/api/projects', list],
  ['POST', '/api/projects', createProject],
  ['GET', '/api/projects/:id', getProject],
  ['PATCH', '/api/projects/:id', patchProject],
  ['DELETE', '/api/projects/:id', deleteProject],
  ['POST', '/api/projects/:id/restore', restoreProject],
  ['POST', '/api/projects/:id/archive', archiveProject],
  ['GET', '/api/projects/:id/members', listMembers],
  ['POST', '/api/projects/:id/members', addMember],
  ['PATCH', '/api/projects/:id/members/:userId', patchMember],
  ['DELETE', '/api/projects/:id/members/:userId', removeMember],
  ['GET', '/api/projects/:id/sections', listSections],
  ['POST', '/api/projects/:id/sections', createSection],
  ['PATCH', '/api/sections/:id', patchSection],
  ['DELETE', '/api/sections/:id', deleteSection],
  ['GET', '/api/allocations', listAllocations],
  ['POST', '/api/allocations', createAllocation],
  ['PATCH', '/api/allocations/:id', patchAllocation],
  ['DELETE', '/api/allocations/:id', deleteAllocation],
];
