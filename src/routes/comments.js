// Comments (with @mentions) and attachments. Both are polymorphic over
// object_type so Phase 2 objects (deliverables, risks, meetings) reuse them;
// today only 'task' and 'project' are wired.

import { ok, created, readJson, Validator, pageParams, listMeta, param, intParam, notFound, forbidden, badRequest, HttpError } from '../lib/http.js';
import { first, all, insert, update, run, paged, nowIso, stmt, expectedVersion } from '../lib/db.js';
import { loadProject, loadTask, taskUrl, projectUrl } from '../lib/load.js';
import { mentionedIds } from '../lib/tasks.js';
import { randomToken } from '../lib/auth.js';

// Resolves the object a comment/attachment hangs off, with access.
async function loadObject(ctx, type, id, need = 'see') {
  if (type === 'task') {
    const { task, project, ta } = await loadTask(ctx, id);
    if (need === 'comment' && !ta.comment) throw forbidden('You can read this task but not comment on it');
    if (need === 'edit' && !ta.edit) throw forbidden();
    return { project, label: task.title, url: taskUrl(task.id), taskId: task.id, followers: true };
  }
  if (type === 'project') {
    const { project, pa } = await loadProject(ctx, id);
    if (need === 'comment' && !pa.comment) throw forbidden();
    if (need === 'edit' && !pa.work) throw forbidden();
    return { project, label: project.name, url: projectUrl(project.id), taskId: null, followers: false };
  }
  throw badRequest('Unsupported object_type');
}

async function listComments(ctx) {
  const type = param(ctx.url, 'object_type'), id = intParam(ctx.url, 'object_id');
  if (!type || !id) throw badRequest('object_type and object_id are required');
  await loadObject(ctx, type, id);
  const pg = pageParams(ctx.url, { defaultLimit: 100, maxLimit: 500 });
  const { total, rows } = await paged(ctx.env.DB, {
    select: `c.id, c.object_type, c.object_id, c.author_id, c.body, c.created_at, c.updated_at, c.edited_at, u.name AS author_name, u.is_external AS author_external`,
    from: `comments c JOIN users u ON u.id = c.author_id`,
    where: ['c.object_type = ?', 'c.object_id = ?', 'c.deleted_at IS NULL'], params: [type, id],
    order: 'c.created_at ASC, c.id ASC', ...pg,
  });
  return ok(rows, listMeta(total, pg, rows.length));
}

async function createComment(ctx) {
  const v = new Validator(await readJson(ctx.req)).string('object_type', { required: true, max: 30 }).int('object_id', { required: true })
    .text('body', { required: true, min: 1, max: 20000 }).done();
  const o = await loadObject(ctx, v.object_type, v.object_id, 'comment');
  const db = ctx.env.DB;
  const cid = await insert(db, 'comments', { object_type: v.object_type, object_id: v.object_id, project_id: o.project?.id ?? null, author_id: ctx.user.id, body: v.body });
  const mentioned = mentionedIds(v.body);
  const stmts = mentioned.map(uid => stmt(db, `INSERT INTO mentions (comment_id, object_type, object_id, user_id, author_id) VALUES (?, ?, ?, ?, ?)`, cid, v.object_type, v.object_id, uid, ctx.user.id));
  let followers = [];
  if (o.taskId) {
    stmts.push(stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason) VALUES (?, ?, 'commented')`, o.taskId, ctx.user.id));
    // Mentioned people follow the task, but only if they can already see it.
    for (const uid of mentioned) stmts.push(stmt(db, `INSERT OR IGNORE INTO task_followers (task_id, user_id, reason)
      SELECT ?, ?, 'mentioned' WHERE ? IS NULL OR EXISTS (SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL)`,
      o.taskId, uid, o.project?.id ?? null, o.project?.id ?? null, uid));
    followers = (await all(db, `SELECT user_id FROM task_followers WHERE task_id = ?`, o.taskId)).map(r => r.user_id);
  }
  if (stmts.length) await db.batch(stmts);
  const excerpt = v.body.replace(/@\[([^\]]+)\]\(user:\d+\)/g, '@$1').slice(0, 240);
  ctx.audit({ action: 'create', type: 'comment', id: cid, label: o.label, entity_id: o.project?.entity_id, project_id: o.project?.id,
    summary: `${ctx.user.name} commented on "${o.label}"` });
  ctx.activity({ verb: 'comment.added', type: 'comment', id: cid, project_id: o.project?.id, task_id: o.taskId, payload: { excerpt, on: o.label } });
  if (mentioned.length) ctx.notify(mentioned, { kind: 'mentioned', object_type: v.object_type, object_id: v.object_id, project_id: o.project?.id, title: o.label, body: excerpt, url: o.url, dedupe_key: `mention:c${cid}` });
  const others = followers.filter(uid => !mentioned.includes(uid));
  if (others.length) ctx.notify(others, { kind: 'commented', object_type: v.object_type, object_id: v.object_id, project_id: o.project?.id, title: o.label, body: excerpt, url: o.url, dedupe_key: `comment:c${cid}` });
  ctx.touchProject(o.project?.id);
  return created(await first(db, `SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`, cid));
}

async function loadComment(ctx, id) {
  const c = await first(ctx.env.DB, `SELECT * FROM comments WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!c) throw notFound('Comment not found');
  const o = await loadObject(ctx, c.object_type, c.object_id);
  return { c, o };
}

