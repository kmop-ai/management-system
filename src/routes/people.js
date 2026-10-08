// Capacity and people: workload per person per week, leave, and the
// evaluation metrics (restricted by role; see Access.canSeeMetricsOf).

import { ok, created, readJson, Validator, param, intParam, idList, notFound, forbidden, badRequest, pageParams, listMeta, sortClause } from '../lib/http.js';
import { first, all, insert, update, run, paged, nowIso, today, expectedVersion, jsonIds } from '../lib/db.js';
import { READ, WRITE } from '../lib/rbac.js';
import { addDays, mondayOf, isoWeekday, daysBetween } from '../lib/dates.js';
import { diff, describeChanges } from '../lib/audit.js';
import { loadProject } from '../lib/load.js';

// ---- workload ------------------------------------------------------------
//
// For each person and week:
//   capacity  = weekly_hours spread over their work days, minus public
//               holidays of their entity and their own leave
//   allocated = Σ allocation FTE% × their base hours on the days it covers —
//               what projects were promised
//   tasks     = Σ open task estimates spread evenly over the task's working
//               days (start → due; no start = the five working days up to
//               the due date) — what the work actually asks
// The gap between allocated and tasks is the reconciliation the brief asks
// for: a person can be 100% allocated and 140% booked.

function workingDays(user, holidays, leave, from, to) {
  const days = [];
  const wd = new Set((user.work_days || '12345').split('').map(Number));
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!wd.has(isoWeekday(d)) || holidays.has(d)) continue;
    const l = leave.find(x => x.start_date <= d && x.end_date >= d);
    days.push({ date: d, factor: l ? (l.half_day ? 0.5 : 0) : 1 });
  }
  return days;
}

