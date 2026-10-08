// Team and Access (super admin only): who has which role, which modules,
// which projects a supervisor sees; the sign-in log; and the connections to
// Google (sign-in client, organisation mailbox).

import { ok, readJson, Validator, notFound, forbidden, badRequest, pageParams, listMeta } from '../lib/http.js';
import { first, all, run, stmt, nowIso, paged } from '../lib/db.js';
import { ROLES, MODULES, GRANTABLE, SUPERVISOR_MODULES } from '../lib/modules.js';
import { configSuperAdmins } from '../lib/rbac.js';
import { randomToken } from '../lib/auth.js';
import { oauthClient, pkcePair, exchangeCode, AUTH_URL, GMAIL_SCOPES } from '../lib/google.js';
import { queueEmail, sendOne } from '../lib/mail.js';
import { emailSignInLink } from './users.js';

function superOnly(ctx) {
  if (!ctx.access.isSuperAdmin) throw forbidden('Team and Access is for super admins');
}

async function teamList(ctx) {
  superOnly(ctx);
  const db = ctx.env.DB;
  const [people, grants, sup, ids] = await db.batch([
    db.prepare(`SELECT u.id, u.name, u.email, u.title, u.role, u.active, u.is_external, u.external_org, u.entity_id, u.last_login_at, u.updated_at, e.code AS entity_code
                  FROM users u LEFT JOIN entities e ON e.id = u.entity_id WHERE u.deleted_at IS NULL ORDER BY u.active DESC, u.name`),
    db.prepare(`SELECT user_id, module, access FROM module_grants`),
    db.prepare(`SELECT sp.user_id, sp.project_id, p.code, p.name FROM supervisor_projects sp JOIN projects p ON p.id = sp.project_id WHERE p.deleted_at IS NULL`),
    db.prepare(`SELECT user_id, group_concat(DISTINCT provider) AS providers FROM auth_identities GROUP BY user_id`),
  ]);
  const cfg = configSuperAdmins(ctx.env);
  const out = people.results.map(u => ({
    ...u,
    role: cfg.includes(u.email.toLowerCase()) ? 'super_admin' : u.role,
    role_from_config: cfg.includes(u.email.toLowerCase()),
    grants: Object.fromEntries(grants.results.filter(g => g.user_id === u.id).map(g => [g.module, g.access])),
    projects: sup.results.filter(s => s.user_id === u.id).map(s => ({ id: s.project_id, code: s.code, name: s.name })),
    sign_in_methods: (ids.results.find(i => i.user_id === u.id)?.providers || '').split(',').filter(Boolean),
  }));
  return ok(out, { modules: MODULES.map(m => ({ key: m.key, group: m.group, built: m.built, grantable: GRANTABLE.includes(m.key), supervisor: SUPERVISOR_MODULES.includes(m.key) })), roles: ROLES });
}

