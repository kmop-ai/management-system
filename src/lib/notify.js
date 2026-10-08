// Notifications: one inbox for everything addressed to a person.
//
// notify() queues INSERTs on the request context (flushed with the audit
// batch). Preferences are applied in SQL at insert time, so there is no
// per-recipient lookup: a row in notification_prefs with in_app = 0 simply
// makes the INSERT … SELECT produce nothing.

import { stmt, all, run, nowIso } from './db.js';
import { queueEmail } from './mail.js';
import { t } from './strings.js';

// Default email behaviour when a person has not chosen: things that need a
// reply soon arrive immediately, everything else waits for the digest.
export const KIND_DEFAULTS = {
  mentioned: 'immediate',
  assigned: 'digest',
  commented: 'digest',
  due_soon: 'digest',
  overdue: 'digest',
  completed: 'digest',
  added_to_project: 'digest',
  nudge: 'immediate',
};
export const KINDS = Object.keys(KIND_DEFAULTS);

export function notifyStmts(ctx, userIds, n) {
  const actor = n.actor_id !== undefined ? n.actor_id : (ctx.user ? ctx.user.id : null);
  const out = [];
  for (const uid of new Set(userIds.filter(Boolean))) {
    if (uid === actor && !n.include_actor) continue; // nobody needs to be told what they just did
    out.push(stmt(ctx.env.DB,
      `INSERT OR IGNORE INTO notifications (user_id, kind, actor_id, object_type, object_id, project_id, title, body, url, dedupe_key)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM notification_prefs WHERE user_id = ? AND kind = ? AND in_app = 0)
          AND EXISTS (SELECT 1 FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL)`,
      uid, n.kind, actor, n.object_type ?? null, n.object_id ?? null, n.project_id ?? null,
      String(n.title).slice(0, 300), n.body ? String(n.body).slice(0, 500) : null, n.url ?? null, n.dedupe_key ?? null,
      uid, n.kind, uid));
  }
  if (out.length) ctx.hasNewNotifications = true;
  return out;
}

// Immediate emails for notifications created in the last few minutes whose
// recipients asked for them (or whose kind defaults to immediate).
export async function emailImmediate(env, appUrl) {
  const immediateKinds = Object.entries(KIND_DEFAULTS).filter(([, v]) => v === 'immediate').map(([k]) => k);
  const rows = await all(env.DB,
    `SELECT n.*, u.email, u.name AS user_name, u.locale, a.name AS actor_name
       FROM notifications n
       JOIN users u ON u.id = n.user_id
       LEFT JOIN users a ON a.id = n.actor_id
       LEFT JOIN notification_prefs np ON np.user_id = n.user_id AND np.kind = n.kind
      WHERE n.emailed_at IS NULL AND n.read_at IS NULL AND n.archived_at IS NULL
        AND n.created_at >= ? AND u.active = 1 AND u.deleted_at IS NULL
        AND COALESCE(np.email, CASE WHEN n.kind IN (SELECT value FROM json_each(?)) THEN 'immediate' ELSE 'digest' END) = 'immediate'
      LIMIT 100`,
    new Date(Date.now() - 15 * 60000).toISOString(), JSON.stringify(immediateKinds));
  if (!rows.length) return 0;
  for (const n of rows) {
    const L = n.locale || 'en';
    const line = notificationLine(n, L);
    await queueEmail(env, {
      to: n.email, user_id: n.user_id, kind: 'notification',
      subject: `${line}`,
      text: `${line}\n\n${n.body || ''}\n\n${t(L, 'email.open')}: ${appUrl}/${n.url || ''}\n\n${t(L, 'email.prefs_footer')}`,
    });
  }
  await run(env.DB, `UPDATE notifications SET emailed_at = ? WHERE id IN (SELECT value FROM json_each(?))`,
    nowIso(), JSON.stringify(rows.map(r => r.id)));
  return rows.length;
}

export function notificationLine(n, L) {
  const who = n.actor_name || t(L, 'common.someone');
  return t(L, `notif.${n.kind}`, { who, title: n.title });
}