async function workload(ctx) {
  const { url, access } = ctx;
  const from = mondayOf(param(url, 'from') || today());
  const weeks = Math.min(Math.max(intParam(url, 'weeks') || 8, 1), 26);
  const to = addDays(from, weeks * 7 - 1);
  const db = ctx.env.DB;

  // Who: explicit ids, a project's members, a department, an entity, or me.
  let people;
  const projectId = intParam(url, 'project_id');
  const ids = idList(url, 'user_ids');
  const dept = intParam(url, 'department_id'), entity = intParam(url, 'entity_id');
  const base = `SELECT id, name, entity_id, department_id, weekly_hours, work_days, is_external FROM users WHERE deleted_at IS NULL AND active = 1 AND is_external = 0`;
  if (projectId) {
    await loadProject(ctx, projectId);
    people = await all(db, `${base} AND id IN (SELECT user_id FROM project_members WHERE project_id = ? AND removed_at IS NULL) ORDER BY name`, projectId);
  } else if (ids) people = await all(db, `${base} AND id IN (SELECT value FROM json_each(?)) ORDER BY name`, jsonIds(ids));
  else if (dept) people = await all(db, `${base} AND department_id = ? ORDER BY name`, dept);
  else if (entity) people = await all(db, `${base} AND entity_id = ? ORDER BY name`, entity);
  else if (param(url, 'scope') === 'all') people = await all(db, `${base} ORDER BY name`);
  else people = await all(db, `${base} AND id = ?`, ctx.user.id);
  // Outside a shared project, you only see the workload of people your
  // 'people' access covers.
  if (!projectId) people = people.filter(p => access.canSeePerson(p));
  if (!people.length) return ok({ from, to, weeks: [], people: [], projects: {} });

  const uids = jsonIds(people.map(p => p.id));
  const pv = access.projectsVisibleSql('p');
  const [tasks, allocs, leave, hols, projs] = await db.batch([
    db.prepare(`SELECT t.id, t.title, t.assignee_id, t.project_id, t.start_date, t.due_date, t.estimate_hours, t.is_internal
                  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
                 WHERE t.deleted_at IS NULL AND t.completed_at IS NULL AND t.assignee_id IN (SELECT value FROM json_each(?))
                   AND t.estimate_hours > 0 AND (p.id IS NULL OR (p.deleted_at IS NULL AND p.archived_at IS NULL))
                   AND (t.due_date IS NULL OR t.due_date >= ? OR t.due_date < ?) AND COALESCE(t.start_date, t.due_date, '0000') <= ?`).bind(uids, addDays(from, -7), from, to),
    db.prepare(`SELECT a.user_id, a.project_id, a.start_date, a.end_date, a.fte_pct FROM allocations a JOIN projects p ON p.id = a.project_id
                 WHERE a.deleted_at IS NULL AND p.deleted_at IS NULL AND a.user_id IN (SELECT value FROM json_each(?)) AND a.start_date <= ? AND a.end_date >= ?`).bind(uids, to, from),
    db.prepare(`SELECT user_id, start_date, end_date, half_day, kind FROM leave WHERE deleted_at IS NULL AND user_id IN (SELECT value FROM json_each(?)) AND start_date <= ? AND end_date >= ?`).bind(uids, to, from),
    db.prepare(`SELECT entity_id, date FROM entity_holidays WHERE date BETWEEN ? AND ?`).bind(from, to),
    db.prepare(`SELECT p.id, p.name, p.code, p.color, (${pv.sql}) AS visible FROM projects p WHERE p.deleted_at IS NULL`).bind(...pv.params),
  ]);
  const visible = new Map(projs.results.map(p => [p.id, p]));
  const todayStr = today();
  const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(from, i * 7));
  const out = [];
  for (const u of people) {
    const hol = new Set(hols.results.filter(h => h.entity_id === u.entity_id).map(h => h.date));
    const lv = leave.results.filter(l => l.user_id === u.id);
    const nWorkDays = Math.max(1, (u.work_days || '12345').length);
    const daily = (u.weekly_hours || 0) / nWorkDays;
    const allDays = workingDays(u, new Set(), [], from, to); // nominal days, for allocations
    const realDays = workingDays(u, hol, lv, from, to);
    const row = { id: u.id, name: u.name, entity_id: u.entity_id, weekly_hours: u.weekly_hours, overdue_hours: 0, unscheduled_hours: 0, overdue_tasks: 0,
      weeks: weekStarts.map(w => ({ start: w, capacity: 0, leave: 0, allocated: 0, tasks: 0, by_project: {} })) };
    const wk = (d) => Math.floor(daysBetween(from, d) / 7);
    for (const d of realDays) { const w = row.weeks[wk(d.date)]; w.capacity += daily * d.factor; }
    for (const d of allDays) {
      const w = row.weeks[wk(d.date)];
      const off = hol.has(d.date) ? 1 : (lv.find(x => x.start_date <= d.date && x.end_date >= d.date) ? (lv.find(x => x.start_date <= d.date && x.end_date >= d.date).half_day ? 0.5 : 1) : 0);
      w.leave += daily * off;
      for (const a of allocs.results) if (a.user_id === u.id && a.start_date <= d.date && a.end_date >= d.date) w.allocated += daily * a.fte_pct / 100;
    }
    for (const t of tasks.results) {
      if (t.assignee_id !== u.id) continue;
      if (!t.due_date) { row.unscheduled_hours += t.estimate_hours; continue; }
      if (t.due_date < todayStr && t.due_date < from) { row.overdue_hours += t.estimate_hours; row.overdue_tasks++; continue; }
      let span;
      if (t.start_date) span = workingDays(u, hol, [], t.start_date, t.due_date);
      else { span = []; for (let d = t.due_date; span.length < 5 && d >= addDays(t.due_date, -14); d = addDays(d, -1)) { if ((u.work_days || '12345').includes(String(isoWeekday(d))) && !hol.has(d)) span.push({ date: d, factor: 1 }); } }
      if (!span.length) span = [{ date: t.due_date, factor: 1 }];
      const per = t.estimate_hours / span.length;
      const key = t.project_id && visible.get(t.project_id)?.visible ? t.project_id : (t.project_id ? 'other' : 'personal');
      for (const d of span) {
        if (d.date < from || d.date > to) continue;
        const w = row.weeks[wk(d.date)];
        w.tasks += per;
        w.by_project[key] = (w.by_project[key] || 0) + per;
      }
    }
    const r1 = (x) => Math.round(x * 10) / 10;
    for (const w of row.weeks) {
      w.capacity = r1(w.capacity); w.leave = r1(w.leave); w.allocated = r1(w.allocated); w.tasks = r1(w.tasks);
      for (const k of Object.keys(w.by_project)) w.by_project[k] = r1(w.by_project[k]);
      w.load_pct = w.capacity ? Math.round(w.tasks / w.capacity * 100) : (w.tasks ? 999 : 0);
    }
    row.overdue_hours = r1(row.overdue_hours); row.unscheduled_hours = r1(row.unscheduled_hours);
    out.push(row);
  }
  const projects = {};
  for (const p of projs.results) if (p.visible) projects[p.id] = { name: p.name, code: p.code, color: p.color };
  return ok({ from, to, weeks: weekStarts, people: out, projects });
}

// ---- evaluation metrics --------------------------------------------------
//
// Definitions travel with the numbers, so the person and their manager are
// reading the same thing. Window: last 90 days.

