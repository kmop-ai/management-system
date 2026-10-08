// Outgoing email. Everything is written to email_outbox first, then sent by
// sendPending() (right after the request via waitUntil, and hourly by cron
// to retry failures). Provider: Resend when RESEND_API_KEY is set. In
// DEV_MODE nothing leaves the machine; read /api/dev/outbox instead.

import { all, run, insert, nowIso } from './db.js';

export async function queueEmail(env, { to, user_id = null, kind, subject, text, html = null }) {
  return insert(env.DB, 'email_outbox', { to_email: to, user_id, kind, subject: subject.slice(0, 250), body_text: text, body_html: html });
}

export async function sendPending(env, limit = 50) {
  if (env.DEV_MODE === '1') return 0;
  if (!env.RESEND_API_KEY) {
    const pending = await all(env.DB, `SELECT COUNT(*) AS n FROM email_outbox WHERE sent_at IS NULL`);
    if (pending[0].n) console.warn(`email_outbox: ${pending[0].n} unsent — set RESEND_API_KEY to deliver mail`);
    return 0;
  }
  const rows = await all(env.DB, `SELECT * FROM email_outbox WHERE sent_at IS NULL AND attempts < 5 ORDER BY id LIMIT ?`, limit);
  let sent = 0;
  for (const m of rows) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [m.to_email], subject: m.subject, text: m.body_text, ...(m.body_html ? { html: m.body_html } : {}) }),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      await run(env.DB, `UPDATE email_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`, nowIso(), m.id);
      sent++;
    } catch (e) {
      await run(env.DB, `UPDATE email_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ?`, String(e.message || e).slice(0, 500), m.id);
    }
  }
  return sent;
}
