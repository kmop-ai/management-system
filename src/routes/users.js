// People: directory, invitations, profile edits, roles and access overrides.

import { ok, created, readJson, Validator, pageParams, sortClause, listMeta, param, intParam, notFound, forbidden, conflict, badRequest } from '../lib/http.js';
import { first, all, insert, update, paged, nowIso, run, expectedVersion } from '../lib/db.js';
import { READ, WRITE } from '../lib/rbac.js';
import { diff, describeChanges } from '../lib/audit.js';
import { publicUser } from './me.js';

const SORTABLE = { name: 'u.name', email: 'u.email', entity: 'e.code', department: 'd.name', last_login: 'u.last_login_at', created: 'u.created_at' };

// Directory. Who you can list follows the 'people' module scope; guests and
// people without it see only those they share a project with.
async function list(ctx) {
  const { url, access } = ctx;
  const pg = pageParams(url, { defaultLimit: 100, maxLimit: 500 });
  const where = ['u.deleted_at IS NULL'];
  const params = [];
  const s = access.scope('people', READ);
  where.push(`(u.id = ? OR u.entity_id IN (SELECT value FROM json_each(?)) OR u.department_id IN (SELECT value FROM json_each(?))
              OR u.id IN (SELECT pm2.user_id FROM project_members pm2 WHERE pm2.removed_at IS NULL AND pm2.project_id IN (SELECT value FROM json_each(?)))
              ${access.user.is_external ? '' : `OR (u.entity_id IS NULL AND ${s.entities.length ? 1 : 0})`})`);
  params.push(ctx.user.id, JSON.stringify(s.entities), JSON.stringify(s.departments), JSON.stringify([...access.membership.keys()]));
  const q = param(url, 'q');
  if (q) { where.push(`(u.name LIKE ? OR u.email LIKE ? OR u.title LIKE ?)`); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const entity = intParam(url, 'entity_id'); if (entity) { where.push('u.entity_id = ?'); params.push(entity); }
  const dept = intParam(url, 'department_id'); if (dept) { where.push('u.department_id = ?'); params.push(dept); }
  const active = param(url, 'active'); if (active !== 'all') { where.push('u.active = ?'); params.push(active === '0' ? 0 : 1); }
  const external = param(url, 'external'); if (external !== null) { where.push('u.is_external = ?'); params.push(external === '1' ? 1 : 0); }
  const role = param(url, 'role');
  if (role) { where.push(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role = ? AND ur.revoked_at IS NULL)`); params.push(role); }
  const project = intParam(url, 'project_id');
  if (project) { where.push(`EXISTS (SELECT 1 FROM project_members pm WHERE pm.user_id = u.id AND pm.project_id = ? AND pm.removed_at IS NULL)`); params.push(project); }

  const { total, rows } = await paged(ctx.env.DB, {
    select: `u.id, u.email, u.name, u.title, u.entity_id, u.department_id, u.is_external, u.external_org, u.active, u.weekly_hours,
             u.work_days, u.last_login_at, u.updated_at, e.code AS entity_code, d.name AS department_name,
             (SELECT group_concat(ur.role) FROM user_roles ur WHERE ur.user_id = u.id AND ur.revoked_at IS NULL
                AND (ur.valid_until IS NULL OR ur.valid_until >= date('now'))) AS roles`,
    from: `users u LEFT JOIN entities e ON e.id = u.entity_id LEFT JOIN departments d ON d.id = u.department_id`,
    where, params, order: sortClause(url, SORTABLE, 'name'), ...pg,
  });
  for (const r of rows) r.roles = r.roles ? r.roles.split(',') : [];
  return ok(rows, listMeta(total, pg, rows.length));
}

async function getOne(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  const shares = await first(ctx.env.DB, `SELECT 1 AS x FROM project_members a JOIN project_members b ON a.project_id = b.project_id
    WHERE a.user_id = ? AND b.user_id = ? AND a.removed_at IS NULL AND b.removed_at IS NULL LIMIT 1`, ctx.user.id, u.id);
  if (!ctx.access.canSeePerson(u) && !shares) throw notFound('Person not found');
  const db = ctx.env.DB;
  const full = ctx.access.canSeePerson(u);
  const [roles, overrides, projects] = full ? await db.batch([
    db.prepare(`SELECT ur.*, r.label_en, r.label_el, g.name AS granted_by_name FROM user_roles ur JOIN roles r ON r.key = ur.role
                 LEFT JOIN users g ON g.id = ur.granted_by WHERE ur.user_id = ? AND ur.revoked_at IS NULL ORDER BY r.rank DESC`).bind(u.id),
    db.prepare(`SELECT ma.*, g.name AS granted_by_name FROM module_access ma LEFT JOIN users g ON g.id = ma.granted_by
                 WHERE ma.user_id = ? AND ma.revoked_at IS NULL`).bind(u.id),
    db.prepare(`SELECT p.id, p.code, p.name, p.entity_id, p.status, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
                 WHERE pm.user_id = ? AND pm.removed_at IS NULL AND p.deleted_at IS NULL ORDER BY p.name`).bind(u.id),
  ]) : [{ results: [] }, { results: [] }, { results: [] }];
  const pv = ctx.access.projectsVisibleSql('p');
  const visibleProjects = projects.results.length
    ? new Set((await all(db, `SELECT p.id FROM projects p WHERE p.id IN (SELECT value FROM json_each(?)) AND ${pv.sql}`,
        JSON.stringify(projects.results.map(p => p.id)), ...pv.params)).map(r => r.id))
    : new Set();
  return ok({
    ...publicUser(u), active: u.active,
    roles: roles.results, module_access: overrides.results,
    projects: projects.results.filter(p => visibleProjects.has(p.id)),
    can_edit: ctx.access.canEditPerson(u),
    can_see_metrics: ctx.access.canSeeMetricsOf(u),
  });
}

function canAdminister(ctx, entityId) {
  if (ctx.access.level('admin', entityId ?? null) < WRITE) throw forbidden('Only administrators can manage people');
}

async function invite(ctx) {
  const body = await readJson(ctx.req);
  const v = new Validator(body).email('email', { required: true }).string('name', { required: true, min: 2, max: 120 })
    .string('title', { max: 120 }).int('entity_id').int('department_id').int('manager_id').bool('is_external')
    .string('external_org', { max: 160 }).oneOf('locale', ['en', 'el']).number('weekly_hours', { min: 0, max: 60 })
    .string('work_days', { max: 7 }).string('role', { max: 40 }).done();
  canAdminister(ctx, v.entity_id);
  if (await first(ctx.env.DB, `SELECT id FROM users WHERE email = ?`, v.email)) throw conflict('Someone with this email already exists');
  const role = v.role || (v.is_external ? 'external_partner' : 'team_member');
  delete v.role;
  const id = await insert(ctx.env.DB, 'users', v);
  await insert(ctx.env.DB, 'user_roles', { user_id: id, role, granted_by: ctx.user.id });
  ctx.audit({ action: 'create', type: 'user', id, label: v.name, entity_id: v.entity_id,
    summary: `${ctx.user.name} added ${v.name} (${v.email}) as ${role.replace(/_/g, ' ')}` });
  return created(publicUser(await first(ctx.env.DB, `SELECT * FROM users WHERE id = ?`, id)));
}

async function patch(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  const self = u.id === ctx.user.id;
  if (!ctx.access.canEditPerson(u) && !self) throw forbidden();
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('name', { min: 2, max: 120, nullable: false }).string('title', { max: 120 })
    .int('entity_id').int('department_id').int('manager_id').bool('is_external').string('external_org', { max: 160 })
    .oneOf('locale', ['en', 'el']).number('weekly_hours', { min: 0, max: 60, nullable: false })
    .string('work_days', { max: 7, nullable: false }).bool('active').email('email').string('timezone', { max: 60 }).done();
  // People may edit their own name/title/capacity; structural fields need the people or admin module.
  if (!ctx.access.canEditPerson(u)) for (const k of ['entity_id', 'department_id', 'manager_id', 'is_external', 'active', 'email']) delete v[k];
  if (v.work_days && !/^[1-7]{0,7}$/.test(v.work_days)) throw badRequest('work_days must list ISO weekdays, e.g. 12345');
  const changes = diff(u, v);
  if (!Object.keys(changes).length) return ok(publicUser(u));
  await update(ctx.env.DB, 'users', u.id, v, { expected: expectedVersion(ctx.req, body) });
  // Deactivating someone ends their sessions immediately.
  if (v.active === 0 && u.active) await run(ctx.env.DB, `UPDATE users SET token_version = token_version + 1 WHERE id = ?`, u.id);
  ctx.audit({ action: 'update', type: 'user', id: u.id, label: u.name, entity_id: u.entity_id,
    summary: `${ctx.user.name} updated ${u.name}: ${describeChanges(changes)}`, changes });
  return ok(publicUser(await first(ctx.env.DB, `SELECT * FROM users WHERE id = ?`, u.id)));
}

async function remove(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  canAdminister(ctx, u.entity_id);
  if (u.id === ctx.user.id) throw badRequest('You cannot remove yourself');
  // Soft delete: their name must stay on tasks, comments and the audit log.
  await run(ctx.env.DB, `UPDATE users SET active = 0, deleted_at = ?, token_version = token_version + 1, updated_at = ? WHERE id = ?`, nowIso(), nowIso(), u.id);
  ctx.audit({ action: 'delete', type: 'user', id: u.id, label: u.name, entity_id: u.entity_id, summary: `${ctx.user.name} removed ${u.name}; their sessions were revoked` });
  return ok({ id: u.id, deleted: true });
}

async function revokeSessions(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  if (u.id !== ctx.user.id) canAdminister(ctx, u.entity_id);
  await run(ctx.env.DB, `UPDATE users SET token_version = token_version + 1 WHERE id = ?`, u.id);
  ctx.audit({ action: 'revoke', type: 'user', id: u.id, label: u.name, entity_id: u.entity_id, summary: `${ctx.user.name} signed ${u.name} out of every device` });
  return ok({ revoked: true });
}

// ---- roles ---------------------------------------------------------------

async function listRoles(ctx, { id }) {
  const rows = await all(ctx.env.DB, `SELECT ur.*, r.label_en, r.label_el FROM user_roles ur JOIN roles r ON r.key = ur.role
    WHERE ur.user_id = ? AND ur.revoked_at IS NULL ORDER BY r.rank DESC`, Number(id));
  return ok(rows);
}

async function grantRole(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('role', { required: true, max: 40 }).int('entity_id').int('department_id')
    .date('valid_from').date('valid_until').done();
  canAdminister(ctx, v.entity_id);
  const role = await first(ctx.env.DB, `SELECT * FROM roles WHERE key = ?`, v.role);
  if (!role) throw badRequest('Unknown role');
  if (role.rank > ctx.access.maxRank) throw forbidden('You cannot grant a role above your own');
  if (role.requires_expiry && !v.valid_until) throw badRequest(`${role.label_en} access must have an end date (valid_until)`);
  const rid = await insert(ctx.env.DB, 'user_roles', { user_id: u.id, ...v, granted_by: ctx.user.id });
  const where = v.department_id ? 'in one department' : v.entity_id ? `in entity #${v.entity_id}` : 'in every entity';
  ctx.audit({ action: 'grant', type: 'user', id: u.id, label: u.name, entity_id: v.entity_id,
    summary: `${ctx.user.name} gave ${u.name} the ${role.label_en} role ${where}${v.valid_until ? ` until ${v.valid_until}` : ''}` });
  return created(await first(ctx.env.DB, `SELECT * FROM user_roles WHERE id = ?`, rid));
}

async function revokeRole(ctx, { id, roleId }) {
  const r = await first(ctx.env.DB, `SELECT ur.*, u.name AS user_name FROM user_roles ur JOIN users u ON u.id = ur.user_id
    WHERE ur.id = ? AND ur.user_id = ? AND ur.revoked_at IS NULL`, Number(roleId), Number(id));
  if (!r) throw notFound('Role grant not found');
  canAdminister(ctx, r.entity_id);
  await run(ctx.env.DB, `UPDATE user_roles SET revoked_at = ? WHERE id = ?`, nowIso(), r.id);
  ctx.audit({ action: 'revoke', type: 'user', id: r.user_id, label: r.user_name, entity_id: r.entity_id,
    summary: `${ctx.user.name} removed the ${r.role.replace(/_/g, ' ')} role from ${r.user_name}` });
  return ok({ id: r.id, revoked: true });
}

// ---- per-person module overrides ----------------------------------------

async function grantModule(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  const body = await readJson(ctx.req);
  const v = new Validator(body).string('module', { required: true, max: 40 }).int('entity_id').int('level', { required: true, min: 0, max: 3 })
    .string('reason', { required: true, min: 3, max: 300 }).date('valid_until').done();
  canAdminister(ctx, v.entity_id);
  if (!await first(ctx.env.DB, `SELECT key FROM modules WHERE key = ?`, v.module)) throw badRequest('Unknown module');
  if (v.level > ctx.access.level(v.module, v.entity_id ?? undefined) && !ctx.access.isSuperAdmin) throw forbidden('You cannot grant more access than you have');
  // One active override per module+scope: replace the previous one.
  await run(ctx.env.DB, `UPDATE module_access SET revoked_at = ? WHERE user_id = ? AND module = ? AND entity_id IS ? AND revoked_at IS NULL`, nowIso(), u.id, v.module, v.entity_id ?? null);
  const mid = await insert(ctx.env.DB, 'module_access', { user_id: u.id, ...v, granted_by: ctx.user.id });
  ctx.audit({ action: 'grant', type: 'user', id: u.id, label: u.name, entity_id: v.entity_id,
    summary: `${ctx.user.name} set ${u.name}'s access to ${v.module} to ${['none', 'read', 'write', 'admin'][v.level]}${v.entity_id ? ` in entity #${v.entity_id}` : ''} — reason: ${v.reason}` });
  return created(await first(ctx.env.DB, `SELECT * FROM module_access WHERE id = ?`, mid));
}

async function revokeModule(ctx, { id, accessId }) {
  const r = await first(ctx.env.DB, `SELECT ma.*, u.name AS user_name FROM module_access ma JOIN users u ON u.id = ma.user_id
    WHERE ma.id = ? AND ma.user_id = ? AND ma.revoked_at IS NULL`, Number(accessId), Number(id));
  if (!r) throw notFound('Override not found');
  canAdminister(ctx, r.entity_id);
  await run(ctx.env.DB, `UPDATE module_access SET revoked_at = ? WHERE id = ?`, nowIso(), r.id);
  ctx.audit({ action: 'revoke', type: 'user', id: r.user_id, label: r.user_name, entity_id: r.entity_id,
    summary: `${ctx.user.name} removed ${r.user_name}'s ${r.module} access override` });
  return ok({ id: r.id, revoked: true });
}

export default [
  ['GET', '/api/users', list],
  ['POST', '/api/users', invite],
  ['GET', '/api/users/:id', getOne],
  ['PATCH', '/api/users/:id', patch],
  ['DELETE', '/api/users/:id', remove],
  ['POST', '/api/users/:id/revoke-sessions', revokeSessions],
  ['GET', '/api/users/:id/roles', listRoles],
  ['POST', '/api/users/:id/roles', grantRole],
  ['DELETE', '/api/users/:id/roles/:roleId', revokeRole],
  ['POST', '/api/users/:id/module-access', grantModule],
  ['DELETE', '/api/users/:id/module-access/:accessId', revokeModule],
];
