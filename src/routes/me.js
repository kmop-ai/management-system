// The signed-in person: bootstrap data for the SPA, own preferences.

import { ok, readJson, Validator } from '../lib/http.js';
import { all, update, stmt } from '../lib/db.js';
import { KIND_DEFAULTS, KINDS } from '../lib/notify.js';
import { diff, describeChanges } from '../lib/audit.js';
import { hashPassword, verifyPassword, passwordLoginEnabled, passwordProblem } from '../lib/password.js';
import { invalid, HttpError } from '../lib/http.js';

const PUBLIC_USER = 'id, email, name, title, entity_id, department_id, manager_id, is_external, external_org, locale, theme, timezone, weekly_hours, work_days, digest_frequency, digest_hour, last_login_at, updated_at';

export function publicUser(u) {
  const out = {};
  for (const k of PUBLIC_USER.split(', ')) out[k] = u[k];
  return out;
}

// One call gives the shell everything it needs to render: who you are, what
// you can do, and the small configuration tables every screen uses.
async function me(ctx) {
  const db = ctx.env.DB;
  const [entities, departments, statuses, roles, modules, unread] = await db.batch([
    db.prepare(`SELECT id, code, name, legal_name, country, city, currency, timezone, color FROM entities WHERE deleted_at IS NULL ORDER BY id`),
    db.prepare(`SELECT id, entity_id, parent_id, name, name_el, head_user_id FROM departments WHERE deleted_at IS NULL ORDER BY name`),
    db.prepare(`SELECT * FROM task_statuses ORDER BY position`),
    db.prepare(`SELECT key, label_en, label_el, rank, requires_expiry FROM roles ORDER BY rank DESC`),
    db.prepare(`SELECT key, label_en, label_el, sensitive FROM modules`),
    db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND archived_at IS NULL`).bind(ctx.user.id),
  ]);
  const cred = passwordLoginEnabled(ctx.env) ? await db.prepare(`SELECT must_change FROM password_credentials WHERE user_id = ?`).bind(ctx.user.id).first() : null;
  return ok({
    user: publicUser(ctx.user),
    access: ctx.access.summary(),
    entities: entities.results,
    departments: departments.results,
    statuses: statuses.results,
    roles: roles.results,
    modules: modules.results,
    unread: unread.results[0].n,
    dev_mode: ctx.env.DEV_MODE === '1',
    password_login: passwordLoginEnabled(ctx.env),
    // The address colleagues use (a local install knows its network name).
    app_url: ctx.env.LOCAL_MODE === '1' && ctx.env.APP_URL ? ctx.env.APP_URL : null,
    has_password: !!cred,
    must_change_password: !!(cred && cred.must_change),
  });
}

async function patchMe(ctx) {
  const body = await readJson(ctx.req);
  const v = new Validator(body)
    .string('name', { min: 2, max: 120, nullable: false })
    .string('title', { max: 120 })
    .oneOf('locale', ['en', 'el'])
    .oneOf('theme', ['system', 'light', 'dark'])
    .string('timezone', { max: 60 })
    .oneOf('digest_frequency', ['daily', 'weekly', 'off'])
    .int('digest_hour', { min: 0, max: 23, nullable: false })
    .done();
  const changes = diff(ctx.user, v);
  if (Object.keys(changes).length) {
    const ts = await update(ctx.env.DB, 'users', ctx.user.id, v);
    Object.assign(ctx.user, v, { updated_at: ts });
    ctx.audit({ action: 'update', type: 'user', id: ctx.user.id, label: ctx.user.name, entity_id: ctx.user.entity_id,
      summary: `${ctx.user.name} updated their own preferences: ${describeChanges(changes)}`, changes });
  }
  return ok(publicUser(ctx.user));
}

async function getPrefs(ctx) {
  const rows = await all(ctx.env.DB, `SELECT kind, in_app, email FROM notification_prefs WHERE user_id = ?`, ctx.user.id);
  const by = Object.fromEntries(rows.map(r => [r.kind, r]));
  return ok(KINDS.map(k => ({ kind: k, in_app: by[k] ? by[k].in_app : 1, email: by[k] ? by[k].email : KIND_DEFAULTS[k], default_email: KIND_DEFAULTS[k] })));
}

async function putPrefs(ctx) {
  const body = await readJson(ctx.req);
  const items = Array.isArray(body.prefs) ? body.prefs : [];
  const stmts = [];
  for (const p of items) {
    if (!KINDS.includes(p.kind)) continue;
    const email = ['immediate', 'digest', 'off'].includes(p.email) ? p.email : KIND_DEFAULTS[p.kind];
    stmts.push(stmt(ctx.env.DB, `INSERT INTO notification_prefs (user_id, kind, in_app, email) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, kind) DO UPDATE SET in_app = excluded.in_app, email = excluded.email`,
      ctx.user.id, p.kind, p.in_app === 0 || p.in_app === false ? 0 : 1, email));
  }
  if (stmts.length) await ctx.env.DB.batch(stmts);
  return getPrefs(ctx);
}

// Set or change my own password. The current password is required unless
// the one I have was handed out by an administrator (must_change).
async function setPassword(ctx) {
  if (!passwordLoginEnabled(ctx.env)) throw new HttpError(404, 'not_found', 'Password sign-in is not enabled here');
  const body = await readJson(ctx.req);
  const cred = await ctx.env.DB.prepare(`SELECT * FROM password_credentials WHERE user_id = ?`).bind(ctx.user.id).first();
  if (cred && !cred.must_change) {
    if (typeof body.current !== 'string' || !(await verifyPassword(body.current, cred))) throw invalid({ current: 'is not your current password' });
  }
  const problem = passwordProblem(body.password);
  if (problem) throw invalid({ password: problem });
  const h = await hashPassword(body.password);
  await ctx.env.DB.prepare(`INSERT INTO password_credentials (user_id, hash, salt, iterations, must_change, set_by, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, salt = excluded.salt, iterations = excluded.iterations, must_change = 0, set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .bind(ctx.user.id, h.hash, h.salt, h.iterations, ctx.user.id, new Date().toISOString()).run();
  ctx.audit({ action: 'update', type: 'user', id: ctx.user.id, label: ctx.user.name, entity_id: ctx.user.entity_id, summary: `${ctx.user.name} changed their password` });
  return ok({ changed: true });
}

export default [
  ['GET', '/api/me', me],
  ['PATCH', '/api/me', patchMe],
  ['GET', '/api/me/notification-prefs', getPrefs],
  ['PUT', '/api/me/notification-prefs', putPrefs],
  ['POST', '/api/me/password', setPassword],
];
