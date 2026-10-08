// Access control.
//
// Three layers, evaluated in this order:
//   1. Project membership (pm / member / viewer / guest) — the everyday case.
//      Members see and work on their own projects whatever their role.
//   2. Role grants (user_roles × role_module_access) — scoped to all entities,
//      one entity, or one department. This is what lets the GM see every
//      project and a Greek finance lead see only their entity's money.
//   3. Per-person overrides (module_access) — replace the role-derived level
//      for a module in a scope; they can raise or lower it.
//
// Everything is loaded once per request in a single D1 batch, then answered
// from memory. List endpoints get SQL predicates from here so the filtering
// happens in the database, never by fetching rows and dropping them.

import { forbidden } from './http.js';
import { jsonIds } from './db.js';

export const NONE = 0, READ = 1, WRITE = 2, ADMIN = 3;

export async function loadAccess(db, user) {
  const today = new Date().toISOString().slice(0, 10);
  const [roles, levels, overrides, members, entities, settings] = await db.batch([
    db.prepare(`SELECT ur.id, ur.role, ur.entity_id, ur.department_id, ur.valid_until, r.rank
                  FROM user_roles ur JOIN roles r ON r.key = ur.role
                 WHERE ur.user_id = ? AND ur.revoked_at IS NULL
                   AND (ur.valid_from IS NULL OR ur.valid_from <= ?)
                   AND (ur.valid_until IS NULL OR ur.valid_until >= ?)`).bind(user.id, today, today),
    db.prepare(`SELECT rma.role, rma.module, rma.level FROM role_module_access rma
                 WHERE rma.level > 0 AND rma.role IN (
                   SELECT role FROM user_roles WHERE user_id = ? AND revoked_at IS NULL
                     AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until >= ?))`).bind(user.id, today, today),
    db.prepare(`SELECT module, entity_id, level FROM module_access
                 WHERE user_id = ? AND revoked_at IS NULL AND (valid_until IS NULL OR valid_until >= ?)`).bind(user.id, today),
    db.prepare(`SELECT pm.project_id, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
                 WHERE pm.user_id = ? AND pm.removed_at IS NULL AND p.deleted_at IS NULL`).bind(user.id),
    db.prepare(`SELECT id FROM entities WHERE deleted_at IS NULL`),
    db.prepare(`SELECT key, value FROM settings`),
  ]);
  return new Access(user, roles.results, levels.results, overrides.results, members.results,
    entities.results.map(e => e.id), Object.fromEntries(settings.results.map(s => [s.key, s.value])));
}

export class Access {
  constructor(user, roles, levels, overrides, members, entityIds, settings) {
    this.user = user;
    this.roles = roles;
    this.settings = settings;
    this.entityIds = entityIds;
    this.maxRank = roles.reduce((m, r) => Math.max(m, r.rank), 0);
    // grants[module] = [{entity_id, department_id, level}]
    this.grants = {};
    for (const r of roles) {
      for (const l of levels) {
        if (l.role !== r.role) continue;
        (this.grants[l.module] ||= []).push({ entity_id: r.entity_id, department_id: r.department_id, level: l.level });
      }
    }
    this.overrides = {};
    for (const o of overrides) (this.overrides[o.module] ||= []).push(o);
    this.membership = new Map(members.map(m => [m.project_id, m.role]));
  }

  hasRole(...keys) { return this.roles.some(r => keys.includes(r.role)); }
  get isSuperAdmin() { return this.hasRole('super_admin'); }

  // Level for a module at a point in the organisation. entityId/deptId
  // undefined asks "anywhere at all" (e.g. may this person create projects?).
  level(module, entityId, deptId) {
    if (entityId === undefined) {
      let best = NONE;
      for (const e of this.entityIds) best = Math.max(best, this.level(module, e, null));
      for (const g of this.grants[module] || []) if (g.department_id != null) best = Math.max(best, g.level);
      const ov = this.overrides[module] || [];
      if (!this.entityIds.length) for (const o of ov) best = Math.max(best, o.level);
      return best;
    }
    const ov = this.overrides[module];
    if (ov && ov.length) {
      const specific = ov.find(o => o.entity_id === entityId) || ov.find(o => o.entity_id == null);
      if (specific) return specific.level;
    }
    return this._roleLevel(module, entityId, deptId);
  }

  _roleLevel(module, entityId, deptId) {
    let best = NONE;
    for (const g of this.grants[module] || []) {
      if (entityId !== undefined) {
        if (g.entity_id != null && g.entity_id !== entityId) continue;
        if (g.department_id != null && g.department_id !== deptId) continue;
      }
      if (g.level > best) best = g.level;
    }
    return best;
  }

  require(module, min = READ, entityId, deptId) {
    if (this.level(module, entityId, deptId) < min) throw forbidden(`Requires ${['', 'read', 'write', 'admin'][min]} access to ${module}`);
  }

  // Where (which entities, which departments) this person holds at least
  // `min` on `module`. Used to build SQL predicates.
  scope(module, min = READ) {
    const entities = [], departments = [];
    const ov = this.overrides[module] || [];
    for (const e of this.entityIds) {
      const o = ov.find(x => x.entity_id === e) || ov.find(x => x.entity_id == null);
      if (o) { if (o.level >= min) entities.push(e); continue; }
      const wide = (this.grants[module] || []).some(g => g.level >= min && g.department_id == null && (g.entity_id == null || g.entity_id === e));
      if (wide) entities.push(e);
    }
    for (const g of this.grants[module] || []) {
      if (g.level >= min && g.department_id != null && !departments.includes(g.department_id)) departments.push(g.department_id);
    }
    return { entities, departments, all: entities.length === this.entityIds.length && this.entityIds.length > 0 };
  }