// Set a person's role, module grants and supervised projects in one go.
// body: { role, grants: { module: 'read'|'write'|null }, project_ids: [..] }
async function setAccess(ctx, { id }) {
  superOnly(ctx);
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, Number(id));
  if (!u) throw notFound('Person not found');
  const body = await readJson(ctx.req);
  const v = new Validator(body).oneOf('role', ROLES).done();
  const role = v.role || u.role;
  if (u.id === ctx.user.id && role !== 'super_admin') throw badRequest('You cannot remove your own super admin role. Ask another super admin.');
  if (configSuperAdmins(ctx.env).includes(u.email.toLowerCase()) && role !== 'super_admin') throw badRequest('This person is a super admin by configuration (SUPER_ADMINS); change it there.');
  const db = ctx.env.DB;
  const stmts = [stmt(db, `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, role, nowIso(), u.id)];
  const changes = [];
  if (role !== u.role) changes.push(`role ${u.role} → ${role}`);
  if (body.grants && typeof body.grants === 'object') {
    const before = Object.fromEntries((await all(db, `SELECT module, access FROM module_grants WHERE user_id = ?`, u.id)).map(g => [g.module, g.access]));
    for (const [m, raw] of Object.entries(body.grants)) {
      if (!GRANTABLE.includes(m)) throw badRequest(`Unknown or non-grantable module ${m}`);
      let a = raw === 'read' || raw === 'write' ? raw : null;
      // Supervisors read and comment only, and only where supervisors may look.
      if (role === 'supervisor' && a) a = SUPERVISOR_MODULES.includes(m) ? 'read' : null;
      if ((before[m] || null) === a) continue;
      changes.push(`${m}: ${before[m] || 'none'} → ${a || 'none'}`);
      stmts.push(a
        ? stmt(db, `INSERT INTO module_grants (user_id, module, access, granted_by) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, module) DO UPDATE SET access = excluded.access, granted_by = excluded.granted_by, created_at = excluded.created_at`, u.id, m, a, ctx.user.id)
        : stmt(db, `DELETE FROM module_grants WHERE user_id = ? AND module = ?`, u.id, m));
    }
  }
  if (role === 'supervisor') stmts.push(stmt(db, `UPDATE module_grants SET access = 'read' WHERE user_id = ? AND access = 'write'`, u.id));
  if (Array.isArray(body.project_ids)) {
    const ids = [...new Set(body.project_ids.map(Number).filter(Number.isInteger))];
    stmts.push(stmt(db, `DELETE FROM supervisor_projects WHERE user_id = ? AND project_id NOT IN (SELECT value FROM json_each(?))`, u.id, JSON.stringify(ids)));
    for (const pid of ids) stmts.push(stmt(db, `INSERT OR IGNORE INTO supervisor_projects (user_id, project_id, granted_by) SELECT ?, id, ? FROM projects WHERE id = ? AND deleted_at IS NULL`, u.id, ctx.user.id, pid));
    changes.push(`projects seen as supervisor: ${ids.length ? ids.map(i => '#' + i).join(', ') : 'none'}`);
  }
  await db.batch(stmts);
  if (changes.length) ctx.audit({ action: 'grant', type: 'user', id: u.id, label: u.name, entity_id: u.entity_id, summary: `${ctx.user.name} changed the access of ${u.name}: ${changes.join('; ')}` });
  return teamList(ctx);
}

async function sendInvite(ctx, { id }) {
  superOnly(ctx);
  const u = await first(ctx.env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND active = 1`, Number(id));
  if (!u) throw notFound('Person not found');
  const r = await emailSignInLink(ctx, u, 72);
  ctx.audit({ action: 'grant', type: 'user', id: u.id, label: u.name, summary: `${ctx.user.name} emailed ${u.name} a personal sign-in link (${r.sent ? 'sent' : 'NOT sent: ' + r.error})` });
  return ok(r);
}

async function authEvents(ctx) {
  superOnly(ctx);
  const pg = pageParams(ctx.url, { defaultLimit: 100 });
  const where = [], params = [];
  const outcome = ctx.url.searchParams.get('outcome');
  if (outcome === 'problems') where.push(`outcome NOT IN ('sent','signed_in')`);
  else if (outcome) { where.push('outcome = ?'); params.push(outcome); }
  const { total, rows } = await paged(ctx.env.DB, { select: 'e.*, u.name AS user_name', from: 'auth_events e LEFT JOIN users u ON u.id = e.user_id', where, params, order: 'e.id DESC', ...pg });
  return ok(rows, listMeta(total, pg, rows.length));
}

// ---- integrations ------------------------------------------------------------

async function integrations(ctx) {
  superOnly(ctx);
  const rows = await all(ctx.env.DB, `SELECT key, status, account_email, client_id, scopes, last_error, connected_at, updated_at,
    (client_secret IS NOT NULL) AS has_secret FROM integrations`);
  const by = Object.fromEntries(rows.map(r => [r.key, r]));
  const g = by.google_oauth || {};
  return ok({
    google_oauth: { configured: !!(g.client_id && g.has_secret) || !!(ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET), client_id: g.client_id || ctx.env.GOOGLE_CLIENT_ID || null, from_env: !g.client_id && !!ctx.env.GOOGLE_CLIENT_ID },
    gmail: by.gmail ? { status: by.gmail.status, account_email: by.gmail.account_email, last_error: by.gmail.last_error, connected_at: by.gmail.connected_at } : { status: 'not_connected' },
    redirect_uris: [`${ctx.origin}/api/auth/google/callback`, `${ctx.origin}/api/integrations/gmail/callback`],
    origin: ctx.origin,
    allowed_domains: (ctx.env.ALLOWED_EMAIL_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean),
    super_admins_in_config: configSuperAdmins(ctx.env),
  });
}

async function setGoogleClient(ctx) {
  superOnly(ctx);
  const v = new Validator(await readJson(ctx.req)).string('client_id', { required: true, max: 200 }).string('client_secret', { max: 200 }).done();
  if (!/\.apps\.googleusercontent\.com$/.test(v.client_id) && !ctx.env.GOOGLE_AUTH_URL) throw badRequest('That does not look like a Google OAuth client ID (…apps.googleusercontent.com)');
  await run(ctx.env.DB, `INSERT INTO integrations (key, status, client_id, client_secret, connected_by, connected_at, updated_at) VALUES ('google_oauth', 'connected', ?, ?, ?, ?, ?)
    ON CONFLICT (key) DO UPDATE SET client_id = excluded.client_id, client_secret = COALESCE(excluded.client_secret, integrations.client_secret), status = 'connected', updated_at = excluded.updated_at`,
    v.client_id, v.client_secret || null, ctx.user.id, nowIso(), nowIso());
  ctx.audit({ action: 'update', type: 'integration', label: 'Google OAuth client', summary: `${ctx.user.name} set the Google OAuth client (${v.client_id})${v.client_secret ? ' and its secret' : ''}` });
  return integrations(ctx);
}

