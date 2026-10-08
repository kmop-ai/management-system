// The signed-in person: bootstrap data for the SPA, own preferences.

import { ok, readJson, Validator } from '../lib/http.js';
import { all, update, stmt } from '../lib/db.js';
import { KIND_DEFAULTS, KINDS } from '../lib/notify.js';
import { diff, describeChanges } from '../lib/audit.js';
import { MODULES } from '../lib/modules.js';

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
    // The address colleagues use (a local install knows its network name).
    app_url: ctx.env.LOCAL_MODE === '1' && ctx.env.APP_URL ? ctx.env.APP_URL : null,
    nav: navFor(ctx),
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

// The sidebar, built from module access: pages the person cannot open are
// not listed at all. Ordered by the person's saved order; pages added to
// their access later are appended in the default order.
export function navFor(ctx) {
  const pages = MODULES.filter(m => m.built && ctx.access.grant(m.key)).map(m => ({ key: m.key, group: m.group, route: m.route, access: ctx.access.grant(m.key) }));
  let order = [];
  try { order = JSON.parse(ctx.user.sidebar_order || '[]'); } catch {}
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 1000 + MODULES.findIndex(m => m.key === k) : i; };
  return pages.sort((a, b) => rank(a.key) - rank(b.key));
}

// Save my own sidebar order (an array of page keys).
async function putSidebar(ctx) {
  const body = await readJson(ctx.req);
  const keys = Array.isArray(body.order) ? body.order.filter(k => MODULES.some(m => m.key === k)) : [];
  await update(ctx.env.DB, 'users', ctx.user.id, { sidebar_order: JSON.stringify([...new Set(keys)]) });
  ctx.user.sidebar_order = JSON.stringify(keys);
  return ok(navFor(ctx));
}

export default [
  ['GET', '/api/me', me],
  ['PATCH', '/api/me', patchMe],
  ['GET', '/api/me/notification-prefs', getPrefs],
  ['PUT', '/api/me/notification-prefs', putPrefs],
  ['PUT', '/api/me/sidebar', putSidebar],
];
