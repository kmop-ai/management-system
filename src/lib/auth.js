// Sign-in and sessions.
//
// Magic link today; SSO later. Everything provider-specific ends at
// createSession(): the rest of the system only ever asks loadSession() "who
// is this", so adding Microsoft or Google means a new route that verifies the
// provider's token, finds the user through auth_identities, and calls
// createSession(). No call site changes.
//
// Sessions live in KV keyed by the SHA-256 of the cookie value, so a KV dump
// yields no usable cookie. Each session records the user's token_version at
// mint time; bumping users.token_version revokes every session at once.

import { first, run, nowIso } from './db.js';
import { unauthorized } from './http.js';

export const COOKIE = 'kmop_session';

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

export function clearCookie(secure) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

export async function createSession(env, user, provider, days = 30) {
  const token = randomToken(32);
  const key = 's:' + await sha256hex(token);
  const ttl = Math.max(60, Math.round(days * 86400));
  await env.KV.put(key, JSON.stringify({ uid: user.id, tv: user.token_version, provider, at: nowIso() }), { expirationTtl: ttl });
  await run(env.DB, `UPDATE users SET last_login_at = ? WHERE id = ?`, nowIso(), user.id);
  return { token, ttl };
}

// Returns the user row, or null when there is no valid session.
export async function loadSession(env, req) {
  const token = readCookie(req, COOKIE) || bearer(req);
  if (!token) return null;
  const key = 's:' + await sha256hex(token);
  const raw = await env.KV.get(key);
  if (!raw) return null;
  let s;
  try { s = JSON.parse(raw); } catch { return null; }
  const user = await first(env.DB, `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, s.uid);
  if (!user || !user.active || user.token_version !== s.tv) {
    await env.KV.delete(key);
    return null;
  }
  user._sessionKey = key;
  user._provider = s.provider;
  return user;
}

function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function destroySession(env, user) {
  if (user && user._sessionKey) await env.KV.delete(user._sessionKey);
}

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function domainAllowed(env, email) {
  const domains = (env.ALLOWED_EMAIL_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const d = email.split('@')[1]?.toLowerCase();
  return !!d && domains.includes(d);
}
