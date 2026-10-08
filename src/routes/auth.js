// Sign-in: request a magic link, redeem it, sign out.

import { ok, readJson, Validator, HttpError } from '../lib/http.js';
import { first, run, insert, nowIso } from '../lib/db.js';
import { sha256hex, randomToken, createSession, sessionCookie, clearCookie, destroySession, domainAllowed } from '../lib/auth.js';
import { queueEmail, sendPending } from '../lib/mail.js';
import { auditStmt } from '../lib/audit.js';
import { t } from '../lib/strings.js';

const GENERIC = 'If that address can sign in, a link is on its way. It expires in a few minutes.';

async function requestLink(ctx) {
  const body = await readJson(ctx.req);
  const { email, redirect } = new Validator(body).email('email', { required: true }).string('redirect', { max: 300 }).done();
  const { env } = ctx;

  // Five requests per address per 15 minutes; more is someone else typing it.
  const rlKey = `rl:link:${email}`;
  const count = Number(await env.KV.get(rlKey) || 0);
  // Generous in DEV_MODE, where test scripts sign in constantly.
  if (count >= (env.DEV_MODE === '1' ? 500 : 5)) throw new HttpError(429, 'rate_limited', 'Too many sign-in requests. Try again in 15 minutes.');
  await env.KV.put(rlKey, String(count + 1), { expirationTtl: 900 });

  let user = await first(env.DB, `SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`, email);
  if (!user && env.AUTO_PROVISION === '1' && domainAllowed(env, email)) {
    const name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const id = await insert(env.DB, 'users', { email, name });
    await insert(env.DB, 'user_roles', { user_id: id, role: 'team_member' });
    user = await first(env.DB, `SELECT * FROM users WHERE id = ?`, id);
    ctx.pending.push(auditStmt(ctx, { actor_id: null, action: 'create', type: 'user', id, label: name, summary: `${name} (${email}) was created on first sign-in from an allowed domain` }));
  }
  // Same answer whether or not the address exists: no account enumeration.
  if (!user || !user.active) return ok({ message: GENERIC });

  const minutes = Number((await first(env.DB, `SELECT value FROM settings WHERE key = 'magic_link_minutes'`))?.value || 20);
  const token = randomToken(32);
  await insert(env.DB, 'magic_links', {
    token_hash: await sha256hex(token), user_id: user.id,
    expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
    ip: ctx.ip, redirect: redirect && redirect.startsWith('#/') ? redirect : null,
  });
  const link = `${ctx.url.origin}/#/auth/verify?token=${encodeURIComponent(token)}`;
  const L = user.locale || 'en';
  await queueEmail(env, {
    to: user.email, user_id: user.id, kind: 'magic_link',
    subject: t(L, 'email.link_subject'),
    text: t(L, 'email.link_body', { name: user.name, link, minutes }),
  });
  ctx.ectx.waitUntil(sendPending(env, 5));
  return ok({ message: GENERIC, ...(env.DEV_MODE === '1' ? { dev_link: link, dev_token: token } : {}) });
}

async function verify(ctx) {
  const body = await readJson(ctx.req);
  const { token } = new Validator(body).string('token', { required: true, max: 200 }).done();
  const { env } = ctx;
  const hash = await sha256hex(token);
  const link = await first(env.DB, `SELECT * FROM magic_links WHERE token_hash = ?`, hash);
  if (!link || link.used_at || link.expires_at < nowIso()) {
    throw new HttpError(400, 'link_invalid', 'This sign-in link has expired or was already used. Ask for a new one.');
  }
  // Mark used first and check we were the one who did it: two tabs racing
  // on the same link must not both get a session.
  const r = await run(env.DB, `UPDATE magic_links SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`, nowIso(), hash);
  if (!r.meta.changes) throw new HttpError(400, 'link_invalid', 'This sign-in link was already used.');
  const user = await first(env.DB, `SELECT * FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL`, link.user_id);
  if (!user) throw new HttpError(400, 'link_invalid', 'This account is not active.');

  await env.DB.prepare(`INSERT INTO auth_identities (user_id, provider, subject, last_used_at) VALUES (?, 'email', ?, ?)
                        ON CONFLICT (provider, subject) DO UPDATE SET last_used_at = excluded.last_used_at`)
    .bind(user.id, user.email.toLowerCase(), nowIso()).run();
  const days = Number((await first(env.DB, `SELECT value FROM settings WHERE key = 'session_days'`))?.value || 30);
  const { token: sess, ttl } = await createSession(env, user, 'email', days);
  ctx.user = user;
  ctx.pending.push(auditStmt(ctx, { action: 'login', type: 'user', id: user.id, label: user.name, summary: `${user.name} signed in with an email link` }));
  return ok({ user: { id: user.id, name: user.name, email: user.email }, redirect: link.redirect },
    null, { 'set-cookie': sessionCookie(sess, ttl, ctx.url.protocol === 'https:') });
}

async function logout(ctx) {
  await destroySession(ctx.env, ctx.user);
  return ok({ signed_out: true }, null, { 'set-cookie': clearCookie(ctx.url.protocol === 'https:') });
}

// Revokes every session this person has, on every device.
async function logoutEverywhere(ctx) {
  await run(ctx.env.DB, `UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?`, nowIso(), ctx.user.id);
  ctx.audit({ action: 'revoke', type: 'user', id: ctx.user.id, label: ctx.user.name, summary: `${ctx.user.name} signed out of every device` });
  return ok({ signed_out: true }, null, { 'set-cookie': clearCookie(ctx.url.protocol === 'https:') });
}

export default [
  ['POST', '/api/auth/request-link', requestLink, { auth: false }],
  ['POST', '/api/auth/verify', verify, { auth: false }],
  ['POST', '/api/auth/logout', logout],
  ['POST', '/api/auth/logout-everywhere', logoutEverywhere],
];
