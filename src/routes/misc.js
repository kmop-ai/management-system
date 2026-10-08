// Saved views, search, health, and development helpers.

import { ok, created, readJson, Validator, param, notFound, badRequest } from '../lib/http.js';
import { first, all, insert, update, run, nowIso, expectedVersion, parseJson } from '../lib/db.js';
import { READ } from '../lib/rbac.js';
import { loadProject } from '../lib/load.js';
import { runCron } from '../cron.js';

// ---- saved views ---------------------------------------------------------

async function scopeAccess(ctx, scope) {
  const m = /^project:(\d+)$/.exec(scope);
  if (m) await loadProject(ctx, Number(m[1]));
  else if (!['my_tasks', 'all_tasks', 'workload', 'projects', 'calendar', 'inbox'].includes(scope)) throw badRequest('Unknown scope');
}

async function listViews(ctx) {
  const scope = param(ctx.url, 'scope');
  if (scope) await scopeAccess(ctx, scope);
  const rows = await all(ctx.env.DB, `SELECT v.*, u.name AS owner_name FROM saved_views v JOIN users u ON u.id = v.user_id
     WHERE v.deleted_at IS NULL AND (v.user_id = ? OR v.shared = 1) ${scope ? 'AND v.scope = ?' : ''} ORDER BY v.name`,
    ctx.user.id, ...(scope ? [scope] : []));
  // Shared views on projects you cannot see are not yours to list.
  const out = [];
  for (const r of rows) {
    if (r.user_id !== ctx.user.id && !scope) {
      const m = /^project:(\d+)$/.exec(r.scope);
      if (m && !ctx.access.membership.has(Number(m[1])) && ctx.access.level('projects') < READ) continue;
    }
    out.push({ ...r, config: parseJson(r.config, {}), mine: r.user_id === ctx.user.id });
  }
  return ok(out, { total: out.length, limit: out.length, offset: 0, next_offset: null });
}

const viewFields = (v) => v.string('name', { max: 80, nullable: false }).oneOf('view_type', ['list', 'board', 'timeline', 'calendar', 'workload']).bool('is_default').bool('shared');

async function createView(ctx) {
  const body = await readJson(ctx.req);
  const v = viewFields(new Validator(body).string('scope', { required: true, max: 40 })).done();
  if (!v.name) throw badRequest('name is required');
  await scopeAccess(ctx, v.scope);
  if (v.is_default) await run(ctx.env.DB, `UPDATE saved_views SET is_default = 0 WHERE user_id = ? AND scope = ?`, ctx.user.id, v.scope);
  const id = await insert(ctx.env.DB, 'saved_views', { ...v, user_id: ctx.user.id, config: JSON.stringify(body.config || {}) });
  const r = await first(ctx.env.DB, `SELECT * FROM saved_views WHERE id = ?`, id);
  return created({ ...r, config: parseJson(r.config, {}), mine: true });
}

async function patchView(ctx, { id }) {
  const r = await first(ctx.env.DB, `SELECT * FROM saved_views WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!r || r.user_id !== ctx.user.id) throw notFound('View not found');
  const body = await readJson(ctx.req);
  const v = viewFields(new Validator(body)).done();
  if (body.config !== undefined) v.config = JSON.stringify(body.config);
  if (v.is_default) await run(ctx.env.DB, `UPDATE saved_views SET is_default = 0 WHERE user_id = ? AND scope = ?`, ctx.user.id, r.scope);
  await update(ctx.env.DB, 'saved_views', r.id, v, { expected: expectedVersion(ctx.req, body) });
  const out = await first(ctx.env.DB, `SELECT * FROM saved_views WHERE id = ?`, r.id);
  return ok({ ...out, config: parseJson(out.config, {}), mine: true });
}

async function deleteView(ctx, { id }) {
  const r = await first(ctx.env.DB, `SELECT * FROM saved_views WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!r || r.user_id !== ctx.user.id) throw notFound('View not found');
  await run(ctx.env.DB, `UPDATE saved_views SET deleted_at = ? WHERE id = ?`, nowIso(), r.id);
  return ok({ id: r.id, deleted: true });
}

// ---- search --------------------------------------------------------------

// Turns free text into a safe FTS5 query: every word becomes a quoted
// prefix term, so punctuation in user input can never be FTS syntax.
export function ftsQuery(q) {
  const words = q.normalize('NFC').match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map(w => `"${w}"*`).join(' ');
}

