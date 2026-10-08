// Access control.
//
// Two separate dimensions, as the brief defines them:
//   * ROLE (users.role): super_admin, admin, member, supervisor.
//       super_admin — everything, including Team and Access. Also forced
//                     from configuration (SUPER_ADMINS) so the people who run
//                     the system cannot be locked out from the UI.
//       admin       — write on every module except Team and Access.
//       member      — exactly the modules granted to them.
//       supervisor  — read and comment only, on granted modules AND on the
//                     projects named in supervisor_projects. Never writes.
//   * MODULE access (module_grants): one row per person per module, read or
//     write. No row, no page — the sidebar is built from this.
// Project membership (pm / member / viewer) still decides who manages and
// works on a given project, inside the projects module.
//
// Everything is loaded once per request in one D1 batch; list endpoints get
// SQL predicates from here so filtering happens in the database.

import { forbidden } from './http.js';
import { jsonIds } from './db.js';
import { MODULES, SUPERVISOR_MODULES } from './modules.js';

export const NONE = 0, READ = 1, WRITE = 2, ADMIN = 3;

export function configSuperAdmins(env) {
  return (env.SUPER_ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

export async function loadAccess(db, user, env = {}) {
  const [grants, members, supervised, entities, settings] = await db.batch([
    db.prepare(`SELECT module, access FROM module_grants WHERE user_id = ?`).bind(user.id),
    db.prepare(`SELECT pm.project_id, pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
                 WHERE pm.user_id = ? AND pm.removed_at IS NULL AND p.deleted_at IS NULL`).bind(user.id),
    db.prepare(`SELECT sp.project_id FROM supervisor_projects sp JOIN projects p ON p.id = sp.project_id
                 WHERE sp.user_id = ? AND p.deleted_at IS NULL`).bind(user.id),
    db.prepare(`SELECT id FROM entities WHERE deleted_at IS NULL`),
    db.prepare(`SELECT key, value FROM settings`),
  ]);
  const role = configSuperAdmins(env).includes(String(user.email).toLowerCase()) ? 'super_admin' : (user.role || 'member');
  return new Access(user, role, grants.results, members.results, supervised.results.map(r => r.project_id),
    entities.results.map(e => e.id), Object.fromEntries(settings.results.map(s => [s.key, s.value])));
}

export class Access {
  constructor(user, role, grants, members, supervised, entityIds, settings) {
    this.user = user;
    this.role = role;
    this.settings = settings;
    this.entityIds = entityIds;
    this.grants = Object.fromEntries(grants.map(g => [g.module, g.access]));
    this.membership = new Map(members.map(m => [m.project_id, m.role]));
    this.supervised = new Set(supervised);
    // Old role ranks, still used where one person grants something to another.
    this.maxRank = { super_admin: 100, admin: 90, member: 20, supervisor: 5 }[role] || 0;
  }

  get isSuperAdmin() { return this.role === 'super_admin'; }
  get isAdmin() { return this.role === 'super_admin' || this.role === 'admin'; }
  get isSupervisor() { return this.role === 'supervisor'; }
  hasRole(...keys) { return keys.includes(this.role); }

  // The effective access to one of the brief's modules: 'write' | 'read' | null.
  grant(module) {
    const def = MODULES.find(m => m.key === module);
    if (def?.everyone) return 'read';
    if (this.role === 'super_admin') return 'write';
    if (def?.superAdminOnly) return null;
    if (this.role === 'admin') return 'write';
    const g = this.grants[module] || null;
    if (this.role === 'supervisor') return g && SUPERVISOR_MODULES.includes(module) ? 'read' : null;
    return g;
  }

  // Numeric level (0 none, 1 read, 2 write, 3 admin) for a module key —
  // the brief's modules, plus the internal capability names the routes use.
  level(module) {
    if (this.role === 'super_admin') return ADMIN;
    const g = (k) => ({ write: WRITE, read: READ })[this.grant(k)] || NONE;
    switch (module) {
      case 'projects':        // see every project, not only one's own
        return this.role === 'admin' ? WRITE : this.role === 'member' && this.grant('projects') ? READ : NONE;
      case 'project_create':  return this.role === 'supervisor' ? NONE : g('projects') >= WRITE ? WRITE : NONE;
      case 'templates':       return this.role === 'supervisor' ? NONE : g('projects');
      case 'people':          // staff directory and capacity (not the CRM)
        return this.role === 'admin' ? WRITE : this.role === 'member' ? READ : NONE;
      case 'people_metrics':  return this.role === 'admin' ? READ : NONE;
      case 'admin':           return NONE; // Team and Access: super admin only
      case 'audit':           return this.role === 'admin' ? READ : NONE;
      case 'pipeline':        return g('proposals');
      case 'portfolio':       return g('reporting');
      case 'finance': case 'salaries': case 'rules': return this.role === 'admin' ? READ : NONE;
      default:                return g(module);
    }
  }

  require(module, min = READ) {
    if (this.level(module) < min) throw forbidden(`Requires ${['', 'read', 'write', 'admin'][min]} access to ${module}`);
  }

  // Kept for callers written for the entity-scoped model: access is no
  // longer entity-scoped, so a level anywhere is a level everywhere.
  scope(module, min = READ) {
    const ok = this.level(module) >= min;
    return { entities: ok ? [...this.entityIds] : [], departments: [], all: ok };
  }

  // ---- projects ----------------------------------------------------------

  projectRole(projectId) { return this.membership.get(projectId) || null; }

  project(p) {
    if (this.role === 'supervisor') {
      const see = this.supervised.has(p.id) && !!this.grant('projects');
      return { role: see ? 'supervisor' : null, see, work: false, manage: false, guest: see, comment: see, supervisor: true };
    }
    const role = this.projectRole(p.id);
    const scoped = this.level('projects');
    const sameEntity = p.visibility === 'entity' && !this.user.is_external && this.user.entity_id === p.entity_id;
    const manage = role === 'pm' || scoped >= WRITE;
    const work = manage || role === 'member';
    const see = work || role === 'viewer' || role === 'guest' || scoped >= READ || sameEntity;
    const guest = role === 'guest' && scoped < READ;
    return { role, see, work, manage, guest, comment: see && role !== 'viewer' || scoped >= READ };
  }

  requireProject(p, what = 'see') {
    if (!p) throw forbidden();
    const a = this.project(p);
    if (!a[what]) throw forbidden(what === 'see' ? 'You are not a member of this project' : 'You cannot change this project');
    return a;
  }

  // SQL predicate over a projects alias: every project this person can see.
  projectsVisibleSql(alias = 'p') {
    if (this.role === 'supervisor') {
      const ids = this.grant('projects') ? [...this.supervised] : [];
      return { sql: `(${alias}.id IN (SELECT value FROM json_each(?)) OR 0 = ? OR 0 = ?)`, params: [jsonIds(ids), 1, 1] };
    }
    const all = this.level('projects') >= READ ? 1 : 0;
    const sql = `(${alias}.id IN (SELECT value FROM json_each(?)) OR ? = 1
      OR (${alias}.visibility = 'entity' AND ${alias}.entity_id = ?))`;
    return { sql, params: [jsonIds([...this.membership.keys()]), all, this.user.is_external ? -1 : (this.user.entity_id ?? -1)] };
  }

  // Projects where internal tasks must stay hidden: guest memberships, and
  // every project seen as a supervisor (funders do not read our chasing).
  guestProjectIds() {
    const out = [...this.supervised];
    for (const [pid, role] of this.membership) if (role === 'guest') out.push(pid);
    return out;
  }

  // SQL predicate over tasks t LEFT JOIN projects p: every task this person can see.
  tasksVisibleSql(t = 't', p = 'p') {
    const pv = this.projectsVisibleSql(p);
    const uid = this.user.id;
    const sql = `((${t}.project_id IS NULL AND (${t}.created_by = ? OR ${t}.assignee_id = ?
                  OR EXISTS (SELECT 1 FROM task_followers f WHERE f.task_id = ${t}.id AND f.user_id = ?)))
               OR (${t}.project_id IS NOT NULL AND ${p}.deleted_at IS NULL AND ${pv.sql}
                  AND (${t}.is_internal = 0 OR ${t}.project_id NOT IN (SELECT value FROM json_each(?)))))`;
    return { sql, params: [uid, uid, uid, ...pv.params, jsonIds(this.guestProjectIds())] };
  }

  task(t, p, { following = false } = {}) {
    if (!t.project_id) {
      const mine = t.created_by === this.user.id || t.assignee_id === this.user.id;
      return { see: mine || following, edit: mine && !this.isSupervisor, comment: mine || following, manage: t.created_by === this.user.id };
    }
    const a = this.project(p);
    if (!a.see || (a.guest && t.is_internal)) return { see: false, edit: false, comment: false, manage: false };
    const edit = !a.supervisor && (a.work || (t.assignee_id === this.user.id && a.role !== 'viewer'));
    return { see: true, edit, comment: a.comment, manage: a.manage || (t.created_by === this.user.id && a.work) };
  }

  // ---- people ------------------------------------------------------------

  canSeeMetricsOf(target) {
    if (target.id === this.user.id) return this.settings.people_metrics_self_visible !== '0' || this.level('people_metrics') >= READ;
    return this.level('people_metrics') >= READ;
  }

  canSeePerson(target) {
    if (target.id === this.user.id) return true;
    if (this.user.is_external || this.isSupervisor) return false;
    return this.level('people') >= READ;
  }

  canEditPerson() { return this.isSuperAdmin; }

  summary() {
    const modules = {};
    for (const m of MODULES) { const g = this.grant(m.key); if (g) modules[m.key] = g; }
    const levels = {};
    for (const k of ['projects', 'project_create', 'people', 'people_metrics', 'templates', 'admin', 'audit']) levels[k] = this.level(k);
    return {
      role: this.role,
      modules,                      // the brief's modules: { key: 'read' | 'write' }
      levels,                       // internal capabilities, 0–3
      projects: Object.fromEntries(this.membership),
      supervised_projects: [...this.supervised],
      people_metrics_self_visible: this.settings.people_metrics_self_visible !== '0',
    };
  }
}