async function patchComment(ctx, { id }) {
  const { c, o } = await loadComment(ctx, id);
  if (c.author_id !== ctx.user.id) throw forbidden('Only the author can edit a comment');
  const body = await readJson(ctx.req);
  const v = new Validator(body).text('body', { required: true, min: 1, max: 20000 }).done();
  await update(ctx.env.DB, 'comments', c.id, { body: v.body, edited_at: nowIso() }, { expected: expectedVersion(ctx.req, body) });
  const before = new Set(mentionedIds(c.body));
  const added = mentionedIds(v.body).filter(x => !before.has(x));
  if (added.length) {
    await ctx.env.DB.batch(added.map(uid => stmt(ctx.env.DB, `INSERT INTO mentions (comment_id, object_type, object_id, user_id, author_id) VALUES (?, ?, ?, ?, ?)`, c.id, c.object_type, c.object_id, uid, ctx.user.id)));
    ctx.notify(added, { kind: 'mentioned', object_type: c.object_type, object_id: c.object_id, project_id: c.project_id, title: o.label, body: v.body.slice(0, 240), url: o.url, dedupe_key: `mention:c${c.id}` });
  }
  ctx.audit({ action: 'update', type: 'comment', id: c.id, label: o.label, entity_id: o.project?.entity_id, project_id: c.project_id,
    summary: `${ctx.user.name} edited their comment on "${o.label}"`, changes: { body: [c.body, v.body] } });
  return ok(await first(ctx.env.DB, `SELECT c.*, u.name AS author_name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`, c.id));
}

async function deleteComment(ctx, { id }) {
  const { c, o } = await loadComment(ctx, id);
  const canModerate = o.project && ctx.access.project(o.project).manage;
  if (c.author_id !== ctx.user.id && !canModerate) throw forbidden('Only the author or a project manager can delete a comment');
  await run(ctx.env.DB, `UPDATE comments SET deleted_at = ? WHERE id = ?`, nowIso(), c.id);
  ctx.audit({ action: 'delete', type: 'comment', id: c.id, label: o.label, entity_id: o.project?.entity_id, project_id: c.project_id,
    summary: `${ctx.user.name} deleted a comment${c.author_id !== ctx.user.id ? ' by another member' : ''} on "${o.label}"` });
  return ok({ id: c.id, deleted: true });
}

// ---- attachments ---------------------------------------------------------

const MAX_BYTES = 25 * 1024 * 1024;