async function search(ctx) {
  const q = (param(ctx.url, 'q') || '').trim();
  if (q.length < 2) return ok({ tasks: [], projects: [], comments: [], people: [] });
  const match = ftsQuery(q);
  if (!match) return ok({ tasks: [], projects: [], comments: [], people: [] });
  const db = ctx.env.DB;
  const tv = ctx.access.tasksVisibleSql('t', 'p');
  const pv = ctx.access.projectsVisibleSql('p');
  const ps = ctx.access.scope('people', READ);
  // \u0002 / \u0003 mark matches in snippets; the client escapes the text and
  // turns only these markers into <mark>, so stored text cannot inject HTML.
  const [tasks, projects, comments, people] = await db.batch([
    db.prepare(`SELECT t.id, t.title, t.status, t.due_date, t.completed_at, t.project_id, p.name AS project_name, p.code AS project_code,
                       snippet(search_fts, 4, char(2), char(3), '…', 12) AS snippet
                  FROM search_fts f JOIN tasks t ON t.id = f.object_id LEFT JOIN projects p ON p.id = t.project_id
                 WHERE search_fts MATCH ? AND f.object_type = 'task' AND t.deleted_at IS NULL AND ${tv.sql}
                 ORDER BY bm25(search_fts) LIMIT 30`).bind(match, ...tv.params),
    db.prepare(`SELECT p.id, p.name, p.code, p.status, p.entity_id FROM search_fts f JOIN projects p ON p.id = f.object_id
                 WHERE search_fts MATCH ? AND f.object_type = 'project' AND p.deleted_at IS NULL AND ${pv.sql}
                 ORDER BY bm25(search_fts) LIMIT 15`).bind(match, ...pv.params),
    db.prepare(`SELECT c.id, c.object_type, c.object_id, c.created_at, u.name AS author_name, t.title AS task_title, p.name AS project_name,
                       snippet(search_fts, 4, char(2), char(3), '…', 14) AS snippet
                  FROM search_fts f JOIN comments c ON c.id = f.object_id JOIN users u ON u.id = c.author_id
                  JOIN tasks t ON c.object_type = 'task' AND t.id = c.object_id LEFT JOIN projects p ON p.id = t.project_id
                 WHERE search_fts MATCH ? AND f.object_type = 'comment' AND c.deleted_at IS NULL AND t.deleted_at IS NULL AND ${tv.sql}
                 ORDER BY bm25(search_fts) LIMIT 20`).bind(match, ...tv.params),
    db.prepare(`SELECT id, name, email, title, entity_id FROM users
                 WHERE deleted_at IS NULL AND active = 1 AND (name LIKE ? OR email LIKE ?)
                   AND (id = ? OR entity_id IN (SELECT value FROM json_each(?)) OR department_id IN (SELECT value FROM json_each(?)))
                 ORDER BY name LIMIT 10`).bind(`%${q}%`, `%${q}%`, ctx.user.id, JSON.stringify(ps.entities), JSON.stringify(ps.departments)),
  ]);
  return ok({ tasks: tasks.results, projects: projects.results, comments: comments.results, people: ctx.user.is_external ? [] : people.results });
}

// ---- system --------------------------------------------------------------

async function health(ctx) {
  const r = await first(ctx.env.DB, `SELECT COUNT(*) AS n FROM schema_migrations`).catch(() => null);
  return ok({ ok: true, app: ctx.env.APP_NAME || 'KMOP HQ', migrations: r ? r.n : null, time: nowIso(), local_mode: ctx.env.LOCAL_MODE === '1' });
}

async function devOutbox(ctx) {
  return ok(await all(ctx.env.DB, `SELECT * FROM email_outbox ORDER BY id DESC LIMIT 50`));
}

async function devCron(ctx) {
  const body = ctx.req.headers.get('content-type')?.includes('json') ? await readJson(ctx.req) : {};
  return ok(await runCron(ctx.env, { force: true, now: body.now ? new Date(body.now) : new Date(), purge: !!body.purge }));
}

export default [
  ['GET', '/api/views', listViews],
  ['POST', '/api/views', createView],
  ['PATCH', '/api/views/:id', patchView],
  ['DELETE', '/api/views/:id', deleteView],
  ['GET', '/api/search', search],
  ['GET', '/api/health', health, { auth: false }],
  ['GET', '/api/dev/outbox', devOutbox, { dev: true }],
  ['POST', '/api/dev/cron', devCron, { dev: true }],
];
