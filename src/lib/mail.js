// Outgoing email. Everything is written to email_outbox first, then sent:
// immediately for sign-in links (so the real outcome can be logged), and by
// sendPending() after requests and hourly for the rest.
//
// Provider, in order: the organisation's Gmail mailbox when connected in
// Team and Access; Resend when RESEND_API_KEY is set. In DEV_MODE nothing
// leaves the machine; read /api/dev/outbox instead. When no provider exists
// the message stays queued with the reason in last_error — never silently.

import { all, first, run, insert, nowIso } from './db.js';
import { gmailSend } from './google.js';

export async function queueEmail(env, { to, user_id = null, kind, subject, text, html = null }) {
  return insert(env.DB, 'email_outbox', { to_email: to, user_id, kind, subject: subject.slice(0, 250), body_text: text, body_html: html });
}

async function deliver(env, m) {
  const gmail = await first(env.DB, `SELECT status FROM integrations WHERE key = 'gmail'`);
  if (gmail?.status === 'connected') return gmailSend(env, { to: m.to_email, subject: m.subject, text: m.body_text, fromName: env.APP_NAME });
  if (env.RESEND_API_KEY) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to_email], subject: m.subject, text: m.body_text, ...(m.body_html ? { html: m.body_html } : {}) }),
    });
    if (!r.ok) throw new Error(`Resend refused the message: ${r.status} ${await r.text()}`);
    return 'resend';
  }
  throw new Error('no mail provider: connect the organisation mailbox in Team and Access → Integrations');
}

// Sends one queued message now. Returns { ok, error } — the real reason, for logging.
export async function sendOne(env, id) {
  const m = await first(env.DB, `SELECT * FROM email_outbox WHERE id = ?`, id);
  if (!m || m.sent_at) return { ok: !!m };
  if (env.DEV_MODE === '1' && env.DEV_SEND_MAIL !== '1') return { ok: false, error: 'DEV_MODE: not sent (see /api/dev/outbox)' };
  try {
    await deliver(env, m);
    await run(env.DB, `UPDATE email_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`, nowIso(), m.id);
    return { ok: true };
  } catch (e) {
    const error = String(e.message || e).slice(0, 500);
    await run(env.DB, `UPDATE email_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`, error, m.id);
    console.error(`email ${m.id} to ${m.to_email} not sent: ${error}`);
    return { ok: false, error };
  }
}

export async function sendPending(env, limit = 50) {
  if (env.DEV_MODE === '1' && env.DEV_SEND_MAIL !== '1') return 0;
  const rows = await all(env.DB, `SELECT id FROM email_outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT ?`, limit);
  let sent = 0;
  for (const r of rows) if ((await sendOne(env, r.id)).ok) sent++;
  return sent;
}