  // ---- projects ----------------------------------------------------------

  projectRole(projectId) { return this.membership.get(projectId) || null; }

  project(p) {
    const role = this.projectRole(p.id);
    const scoped = this.level('projects', p.entity_id, p.department_id);
    const sameEntity = p.visibility === 'entity' && !this.user.is_external && this.user.entity_id === p.entity_id;
    const manage = role === 'pm' || scoped >= WRITE;
    const work = manage || role === 'member';
    const see = work || role === 'viewer' || role === 'guest' || scoped >= READ || sameEntity;
    // A guest is someone whose only window into this project is guest
    // membership; they never see tasks flagged internal.
    const guest = role === 'guest' && scoped < READ;
    return { role, see, work, manage, guest, comment: see && role !== 'viewer' };
  }

  requireProject(p, what = 'see') {
    if (!p) throw forbidden();
    const a = this.project(p);
    if (!a[what]) throw forbidden(what === 'see' ? 'You are not a member of this project' : 'You cannot change this project');
    return a;
  }

  // SQL predicate over a projects alias: true for every project this person
  // can see. Binds three parameters, returned in order.
  projectsVisibleSql(alias = 'p') {
    const s = this.scope('projects', READ);
    const memberIds = [...this.membership.keys()];
    const sql = `(${alias}.id IN (SELECT value FROM json_each(?))
      OR ${alias}.entity_id IN (SELECT value FROM json_each(?))
      OR ${alias}.department_id IN (SELECT value FROM json_each(?))
      OR (${alias}.visibility = 'entity' AND ${alias}.entity_id = ?))`;
    const params = [jsonIds(memberIds), jsonIds(s.entities), jsonIds(s.departments),
      this.user.is_external ? -1 : (this.user.entity_id ?? -1)];
    return { sql, params };
  }

  guestProjectIds() {
    const out = [];
    for (const [pid, role] of this.membership) if (role === 'guest') out.push(pid);
    return out;
  }

  // SQL predicate over tasks t LEFT JOIN projects p: every task this person
  // can see. Personal tasks are private to creator, assignee and followers;
  // project tasks follow project visibility, minus internal ones for guests.
  tasksVisibleSql(t = 't', p = 'p') {
    const pv = this.projectsVisibleSql(p);
    const uid = this.user.id;
    const sql = `((${t}.project_id IS NULL AND (${t}.created_by = ? OR ${t}.assignee_id = ?
                  OR EXISTS (SELECT 1 FROM task_followers f WHERE f.task_id = ${t}.id AND f.user_id = ?)))
               OR (${t}.project_id IS NOT NULL AND ${p}.deleted_at IS NULL AND ${pv.sql}
                  AND (${t}.is_internal = 0 OR ${t}.project_id NOT IN (SELECT value FROM json_each(?)))))`;
    return { sql, params: [uid, uid, uid, ...pv.params, jsonIds(this.guestProjectIds())] };
  }

  // Access to one task, given the task row and (for project tasks) its project.
  task(t, p, { following = false } = {}) {
    if (!t.project_id) {
      const mine = t.created_by === this.user.id || t.assignee_id === this.user.id;
      return { see: mine || following, edit: mine, comment: mine || following, manage: t.created_by === this.user.id };
    }
    const a = this.project(p);
    if (!a.see || (a.guest && t.is_internal)) return { see: false, edit: false, comment: false, manage: false };
    // Guests may move along what is assigned to them — that is the point of inviting them.
    const edit = a.work || (t.assignee_id === this.user.id && a.role !== 'viewer');
    return { see: true, edit, comment: a.comment, manage: a.manage || t.created_by === this.user.id && a.work };
  }

  // ---- people ------------------------------------------------------------

  // Evaluation metrics about a person. Restricted by role (people_metrics);
  // the person themselves sees their own numbers unless an admin has
  // deliberately switched that off in settings.
  canSeeMetricsOf(target) {
    if (target.id === this.user.id) return this.settings.people_metrics_self_visible !== '0' || this.level('people_metrics') >= READ;
    return this.level('people_metrics', target.entity_id ?? null, target.department_id ?? null) >= READ;
  }

  canSeePerson(target) {
    if (target.id === this.user.id) return true;
    if (this.user.is_external) return false; // guests only see co-members, via project member lists
    return this.level('people', target.entity_id ?? null, target.department_id ?? null) >= READ;
  }

  canEditPerson(target) {
    return this.level('admin', target.entity_id ?? null) >= WRITE || this.level('people', target.entity_id ?? null, target.department_id ?? null) >= WRITE;
  }

  summary() {
    const modules = {};
    for (const m of new Set([...Object.keys(this.grants), ...Object.keys(this.overrides)])) modules[m] = this.level(m);
    return {
      roles: this.roles.map(r => ({ role: r.role, entity_id: r.entity_id, department_id: r.department_id, valid_until: r.valid_until })),
      modules,
      projects: Object.fromEntries(this.membership),
      people_metrics_self_visible: this.settings.people_metrics_self_visible !== '0',
    };
  }
}
