// Hourly jobs. Each is idempotent: running twice in an hour changes nothing
// the second time (dedupe keys, "spawn only from the latest occurrence",
// digest timestamps), so a retried cron is harmless.

import { all, first, run, stmt, insert } from './lib/db.js';
import { addDays, localParts } from './lib/dates.js';
import { spawnOccurrence } from './lib/tasks.js';
import { emailImmediate, notificationLine } from './lib/notify.js';
import { queueEmail, sendPending } from './lib/mail.js';
import { t } from './lib/strings.js';

export async function scheduled(event, env) {
  const now = new Date(event.scheduledTime || Date.now());
  try { await runCron(env, { now, purge: now.getUTCHours() === 3 }); }
  catch (e) { console.error('cron failed', e && e.stack || e); }
}

export async function runCron(env, { now = new Date(), purge = false, force = false } = {}) {
  const out = {};
  out.due_notices = await dueNotices(env, now);
  out.recurrences = await scheduleRecurrences(env, now);
  out.digests = await digests(env, now, force);
  out.immediate = await emailImmediate(env, env.APP_URL || '');
  out.sent = await sendPending(env, 100);
  if (purge) out.purged = await retentionPurge(env, now);
  return out;
}

// "Due soon" and "overdue" land in the assignee's inbox once per task per
// due date. Done in one INSERT … SELECT each; preferences apply in SQL.
async function dueNotices(env, now) {
  const today = now.toISOString().slice(0, 10);
  const days = Number((await first(env.DB, `SELECT value FROM settings WHERE key = 'due_soon_days'`))?.value || 2);
  const soon = addDays(today, days);
  const base = `INSERT OR IGNORE INTO notifications (user_id, kind, object_type, object_id, project_id, title, body, url, dedupe_key)
    SELECT t.assignee_id, ?, 'task', t.id, t.project_id, t.title, 'Due ' || t.due_date, '#/tasks/' || t.id, ? || t.id || ':' || t.due_date
      FROM tasks t JOIN users u ON u.id = t.assignee_id LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.deleted_at IS NULL AND t.completed_at IS NULL AND u.active = 1 AND u.deleted_at IS NULL
       AND (p.id IS NULL OR (p.deleted_at IS NULL AND p.archived_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM notification_prefs np WHERE np.user_id = t.assignee_id AND np.kind = ? AND np.in_app = 0)`;
  const [a, b] = await env.DB.batch([
    stmt(env.DB, base + ` AND t.due_date > ? AND t.due_date <= ?`, 'due_soon', 'due_soon:', 'due_soon', today, soon),
    stmt(env.DB, base + ` AND t.due_date < ? AND t.due_date >= ?`, 'overdue', 'overdue:', 'overdue', today, addDays(today, -30)),
  ]);
  return { due_soon: a.meta.changes, overdue: b.meta.changes };
}

// 'schedule' series: once the latest occurrence is due, create the next one,
// so there is always exactly one upcoming occurrence on the calendar.
async function scheduleRecurrences(env, now) {
  const today = now.toISOString().slice(0, 10);
  const due = await all(env.DB, `SELECT r.*, t.id AS t_id FROM recurrences r JOIN tasks t ON t.id = r.source_task_id
     WHERE r.mode = 'schedule' AND r.ended_at IS NULL AND t.deleted_at IS NULL AND t.due_date <= ? AND r.next_due IS NOT NULL LIMIT 200`, today);
  let created = 0;
  for (const r of due) {
    const src = await first(env.DB, `SELECT * FROM tasks WHERE id = ?`, r.t_id);
    const id = await spawnOccurrence(env.DB, r, src, r.next_due);
    if (id) created++;
  }
  return created;
}

