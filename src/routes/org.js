// Organisation configuration: entities, holidays, departments, roles and the
// access matrix, settings. Read by everyone (the shell needs labels), written
// only with the admin module.

import { ok, created, readJson, Validator, notFound, forbidden, badRequest, intParam, param } from '../lib/http.js';
import { first, all, insert, update, run, nowIso, stmt, expectedVersion } from '../lib/db.js';
import { WRITE, ADMIN } from '../lib/rbac.js';
import { diff, describeChanges } from '../lib/audit.js';

const needAdmin = (ctx, entityId, min = WRITE) => {
  if (ctx.access.level('admin', entityId ?? undefined) < min) throw forbidden('Requires administration access');
};

// ---- entities ------------------------------------------------------------

async function listEntities(ctx) {
  return ok(await all(ctx.env.DB, `SELECT * FROM entities WHERE deleted_at IS NULL ORDER BY id`));
}

const entityFields = (v) => v.string('code', { min: 2, max: 12, nullable: false }).string('name', { min: 2, max: 160, nullable: false })
  .string('legal_name', { max: 200 }).string('country', { min: 2, max: 2, nullable: false }).string('city', { max: 80 })
  .string('vat_number', { max: 40 }).string('pic', { max: 20 }).string('oid', { max: 20 }).string('currency', { min: 3, max: 3 })
  .string('timezone', { max: 60 }).string('color', { max: 20 });

async function createEntity(ctx) {
  needAdmin(ctx, undefined, ADMIN);
  const body = await readJson(ctx.req);
  const v = entityFields(new Validator(body)).done();
  if (!v.code || !v.name || !v.country) throw badRequest('code, name and country are required');
  v.code = v.code.toUpperCase(); v.country = v.country.toUpperCase();
  const id = await insert(ctx.env.DB, 'entities', v);
  ctx.audit({ action: 'create', type: 'entity', id, label: v.name, entity_id: id, summary: `${ctx.user.name} created the entity ${v.name}` });
  return created(await first(ctx.env.DB, `SELECT * FROM entities WHERE id = ?`, id));
}

async function getEntity(ctx, { id }) {
  const e = await first(ctx.env.DB, `SELECT * FROM entities WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!e) throw notFound('Entity not found');
  return ok(e);
}

async function patchEntity(ctx, { id }) {
  const e = await first(ctx.env.DB, `SELECT * FROM entities WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!e) throw notFound('Entity not found');
  needAdmin(ctx, e.id);
  const body = await readJson(ctx.req);
  const v = entityFields(new Validator(body)).done();
  const changes = diff(e, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'entities', e.id, v, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'entity', id: e.id, label: e.name, entity_id: e.id, summary: `${ctx.user.name} updated ${e.name}: ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM entities WHERE id = ?`, e.id));
}

