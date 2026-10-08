// Sign-in. Two independent routes, so one failing never locks everyone out:
//   1. a personal sign-in link by email (only its SHA-256 is stored);
//   2. Google Workspace sign-in (OAuth 2.0 + PKCE).
// No passwords. Allowed by email domain (ALLOWED_EMAIL_DOMAINS); super
// admins are named in configuration (SUPER_ADMINS). The browser always gets
// the same answer; the real reason for anything that went wrong is written
// to auth_events and the server log.

import { ok, readJson, Validator, HttpError } from '../lib/http.js';
import { first, run, insert, nowIso, stmt } from '../lib/db.js';
import { sha256hex, randomToken, createSession, sessionCookie, clearCookie, destroySession, domainAllowed } from '../lib/auth.js';
import { queueEmail, sendOne } from '../lib/mail.js';
import { auditStmt } from '../lib/audit.js';
import { t } from '../lib/strings.js';
import { configSuperAdmins } from '../lib/rbac.js';
import { DEFAULT_MEMBER_GRANTS } from '../lib/modules.js';
import { oauthClient, pkcePair, exchangeCode, AUTH_URL } from '../lib/google.js';

const GENERIC = 'If that address can sign in, a link is on its way. It expires in a few minutes.';

export async function logAuth(env, { email = null, user_id = null, method, outcome, detail = null, ip = null }) {
  if (outcome !== 'signed_in' && outcome !== 'sent') console.warn(`sign-in ${method} ${outcome} ${email || ''}: ${detail || ''}`);
  await run(env.DB, `INSERT INTO auth_events (email, user_id, method, outcome, detail, ip) VALUES (?, ?, ?, ?, ?, ?)`,
    email, user_id, method, outcome, detail ? String(detail).slice(0, 500) : null, ip);
}