async function listAttachments(ctx) {
  const type = param(ctx.url, 'object_type'), id = intParam(ctx.url, 'object_id');
  const projectId = intParam(ctx.url, 'project_id');
  let rows;
  if (type && id) {
    await loadObject(ctx, type, id);
    rows = await all(ctx.env.DB, `SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.object_type = ? AND a.object_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC`, type, id);
  } else if (projectId) {
    const { pa } = await loadProject(ctx, projectId);
    rows = await all(ctx.env.DB, `SELECT a.*, u.name AS uploaded_by_name, t.title AS task_title FROM attachments a
      LEFT JOIN users u ON u.id = a.uploaded_by LEFT JOIN tasks t ON a.object_type = 'task' AND t.id = a.object_id
      WHERE a.project_id = ? AND a.deleted_at IS NULL ${pa.guest ? `AND (a.object_type <> 'task' OR t.is_internal = 0)` : ''}
        AND (t.id IS NULL OR t.deleted_at IS NULL) ORDER BY a.created_at DESC LIMIT 500`, projectId);
  } else throw badRequest('object_type and object_id, or project_id, are required');
  return ok(rows, { total: rows.length, limit: 500, offset: 0, next_offset: null });
}

async function upload(ctx) {
  const form = await ctx.req.formData().catch(() => { throw badRequest('Expected multipart/form-data'); });
  const type = form.get('object_type'), id = Number(form.get('object_id'));
  const file = form.get('file');
  if (!type || !Number.isInteger(id) || !file || typeof file === 'string') throw badRequest('object_type, object_id and file are required');
  if (file.size > MAX_BYTES) throw new HttpError(413, 'too_large', 'Files are limited to 25 MB');
  const o = await loadObject(ctx, type, id, 'edit');
  const key = `${o.project ? `p${o.project.id}` : `u${ctx.user.id}`}/${type}-${id}/${randomToken(9)}-${String(file.name).replace(/[^\w.\-]+/g, '_').slice(-100)}`;
  await ctx.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
  const aid = await insert(ctx.env.DB, 'attachments', {
    object_type: type, object_id: id, project_id: o.project?.id ?? null, r2_key: key, filename: String(file.name).slice(0, 250),
    mime: file.type || null, size_bytes: file.size, uploaded_by: ctx.user.id,
  });
  ctx.audit({ action: 'create', type: 'attachment', id: aid, label: file.name, entity_id: o.project?.entity_id, project_id: o.project?.id,
    summary: `${ctx.user.name} attached "${file.name}" to "${o.label}"` });
  ctx.activity({ verb: 'attachment.added', type: 'attachment', id: aid, project_id: o.project?.id, task_id: o.taskId, payload: { filename: file.name, on: o.label } });
  ctx.touchProject(o.project?.id);
  return created(await first(ctx.env.DB, `SELECT * FROM attachments WHERE id = ?`, aid));
}

async function download(ctx, { id }) {
  const a = await first(ctx.env.DB, `SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!a) throw notFound('File not found');
  await loadObject(ctx, a.object_type, a.object_id);
  const obj = await ctx.env.FILES.get(a.r2_key);
  if (!obj) throw notFound('File is missing from storage');
  const inline = param(ctx.url, 'inline') === '1' && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(a.mime || '');
  return new Response(obj.body, { headers: {
    'content-type': a.mime || 'application/octet-stream',
    'content-length': String(a.size_bytes),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=300',
  } });
}

async function deleteAttachment(ctx, { id }) {
  const a = await first(ctx.env.DB, `SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!a) throw notFound('File not found');
  const o = await loadObject(ctx, a.object_type, a.object_id);
  const mod = o.project && ctx.access.project(o.project).manage;
  if (a.uploaded_by !== ctx.user.id && !mod) throw forbidden('Only the uploader or a project manager can remove a file');
  // The bytes stay in R2 until the retention job, so this is undoable.
  await run(ctx.env.DB, `UPDATE attachments SET deleted_at = ? WHERE id = ?`, nowIso(), a.id);
  ctx.audit({ action: 'delete', type: 'attachment', id: a.id, label: a.filename, entity_id: o.project?.entity_id, project_id: a.project_id,
    summary: `${ctx.user.name} removed the file "${a.filename}" from "${o.label}"` });
  return ok({ id: a.id, deleted: true });
}

export default [
  ['GET', '/api/comments', listComments],
  ['POST', '/api/comments', createComment],
  ['PATCH', '/api/comments/:id', patchComment],
  ['DELETE', '/api/comments/:id', deleteComment],
  ['GET', '/api/attachments', listAttachments],
  ['POST', '/api/attachments', upload],
  ['GET', '/api/attachments/:id/download', download],
  ['DELETE', '/api/attachments/:id', deleteAttachment],
];