async function deleteEntity(ctx, { id }) {
  needAdmin(ctx, undefined, ADMIN);
  const e = await first(ctx.env.DB, `SELECT * FROM entities WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!e) throw notFound('Entity not found');
  const used = await first(ctx.env.DB, `SELECT (SELECT COUNT(*) FROM projects WHERE entity_id = ? AND deleted_at IS NULL) + (SELECT COUNT(*) FROM users WHERE entity_id = ? AND deleted_at IS NULL) AS n`, e.id, e.id);
  if (used.n) throw badRequest('This entity still has projects or people. Move them first.');
  await run(ctx.env.DB, `UPDATE entities SET deleted_at = ? WHERE id = ?`, nowIso(), e.id);
  ctx.audit({ action: 'delete', type: 'entity', id: e.id, label: e.name, entity_id: e.id, summary: `${ctx.user.name} removed the entity ${e.name}` });
  return ok({ id: e.id, deleted: true });
}

// ---- holidays ------------------------------------------------------------

async function listHolidays(ctx, { id }) {
  const from = param(ctx.url, 'from') || '0000-01-01', to = param(ctx.url, 'to') || '9999-12-31';
  return ok(await all(ctx.env.DB, `SELECT * FROM entity_holidays WHERE entity_id = ? AND date BETWEEN ? AND ? ORDER BY date`, Number(id), from, to));
}

async function addHoliday(ctx, { id }) {
  needAdmin(ctx, Number(id));
  const v = new Validator(await readJson(ctx.req)).date('date', { required: true }).string('name', { required: true, max: 120 }).done();
  await run(ctx.env.DB, `INSERT INTO entity_holidays (entity_id, date, name) VALUES (?, ?, ?) ON CONFLICT (entity_id, date) DO UPDATE SET name = excluded.name`, Number(id), v.date, v.name);
  ctx.audit({ action: 'create', type: 'holiday', label: v.name, entity_id: Number(id), summary: `${ctx.user.name} added the public holiday ${v.name} on ${v.date}` });
  return created(await first(ctx.env.DB, `SELECT * FROM entity_holidays WHERE entity_id = ? AND date = ?`, Number(id), v.date));
}

async function deleteHoliday(ctx, { id }) {
  const h = await first(ctx.env.DB, `SELECT * FROM entity_holidays WHERE id = ?`, Number(id));
  if (!h) throw notFound('Holiday not found');
  needAdmin(ctx, h.entity_id);
  // Holidays are reference data, not user content: hard delete is fine, the audit row keeps the record.
  await run(ctx.env.DB, `DELETE FROM entity_holidays WHERE id = ?`, h.id);
  ctx.audit({ action: 'delete', type: 'holiday', id: h.id, label: h.name, entity_id: h.entity_id, summary: `${ctx.user.name} removed the public holiday ${h.name} (${h.date})` });
  return ok({ id: h.id, deleted: true });
}

// ---- departments ---------------------------------------------------------

async function listDepartments(ctx) {
  const entity = intParam(ctx.url, 'entity_id');
  return ok(await all(ctx.env.DB, `SELECT d.*, u.name AS head_name, e.code AS entity_code,
      (SELECT COUNT(*) FROM users x WHERE x.department_id = d.id AND x.deleted_at IS NULL AND x.active = 1) AS people
    FROM departments d LEFT JOIN users u ON u.id = d.head_user_id LEFT JOIN entities e ON e.id = d.entity_id
    WHERE d.deleted_at IS NULL ${entity ? 'AND d.entity_id = ?' : ''} ORDER BY d.name`, ...(entity ? [entity] : [])));
}

const deptFields = (v) => v.string('name', { min: 2, max: 120, nullable: false }).string('name_el', { max: 120 }).int('entity_id').int('parent_id').int('head_user_id');

async function createDepartment(ctx) {
  const v = deptFields(new Validator(await readJson(ctx.req))).done();
  if (!v.name) throw badRequest('name is required');
  needAdmin(ctx, v.entity_id);
  const id = await insert(ctx.env.DB, 'departments', v);
  ctx.audit({ action: 'create', type: 'department', id, label: v.name, entity_id: v.entity_id, summary: `${ctx.user.name} created the department ${v.name}` });
  return created(await first(ctx.env.DB, `SELECT * FROM departments WHERE id = ?`, id));
}

async function patchDepartment(ctx, { id }) {
  const d = await first(ctx.env.DB, `SELECT * FROM departments WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!d) throw notFound('Department not found');
  needAdmin(ctx, d.entity_id);
  const body = await readJson(ctx.req);
  const v = deptFields(new Validator(body)).done();
  const changes = diff(d, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'departments', d.id, v, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'department', id: d.id, label: d.name, entity_id: d.entity_id, summary: `${ctx.user.name} updated the department ${d.name}: ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM departments WHERE id = ?`, d.id));
}

async function deleteDepartment(ctx, { id }) {
  const d = await first(ctx.env.DB, `SELECT * FROM departments WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!d) throw notFound('Department not found');
  needAdmin(ctx, d.entity_id);
  await ctx.env.DB.batch([
    stmt(ctx.env.DB, `UPDATE departments SET deleted_at = ? WHERE id = ?`, nowIso(), d.id),
    stmt(ctx.env.DB, `UPDATE users SET department_id = NULL WHERE department_id = ?`, d.id),
  ]);
  ctx.audit({ action: 'delete', type: 'department', id: d.id, label: d.name, entity_id: d.entity_id, summary: `${ctx.user.name} removed the department ${d.name}` });
  return ok({ id: d.id, deleted: true });
}

// ---- roles and the access matrix ----------------------------------------

async function listRoles(ctx) {
  const db = ctx.env.DB;
  const [roles, modules, matrix] = await db.batch([
    db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM user_roles ur WHERE ur.role = r.key AND ur.revoked_at IS NULL) AS holders FROM roles r ORDER BY rank DESC`),
    db.prepare(`SELECT * FROM modules`),
    db.prepare(`SELECT * FROM role_module_access`),
  ]);
  return ok({ roles: roles.results, modules: modules.results, matrix: matrix.results });
}