// Finds the person, or creates them when their domain is allowed (or they
// are a configured super admin). Returns { user } or { reason }.
async function findOrProvision(ctx, email, nameHint) {
  const { env } = ctx;
  let user = await first(env.DB, `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, email);
  if (user && !user.active) return { reason: 'inactive' };
  if (user) return { user };
  const isConfigAdmin = configSuperAdmins(env).includes(email);
  if (!isConfigAdmin && !domainAllowed(env, email)) return { reason: 'domain_not_allowed' };
  if (!isConfigAdmin && env.AUTO_PROVISION === '0') return { reason: 'unknown_email' };
  const name = nameHint || email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const id = await insert(env.DB, 'users', { email, name, role: isConfigAdmin ? 'super_admin' : 'member' });
  if (!isConfigAdmin) await env.DB.batch(Object.entries(DEFAULT_MEMBER_GRANTS).map(([m, a]) => stmt(env.DB, `INSERT INTO module_grants (user_id, module, access) VALUES (?, ?, ?)`, id, m, a)));
  user = await first(env.DB, `SELECT * FROM users WHERE id = ?`, id);
  ctx.pending.push(auditStmt(ctx, { actor_id: null, action: 'create', type: 'user', id, label: name,
    summary: `${name} (${email}) was created on first sign-in ${isConfigAdmin ? 'as a configured super admin' : 'from an allowed domain, as a member'}` }));
  return { user };
}

async function startSession(ctx, user, provider, label) {
  const days = Number((await first(ctx.env.DB, `SELECT value FROM settings WHERE key = 'session_days'`))?.value || 30);
  const s = await createSession(ctx.env, user, provider, days);
  ctx.user = user;
  ctx.pending.push(auditStmt(ctx, { action: 'login', type: 'user', id: user.id, label: user.name, summary: `${user.name} signed in ${label}` }));
  await logAuth(ctx.env, { email: user.email, user_id: user.id, method: provider === 'google' ? 'google' : 'link', outcome: 'signed_in', ip: ctx.ip });
  return sessionCookie(s.token, s.ttl, ctx.secure);
}

// ---- 1. personal sign-in link ---------------------------------------------

async function requestLink(ctx) {
  const body = await readJson(ctx.req);
  const { email, redirect } = new Validator(body).email('email', { required: true }).string('redirect', { max: 300 }).done();
  const { env } = ctx;
  const log = (outcome, detail, user_id = null) => logAuth(env, { email, user_id, method: 'link', outcome, detail, ip: ctx.ip });

  // Five requests per address per 15 minutes; more is someone else typing it.
  const rlKey = `rl:link:${email}`;
  const count = Number(await env.KV.get(rlKey) || 0);
  if (count >= (env.DEV_MODE === '1' ? 500 : 5)) { await log('rate_limited', `${count} requests in 15 minutes`); return ok({ message: GENERIC }); }
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 900 });

  const { user, reason } = await findOrProvision(ctx, email);
  // Same answer whatever happened: no account enumeration. The reason is logged.
  if (!user) { await log(reason, reason === 'domain_not_allowed' ? `domain ${email.split('@')[1]} is not in ALLOWED_EMAIL_DOMAINS` : null); return ok({ message: GENERIC }); }

  const minutes = Number((await first(env.DB, `SELECT value FROM settings WHERE key = 'magic_link_minutes'`))?.value || 20);
  const token = randomToken(32);
  await insert(env.DB, 'magic_links', {
    token_hash: await sha256hex(token), user_id: user.id,
    expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    ip: ctx.ip, redirect: redirect && redirect.startsWith('#/') ? redirect : null,
  });
  const link = `${ctx.origin}/#/auth/verify?token=${encodeURIComponent(token)}`;
  const L = user.locale || 'en';
  const outboxId = await queueEmail(env, { to: user.email, user_id: user.id, kind: 'magic_link',
    subject: t(L, 'email.link_subject'), text: t(L, 'email.link_body', { name: user.name, link, minutes }) });
  // Send after responding, so timing reveals nothing; log the real outcome.
  ctx.ectx.waitUntil(sendOne(env, outboxId).then(r => log(r.ok ? 'sent' : 'send_failed', r.error || null, user.id)).catch(e => console.error('link send', e)));
  return ok({ message: GENERIC, ...(env.DEV_MODE === '1' ? { dev_link: link, dev_token: token } : {}) });
}

async function verify(ctx) {
  const body = await readJson(ctx.req);
  const { token } = new Validator(body).string('token', { required: true, max: 200 }).done();
  const { env } = ctx;
  const hash = await sha256hex(token);
  const link = await first(env.DB, `SELECT * FROM magic_links WHERE token_hash = ?`, hash);
  if (!link || link.used_at || link.expires_at < nowIso()) {
    await logAuth(env, { user_id: link?.user_id ?? null, method: 'link', outcome: 'denied', detail: !link ? 'unknown token' : link.used_at ? 'link already used' : 'link expired', ip: ctx.ip });
    throw new HttpError(400, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a new one.');
  }
  // Mark used first and check we were the one who did it: two tabs racing
  // on the same link must not both get a session.
  const r = await run(env.DB, `UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`, nowIso(), hash);
  if (!r.meta.changes) throw new HttpError(400, 'link_invalid', 'This sign-in link was already used.');
  const user = await first(env.DB, `SELECT * FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL`, link.user_id);
  if (!user) { await logAuth(env, { user_id: link.user_id, method: 'link', outcome: 'inactive', ip: ctx.ip }); throw new HttpError(400, 'link_invalid', 'This account is not active.'); }
  await env.DB.prepare(`INSERT INTO auth_identities (user_id, provider, subject, last_used_at) VALUES (?, 'email', ?, ?)
                        ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = excluded.last_used_at`).bind(user.id, user.email.toLowerCase(), nowIso()).run();
  const cookie = await startSession(ctx, user, 'email', 'with a personal link');
  return ok({ user: { id: user.id, name: user.name, email: user.email }, redirect: link.redirect }, null, { 'set-cookie': cookie });
}

// ---- 2. Google Workspace ----------------------------------------------------

const redirectTo = (location, cookie) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });

async function googleStart(ctx) {
  const { env, url } = ctx;
  const client = await oauthClient(env);
  if (!client) { await logAuth(env, { method: 'google', outcome: 'denied', detail: 'Google sign-in is not configured (Team and Access → Integrations)', ip: ctx.ip }); return redirectTo(`${ctx.origin}/#/login?error=google_unavailable`); }
  const state = randomToken(24);
  const { verifier, challenge } = await pkcePair();
  const next = url.searchParams.get('next');
  await env.KV.put(`oauth:${state}`, JSON.stringify({ verifier, purpose: 'signin', next: next && next.startsWith('#/') ? next : null }), { expirationTtl: 600 });
  const domains = (env.ALLOWED_EMAIL_DOMAINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const q = new URLSearchParams({
    client_id: client.id, redirect_uri: `${ctx.origin}/api/auth/google/callback`, response_type: 'code',
    scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
    ...(domains.length === 1 ? { hd: domains[0] } : {}),
  });
  return redirectTo(`${AUTH_URL(env)}?${q}`);
}

async function googleCallback(ctx) {
  const { env, url } = ctx;
  const fail = async (detail, email = null) => {
    await logAuth(env, { email, method: 'google', outcome: 'denied', detail, ip: ctx.ip });
    return redirectTo(`${ctx.origin}/#/login?error=google_denied`);
  };
  const state = url.searchParams.get('state') || '';
  const saved = state && JSON.parse(await env.KV.get(`oauth:${state}`) || 'null');
  if (!saved || saved.purpose !== 'signin') return fail('state missing or expired');
  await env.KV.delete(`oauth:${state}`);
  if (url.searchParams.get('error')) return fail(`Google returned ${url.searchParams.get('error')}`);
  const client = await oauthClient(env);
  if (!client) return fail('Google sign-in is not configured');
  let claims;
  try { ({ claims } = await exchangeCode(env, client, { code: url.searchParams.get('code') || '', verifier: saved.verifier, redirectUri: `${ctx.origin}/api/auth/google/callback` })); }
  catch (e) { return fail(e.message); }
  if (!claims?.email) return fail('no email in the Google token');
  const email = String(claims.email).toLowerCase();
  if (claims.email_verified === false || claims.email_verified === 'false') return fail('Google says the email is not verified', email);
  const { user, reason } = await findOrProvision(ctx, email, claims.name);
  if (!user) return fail(reason === 'domain_not_allowed' ? `domain ${email.split('@')[1]} is not allowed` : reason, email);
  await env.DB.prepare(`INSERT INTO auth_identities (user_id, provider, subject, last_used_at) VALUES (?, 'google', ?, ?)
                        ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = excluded.last_used_at`).bind(user.id, String(claims.sub), nowIso()).run();
  const cookie = await startSession(ctx, user, 'google', 'with Google');
  return redirectTo(`${ctx.origin}/${saved.next || '#/'}`, cookie);
}

// ---- sign out ----------------------------------------------------------------

async function logout(ctx) {
  await destroySession(ctx.env, ctx.user);
  return ok({ signed_out: true }, null, { 'set-cookie': clearCookie(ctx.secure) });
}

// Revokes every session this person has, on every device.
async function logoutEverywhere(ctx) {
  await run(ctx.env.DB, `UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?`, nowIso(), ctx.user.id);
  ctx.audit({ action: 'revoke', type: 'user', id: ctx.user.id, label: ctx.user.name, summary: `${ctx.user.name} signed out of every device` });
  return ok({ signed_out: true }, null, { 'set-cookie': clearCookie(ctx.secure) });
}

// Which sign-in routes are available, for the sign-in page.
async function methods(ctx) {
  return ok({ link: true, google: !!(await oauthClient(ctx.env)), local_mode: ctx.env.LOCAL_MODE === '1' });
}

export default [
  ['GET', '/api/auth/methods', methods, { auth: false }],
  ['POST', '/api/auth/request-link', requestLink, { auth: false }],
  ['POST', '/api/auth/verify', verify, { auth: false }],
  ['GET', '/api/auth/google/start', googleStart, { auth: false }],
  ['GET', '/api/auth/google/callback', googleCallback, { auth: false }],
  ['POST', '/api/auth/logout', logout],
  ['POST', '/api/auth/logout-everywhere', logoutEverywhere],
];