// Daily or weekly personal digest at each person's local digest hour.
// Contents: unread notifications not yet emailed, plus what is due today
// and overdue. Never sends an empty digest.
async function digests(env, now, force) {
  const users = await all(env.DB, `SELECT u.*, COALESCE(u.timezone, e.timezone, 'Europe/Athens') AS tz FROM users u LEFT JOIN entities e ON e.id = u.entity_id
     WHERE u.active = 1 AND u.deleted_at IS NULL AND u.digest_frequency <> 'off'`);
  let sent = 0;
  for (const u of users) {
    const local = localParts(u.tz, now);
    if (!force && local.hour !== u.digest_hour) continue;
    if (u.digest_frequency === 'weekly' && local.weekday !== 'Mon' && !force) continue;
    if (u.last_digest_at && localParts(u.tz, new Date(u.last_digest_at)).date === local.date) continue;
    const since = u.last_digest_at || new Date(now - 7 * 86400000).toISOString();
    const [notes, tasks] = await env.DB.batch([
      stmt(env.DB, `SELECT n.*, a.name AS actor_name FROM notifications n LEFT JOIN users a ON a.id = n.actor_id
         WHERE n.user_id = ? AND n.read_at IS NULL AND n.archived_at IS NULL AND n.emailed_at IS NULL AND n.created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM notification_prefs np WHERE np.user_id = n.user_id AND np.kind = n.kind AND np.email = 'off')
         ORDER BY n.created_at DESC LIMIT 50`, u.id, since),
      stmt(env.DB, `SELECT t.id, t.title, t.due_date, p.code AS project_code FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.assignee_id = ? AND t.deleted_at IS NULL AND t.completed_at IS NULL AND t.due_date <= ? AND (p.id IS NULL OR p.archived_at IS NULL)
         ORDER BY t.due_date LIMIT 30`, u.id, local.date),
    ]);
    if (!notes.results.length && !tasks.results.length) {
      await run(env.DB, `UPDATE users SET last_digest_at = ? WHERE id = ?`, now.toISOString(), u.id);
      continue;
    }
    const L = u.locale || 'en';
    const app = env.APP_URL || '';
    const lines = [t(L, 'email.digest_hello', { name: u.name }), ''];
    const overdue = tasks.results.filter(x => x.due_date < local.date), todayT = tasks.results.filter(x => x.due_date === local.date);
    if (overdue.length) { lines.push(t(L, 'email.digest_overdue', { n: overdue.length })); for (const x of overdue) lines.push(`  • ${x.project_code ? `[${x.project_code}] ` : ''}${x.title} (${x.due_date}) ${app}/#/tasks/${x.id}`); lines.push(''); }
    if (todayT.length) { lines.push(t(L, 'email.digest_today', { n: todayT.length })); for (const x of todayT) lines.push(`  • ${x.project_code ? `[${x.project_code}] ` : ''}${x.title} ${app}/#/tasks/${x.id}`); lines.push(''); }
    if (notes.results.length) { lines.push(t(L, 'email.digest_updates', { n: notes.results.length })); for (const n of notes.results) lines.push(`  • ${notificationLine(n, L)}`); lines.push(''); }
    lines.push(t(L, 'email.prefs_footer'));
    await queueEmail(env, { to: u.email, user_id: u.id, kind: 'digest', subject: t(L, 'email.digest_subject', { n: tasks.results.length + notes.results.length }), text: lines.join('\n') });
    await env.DB.batch([
      stmt(env.DB, `UPDATE users SET last_digest_at = ? WHERE id = ?`, now.toISOString(), u.id),
      stmt(env.DB, `UPDATE notifications SET emailed_at = ? WHERE id IN (SELECT value FROM json_each(?))`, now.toISOString(), JSON.stringify(notes.results.map(n => n.id))),
    ]);
    sent++;
  }
  return sent;
}

// The only place anything is hard-deleted. Soft-deleted tasks, comments,
// checklist items and attachments older than the retention window go for
// good (with their R2 objects). Projects are never purged here — EU
// retention rules keep them for years after final payment (Phase 2).
async function retentionPurge(env, now) {
  const days = Number((await first(env.DB, `SELECT value FROM settings WHERE key = 'retention_soft_deleted_days'`))?.value || 180);
  const cutoff = new Date(now - days * 86400000).toISOString();
  const tasks = (await all(env.DB, `SELECT id FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT 500`, cutoff)).map(r => r.id);
  const files = await all(env.DB, `SELECT id, r2_key FROM attachments WHERE (deleted_at IS NOT NULL AND deleted_at < ?)
     OR (object_type = 'task' AND object_id IN (SELECT value FROM json_each(?))) LIMIT 500`, cutoff, JSON.stringify(tasks));
  for (const f of files) await env.FILES.delete(f.r2_key).catch(() => {});
  const ids = JSON.stringify(tasks);
  const stmts = [
    stmt(env.DB, `DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(files.map(f => f.id))),
    stmt(env.DB, `DELETE FROM comments WHERE (deleted_at IS NOT NULL AND deleted_at < ?) OR (object_type = 'task' AND object_id IN (SELECT value FROM json_each(?)))`, cutoff, ids),
    stmt(env.DB, `DELETE FROM checklist_items WHERE (deleted_at IS NOT NULL AND deleted_at < ?) OR task_id IN (SELECT value FROM json_each(?))`, cutoff, ids),
    stmt(env.DB, `DELETE FROM task_followers WHERE task_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM task_labels WHERE task_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM task_field_values WHERE task_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM task_dependencies WHERE blocker_id IN (SELECT value FROM json_each(?)) OR blocked_id IN (SELECT value FROM json_each(?))`, ids, ids),
    stmt(env.DB, `UPDATE tasks SET parent_id = NULL WHERE parent_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM search_fts WHERE object_type = 'task' AND object_id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM tasks WHERE id IN (SELECT value FROM json_each(?))`, ids),
    stmt(env.DB, `DELETE FROM magic_links WHERE expires_at < ?`, new Date(now - 7 * 86400000).toISOString()),
  ];
  const res = await env.DB.batch(stmts);
  const summary = { tasks: tasks.length, attachments: files.length, comments: res[1].meta.changes, checklist_items: res[2].meta.changes };
  if (tasks.length || files.length || summary.comments || summary.checklist_items) {
    await insert(env.DB, 'audit_log', { actor_id: null, action: 'purge', object_type: 'retention', summary:
      `Retention job permanently removed ${summary.tasks} task(s), ${summary.comments} comment(s), ${summary.checklist_items} checklist item(s) and ${summary.attachments} file(s) deleted more than ${days} days ago` });
  }
  return summary;
}