// Replace one role's default levels: body { levels: { module: level } }.
async function putRoleAccess(ctx, { key }) {
  needAdmin(ctx, undefined, ADMIN);
  const role = await first(ctx.env.DB, `SELECT * FROM roles WHERE key = ?`, key);
  if (!role) throw notFound('Role not found');
  const body = await readJson(ctx.req);
  const levels = body.levels || {};
  const modules = new Set((await all(ctx.env.DB, `SELECT key FROM modules`)).map(m => m.key));
  const before = Object.fromEntries((await all(ctx.env.DB, `SELECT module, level FROM role_module_access WHERE role = ?`, key)).map(r => [r.module, r.level]));
  const stmts = [], changes = {};
  for (const [m, l] of Object.entries(levels)) {
    if (!modules.has(m) || ![0, 1, 2, 3].includes(Number(l))) throw badRequest(`Bad level for ${m}`);
    if ((before[m] || 0) !== Number(l)) changes[m] = [before[m] || 0, Number(l)];
    stmts.push(stmt(ctx.env.DB, `INSERT INTO role_module_access (role, module, level) VALUES (?, ?, ?) ON CONFLICT (role, module) DO UPDATE SET level = excluded.level`, key, m, Number(l)));
  }
  if (stmts.length) await ctx.env.DB.batch(stmts);
  if (Object.keys(changes).length) {
    const names = ['none', 'read', 'write', 'admin'];
    ctx.audit({ action: 'update', type: 'role', label: role.label_en,
      summary: `${ctx.user.name} changed default access for ${role.label_en}: ` + Object.entries(changes).map(([m, [a, b]]) => `${m} ${names[a]} → ${names[b]}`).join(', '), changes });
  }
  return listRoles(ctx);
}

async function patchRole(ctx, { key }) {
  needAdmin(ctx, undefined, ADMIN);
  const role = await first(ctx.env.DB, `SELECT * FROM roles WHERE key = ?`, key);
  if (!role) throw notFound('Role not found');
  const v = new Validator(await readJson(ctx.req)).string('label_en', { max: 80, nullable: false }).string('label_el', { max: 80, nullable: false })
    .string('description', { max: 300 }).bool('requires_expiry').done();
  const changes = diff(role, v);
  if (Object.keys(changes).length) {
    const sets = Object.keys(v).map(k => `${k} = ?`).join(', ');
    await run(ctx.env.DB, `UPDATE roles SET ${sets} WHERE key = ?`, ...Object.values(v), key);
    ctx.audit({ action: 'update', type: 'role', label: role.label_en, summary: `${ctx.user.name} edited the ${role.label_en} role: ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM roles WHERE key = ?`, key));
}

// ---- settings ------------------------------------------------------------

async function listSettings(ctx) {
  return ok(await all(ctx.env.DB, `SELECT s.*, u.name AS updated_by_name FROM settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY key`));
}

async function patchSetting(ctx, { key }) {
  needAdmin(ctx, undefined, ADMIN);
  const s = await first(ctx.env.DB, `SELECT * FROM settings WHERE key = ?`, key);
  if (!s) throw notFound('Setting not found');
  const { value } = new Validator(await readJson(ctx.req)).string('value', { required: true, max: 500 }).done();
  if (value !== s.value) {
    await run(ctx.env.DB, `UPDATE settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?`, value, nowIso(), ctx.user.id, key);
    ctx.audit({ action: 'update', type: 'setting', label: key, summary: `${ctx.user.name} changed the setting ${key} from "${s.value}" to "${value}"`, changes: { value: [s.value, value] } });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM settings WHERE key = ?`, key));
}

async function listStatuses(ctx) {
  return ok(await all(ctx.env.DB, `SELECT * FROM task_statuses ORDER BY position`));
}

export default [
  ['GET', '/api/entities', listEntities],
  ['POST', '/api/entities', createEntity],
  ['GET', '/api/entities/:id', getEntity],
  ['PATCH', '/api/entities/:id', patchEntity],
  ['DELETE', '/api/entities/:id', deleteEntity],
  ['GET', '/api/entities/:id/holidays', listHolidays],
  ['POST', '/api/entities/:id/holidays', addHoliday],
  ['DELETE', '/api/holidays/:id', deleteHoliday],
  ['GET', '/api/departments', listDepartments],
  ['POST', '/api/departments', createDepartment],
  ['PATCH', '/api/departments/:id', patchDepartment],
  ['DELETE', '/api/departments/:id', deleteDepartment],
  ['GET', '/api/roles', listRoles],
  ['PATCH', '/api/roles/:key', patchRole],
  ['PUT', '/api/roles/:key/access', putRoleAccess],
  ['GET', '/api/settings', listSettings],
  ['PATCH', '/api/settings/:key', patchSetting],
  ['GET', '/api/task-statuses', listStatuses],
];