const redirectTo = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } });

async function gmailStart(ctx) {
  superOnly(ctx);
  const client = await oauthClient(ctx.env);
  if (!client) return redirectTo(`${ctx.origin}/#/team/integrations?error=no_client`);
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  await ctx.env.KV.put(`oauth:${state}`, JSON.stringify({ verifier, purpose: 'gmail', user_id: ctx.user.id }), { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: client.id, redirect_uri: `${ctx.origin}/api/integrations/gmail/callback`, response_type: 'code',
    scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return redirectTo(`${AUTH_URL(ctx.env)}?${q}`);
}

async function gmailCallback(ctx) {
  superOnly(ctx);
  const { env, url } = ctx;
  const state = url.searchParams.get('state') || '';
  const saved = state && JSON.parse(await env.KV.get(`oauth:${state}`) || 'null');
  const back = (q) => redirectTo(`${ctx.origin}/#/team/integrations?${q}`);
  if (!saved || saved.purpose !== 'gmail' || saved.user_id !== ctx.user.id) return back('error=state');
  await env.KV.delete(`oauth:${state}`);
  if (url.searchParams.get('error')) return back(`error=${encodeURIComponent(url.searchParams.get('error'))}`);
  const client = await oauthClient(env);
  try {
    const { tokens, claims } = await exchangeCode(env, client, { code: url.searchParams.get('code') || '', verifier: saved.verifier, redirectUri: `${ctx.origin}/api/integrations/gmail/callback` });
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token; remove the app from the account\'s third-party access and connect again');
    await run(env.DB, `INSERT INTO integrations (key, status, account_email, refresh_token, access_token, expires_at, scopes, connected_by, connected_at, last_error, updated_at)
      VALUES ('gmail', 'connected', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT (key) DO UPDATE SET status = 'connected', account_email = excluded.account_email, refresh_token = excluded.refresh_token, access_token = excluded.access_token,
        expires_at = excluded.expires_at, scopes = excluded.scopes, connected_by = excluded.connected_by, connected_at = excluded.connected_at, last_error = NULL, updated_at = excluded.updated_at`,
      claims?.email || null, tokens.refresh_token, tokens.access_token, new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(), tokens.scope || null, ctx.user.id, nowIso(), nowIso());
    ctx.audit({ action: 'update', type: 'integration', label: 'Organisation mailbox', summary: `${ctx.user.name} connected the organisation mailbox ${claims?.email || ''}` });
    return back('connected=1');
  } catch (e) {
    console.error('gmail connect failed', e.message);
    await run(env.DB, `INSERT INTO integrations (key, status, last_error, updated_at) VALUES ('gmail', 'error', ?, ?) ON CONFLICT (key) DO UPDATE SET status = 'error', last_error = excluded.last_error, updated_at = excluded.updated_at`, e.message, nowIso());
    return back('error=exchange');
  }
}

async function gmailDisconnect(ctx) {
  superOnly(ctx);
  await run(ctx.env.DB, `UPDATE integrations SET status = 'not_connected', refresh_token = NULL, access_token = NULL, expires_at = NULL, updated_at = ? WHERE key = 'gmail'`, nowIso());
  ctx.audit({ action: 'revoke', type: 'integration', label: 'Organisation mailbox', summary: `${ctx.user.name} disconnected the organisation mailbox` });
  return integrations(ctx);
}

// Sends a test message and returns the real outcome to the super admin.
async function gmailTest(ctx) {
  superOnly(ctx);
  const id = await queueEmail(ctx.env, { to: ctx.user.email, user_id: ctx.user.id, kind: 'test', subject: 'KMOP HQ: test message', text: 'If you can read this, KMOP HQ can send sign-in links.' });
  const r = await sendOne(ctx.env, id);
  return ok(r);
}

export default [
  ['GET', '/api/team', teamList],
  ['PUT', '/api/team/:id/access', setAccess],
  ['POST', '/api/team/:id/invite', sendInvite],
  ['GET', '/api/team/auth-events', authEvents],
  ['GET', '/api/integrations', integrations],
  ['PUT', '/api/integrations/google', setGoogleClient],
  ['GET', '/api/integrations/gmail/start', gmailStart],
  ['GET', '/api/integrations/gmail/callback', gmailCallback],
  ['DELETE', '/api/integrations/gmail', gmailDisconnect],
  ['POST', '/api/integrations/gmail/test', gmailTest],
];
