// Loading single objects together with the caller's access to them. Every
// route that touches a project or task goes through here, so "can this
// person see this?" is answered in exactly one place.

import { first, all, jsonIds } from './db.js';
import { notFound, forbidden } from './http.js';

export async function loadProject(ctx, id, need = 'see') {
  const p = await first(ctx.env.DB, `SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!p) throw notFound('Project not found');
  const a = ctx.access.project(p);
  if (!a.see) throw notFound('Project not found'); // do not confirm existence to non-members
  if (!a[need]) throw forbidden(need === 'manage' ? 'Only the project managers can do this' : 'You cannot change this project');
  return { project: p, pa: a };
}

export async function loadTask(ctx, id, need = 'see', { withDeleted = false } = {}) {
  const t = await first(ctx.env.DB,
    `SELECT t.*, EXISTS (SELECT 1 FROM task_followers f WHERE f.task_id = t.id AND f.user_id = ?) AS following
       FROM tasks t WHERE t.id = ? ${withDeleted ? '' : 'AND t.deleted_at IS NULL'}`, ctx.user.id, Number(id));
  if (!t) throw notFound('Task not found');
  let p = null;
  if (t.project_id) {
    p = await first(ctx.env.DB, `SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL`, t.project_id);
    if (!p) throw notFound('Task not found');
  }
  const a = ctx.access.task(t, p, { following: !!t.following });
  if (!a.see) throw notFound('Task not found');
  if (!a[need]) throw forbidden(need === 'edit' ? 'You cannot change this task' : 'You cannot do this on this task');
  return { task: t, project: p, ta: a };
}

// id → name for a set of user ids, for readable audit sentences.
export async function userNames(db, ids) {
  const clean = ids.filter(x => x != null);
  if (!clean.length) return {};
  const rows = await all(db, `SELECT id, name FROM users WHERE id IN (SELECT value FROM json_each(?))`, jsonIds(clean));
  return Object.fromEntries(rows.map(r => [r.id, r.name]));
}

export function taskUrl(id) { return `#/tasks/${id}`; }
export function projectUrl(id) { return `#/projects/${id}`; }