export const METRIC_DEFINITIONS = {
  open_tasks: 'Tasks assigned to the person that are not done or cancelled.',
  overdue_tasks: 'Open tasks whose due date has passed.',
  completed_90d: 'Tasks the person completed in the last 90 days.',
  on_time_rate: 'Of the tasks completed in the last 90 days that had a due date, the share completed on or before it.',
  avg_days_in_hand: 'Average days between a task being assigned to the person and its completion, over the last 90 days.',
  open_avg_age_days: 'Average days the currently open tasks have been with the person since assignment.',
  active_projects: 'Projects the person is a member of that are not closed or archived.',
};

async function metrics(ctx, { id }) {
  const u = await first(ctx.env.DB, `SELECT id, name, entity_id, department_id, is_external FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  if (!ctx.access.canSeeMetricsOf(u)) throw forbidden('Evaluation metrics are restricted to management roles');
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const r = await first(ctx.env.DB, `SELECT
      (SELECT COUNT(*) FROM tasks WHERE assignee_id = ?1 AND deleted_at IS NULL AND completed_at IS NULL) AS open_tasks,
      (SELECT COUNT(*) FROM tasks WHERE assignee_id = ?1 AND deleted_at IS NULL AND completed_at IS NULL AND due_date < date('now')) AS overdue_tasks,
      (SELECT COUNT(*) FROM tasks t JOIN task_statuses s ON s.key = t.status WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL AND t.completed_at >= ?2 AND s.category = 'done') AS completed_90d,
      (SELECT COUNT(*) FROM tasks t JOIN task_statuses s ON s.key = t.status WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL AND t.completed_at >= ?2 AND s.category = 'done' AND t.due_date IS NOT NULL) AS with_due_90d,
      (SELECT COUNT(*) FROM tasks t JOIN task_statuses s ON s.key = t.status WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL AND t.completed_at >= ?2 AND s.category = 'done' AND t.due_date IS NOT NULL AND substr(t.completed_at, 1, 10) <= t.due_date) AS on_time_90d,
      (SELECT AVG(julianday(t.completed_at) - julianday(t.assigned_at)) FROM tasks t WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL AND t.completed_at >= ?2 AND t.assigned_at IS NOT NULL) AS avg_days_in_hand,
      (SELECT AVG(julianday('now') - julianday(t.assigned_at)) FROM tasks t WHERE t.assignee_id = ?1 AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.assigned_at IS NOT NULL) AS open_avg_age_days,
      (SELECT COUNT(*) FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?1 AND m.removed_at IS NULL AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.status <> 'closed') AS active_projects`,
    u.id, since);
  const round = (x) => x == null ? null : Math.round(x * 10) / 10;
  const roles = await all(ctx.env.DB, `SELECT r.label_en, r.label_el FROM role_module_access rma JOIN roles r ON r.key = rma.role WHERE rma.module = 'people_metrics' AND rma.level >= 1 ORDER BY r.rank DESC`);
  return ok({
    user_id: u.id, name: u.name, window_days: 90,
    open_tasks: r.open_tasks, overdue_tasks: r.overdue_tasks, completed_90d: r.completed_90d,
    on_time_rate: r.with_due_90d ? Math.round(r.on_time_90d / r.with_due_90d * 100) : null,
    on_time_basis: r.with_due_90d,
    avg_days_in_hand: round(r.avg_days_in_hand), open_avg_age_days: round(r.open_avg_age_days), active_projects: r.active_projects,
    definitions: METRIC_DEFINITIONS,
    // Who else sees these exact numbers: shown on the person's own page.
    visible_to: { roles, self: ctx.access.settings.people_metrics_self_visible !== '0' },
  });
}

// ---- leave ---------------------------------------------------------------

async function listLeave(ctx) {
  const { url, access } = ctx;
  const where = ['l.deleted_at IS NULL', 'u.deleted_at IS NULL'], params = [];
  const user = param(url, 'user_id');
  if (user) {
    const uid = user === 'me' ? ctx.user.id : Number(user);
    const target = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ?`, uid);
    if (!target || !access.canSeePerson(target)) throw forbidden();
    where.push('l.user_id = ?'); params.push(uid);
  } else {
    const s = access.scope('people', READ);
    where.push(`(l.user_id = ? OR u.entity_id IN (SELECT value FROM json_each(?)) OR u.department_id IN (SELECT value FROM json_each(?)))`);
    params.push(ctx.user.id, JSON.stringify(s.entities), JSON.stringify(s.departments));
  }
  const from = param(url, 'from'); if (from) { where.push('l.end_date >= ?'); params.push(from); }
  const to = param(url, 'to'); if (to) { where.push('l.start_date <= ?'); params.push(to); }
  const pg = pageParams(url, { defaultLimit: 200, maxLimit: 500 });
  const { total, rows } = await paged(ctx.env.DB, {
    // The kind of leave is shown only to the person and to people-admins; colleagues see "away".
    select: `l.id, l.user_id, l.start_date, l.end_date, l.half_day, l.updated_at, u.name AS user_name, l.kind, l.note`,
    from: `leave l JOIN users u ON u.id = l.user_id`, where, params,
    order: sortClause(url, { start: 'l.start_date', user: 'u.name' }, 'start'), ...pg,
  });
  for (const r of rows) {
    const canSeeKind = r.user_id === ctx.user.id || access.level('people', undefined) >= WRITE;
    if (!canSeeKind) { r.kind = 'away'; r.note = null; }
  }
  return ok(rows, listMeta(total, pg, rows.length));
}

