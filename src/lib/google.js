// Google: OAuth 2.0 (sign-in, and connecting the organisation mailbox) and
// the Gmail API (sending sign-in links; reading mail in a later step).
//
// The OAuth client (client id + secret) is entered by a super admin in Team
// and Access and kept in `integrations`; env GOOGLE_CLIENT_ID/SECRET is a
// fallback. Endpoint URLs can be overridden by env so the smoke test can
// run the whole flow against a local fake Google.

import { first, run, nowIso } from './db.js';

export const AUTH_URL = (env) => env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = (env) => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = (env) => env.GMAIL_API_BASE || 'https://gmail.googleapis.com';

export const GMAIL_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

export async function oauthClient(env) {
  const row = await first(env.DB, `SELECT client_id, client_secret FROM integrations WHERE key = 'google_oauth'`);
  const id = row?.client_id || env.GOOGLE_CLIENT_ID || null;
  const secret = row?.client_secret || env.GOOGLE_CLIENT_SECRET || null;
  return id && secret ? { id, secret } : null;
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

// Exchanges an authorization code. The ID token comes straight from Google's
// token endpoint over TLS, which OpenID Connect allows to stand in for
// checking its signature; issuer, audience and expiry are still checked.
export async function exchangeCode(env, client, { code, verifier, redirectUri }) {
  const r = await fetch(TOKEN_URL(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token exchange failed: ${r.status} ${j.error || ''} ${j.error_description || ''}`.trim());
  const claims = j.id_token ? decodeJwt(j.id_token) : null;
  if (claims) {
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) && !env.GOOGLE_AUTH_URL) throw new Error(`unexpected issuer ${claims.iss}`);
    if (claims.aud !== client.id) throw new Error('id_token audience is not this client');
    if (claims.exp * 1000 < Date.now()) throw new Error('id_token expired');
  }
  return { tokens: j, claims };
}

export function decodeJwt(jwt) {
  const part = jwt.split('.')[1];
  const json = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, c => c.charCodeAt(0))));
}

// ---- Gmail -----------------------------------------------------------------

export async function gmailAccessToken(env) {
  const g = await first(env.DB, `SELECT * FROM integrations WHERE key = 'gmail' AND status = 'connected'`);
  if (!g) throw new Error('the organisation mailbox is not connected (Team and Access → Integrations)');
  if (g.access_token && g.expires_at && g.expires_at > new Date(Date.now() + 60000).toISOString()) return { token: g.access_token, account: g.account_email };
  const client = await oauthClient(env);
  if (!client) throw new Error('the Google OAuth client is not configured');
  const r = await fetch(TOKEN_URL(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: g.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = `refreshing the mailbox token failed: ${r.status} ${j.error || ''} ${j.error_description || ''}`.trim();
    await run(env.DB, `UPDATE integrations SET status = ?, last_error = ?, updated_at = ? WHERE key = 'gmail'`, j.error === 'invalid_grant' ? 'error' : 'connected', reason, nowIso());
    throw new Error(reason);
  }
  await run(env.DB, `UPDATE integrations SET access_token = ?, expires_at = ?, last_error = NULL, updated_at = ? WHERE key = 'gmail'`,
    j.access_token, new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString(), nowIso());
  return { token: j.access_token, account: g.account_email };
}

const encodeHeader = (s) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

export async function gmailSend(env, { to, subject, text, fromName }) {
  const { token, account } = await gmailAccessToken(env);
  const body = btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const mime = [
    `From: ${encodeHeader(fromName || 'KMOP HQ')} <${account}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body.replace(/.{76}/g, '$&\r\n'),
  ].join('\r\n');
  const raw = btoa(String.fromCharCode(...new TextEncoder().encode(mime))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch(`${GMAIL_BASE(env)}/gmail/v1/users/me/messages/send`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  if (!r.ok) throw new Error(`Gmail refused the message: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return (await r.json()).id;
}