async function canEditLeaveFor(ctx, userId) {
  if (userId === ctx.user.id) return true;
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ?`, userId);
  if (!u || !ctx.access.canEditPerson(u)) throw forbidden('You can only record leave for yourself');
  return true;
}

const leaveFields = (v) => v.date('start_date').date('end_date').oneOf('kind', ['annual', 'sick', 'training', 'unpaid', 'other']).bool('half_day').string('note', { max: 300 });

async function createLeave(ctx) {
  const v = leaveFields(new Validator(await readJson(ctx.req)).int('user_id')).done();
  const uid = v.user_id || ctx.user.id;
  await canEditLeaveFor(ctx, uid);
  if (!v.start_date || !v.end_date) throw badRequest('start_date and end_date are required');
  if (v.end_date < v.start_date) throw badRequest('end_date is before start_date');
  const id = await insert(ctx.env.DB, 'leave', { ...v, user_id: uid, created_by: ctx.user.id });
  const name = uid === ctx.user.id ? ctx.user.name : (await first(ctx.env.DB, `SELECT name FROM users WHERE id = ?`, uid)).name;
  ctx.audit({ action: 'create', type: 'leave', id, label: name, summary: `${ctx.user.name} recorded leave for ${name} from ${v.start_date} to ${v.end_date}` });
  return created(await first(ctx.env.DB, `SELECT * FROM leave WHERE id = ?`, id));
}

async function patchLeave(ctx, { id }) {
  const l = await first(ctx.env.DB, `SELECT l.*, u.name AS user_name FROM leave l JOIN users u ON u.id = l.user_id WHERE l.id = ? AND l.deleted_at IS NULL`, Number(id));
  if (!l) throw notFound('Leave not found');
  await canEditLeaveFor(ctx, l.user_id);
  const body = await readJson(ctx.req);
  const v = leaveFields(new Validator(body)).done();
  const s = v.start_date ?? l.start_date, e = v.end_date ?? l.end_date;
  if (e < s) throw badRequest('end_date is before start_date');
  const changes = diff(l, v);
  if (Object.keys(changes).length) {
    await update(ctx.env.DB, 'leave', l.id, v, { expected: expectedVersion(ctx.req, body) });
    ctx.audit({ action: 'update', type: 'leave', id: l.id, label: l.user_name, summary: `${ctx.user.name} changed leave for ${l.user_name}: ${describeChanges(changes)}`, changes });
  }
  return ok(await first(ctx.env.DB, `SELECT * FROM leave WHERE id = ?`, l.id));
}

async function deleteLeave(ctx, { id }) {
  const l = await first(ctx.env.DB, `SELECT l.*, u.name AS user_name FROM leave l JOIN users u ON u.id = l.user_id WHERE l.id = ? AND l.deleted_at IS NULL`, Number(id));
  if (!l) throw notFound('Leave not found');
  await canEditLeaveFor(ctx, l.user_id);
  await run(ctx.env.DB, `UPDATE leave SET deleted_at = ? WHERE id = ?`, nowIso(), l.id);
  ctx.audit({ action: 'delete', type: 'leave', id: l.id, label: l.user_name, summary: `${ctx.user.name} removed leave for ${l.user_name} (${l.start_date} – ${l.end_date})` });
  return ok({ id: l.id, deleted: true });
}

export default [
  ['GET', '/api/workload', workload],
  ['GET', '/api/people/:id/metrics', metrics],
  ['GET', '/api/leave', listLeave],
  ['POST', '/api/leave', createLeave],
  ['PATCH', '/api/leave/:id', patchLeave],
  ['DELETE', '/api/leave/:id', deleteLeave],
];
