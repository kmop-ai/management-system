// Shared task logic: the list SELECT, row decoration, recurrence spawning.
// Used by the task routes, templates and the cron job.

import { all, first, insert, stmt, nowIso, today } from './db.js';
import { nextOccurrence, addDays, daysBetween } from './dates.js';

// Everything a list/board/timeline row needs, in one statement. Counts are
// correlated subqueries over indexed columns — evaluated in SQLite, not as
// extra round trips, so a 200-row page is still one query.
export const TASK_SELECT = `t.id, t.project_id, t.parent_id, t.section_id, t.title, t.status, t.priority, t.assignee_id,
  t.start_date, t.due_date, t.estimate_hours, t.is_milestone, t.is_internal, t.position, t.recurrence_id,
  t.completed_at, t.created_by, t.created_at, t.updated_at, t.assigned_at,
  ts.category AS status_category,
  p.name AS project_name, p.code AS project_code, p.color AS project_color, p.entity_id AS project_entity_id, p.start_date AS project_start,
  ua.name AS assignee_name,
  s.name AS section_name,
  (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL) AS subtask_count,
  (SELECT COUNT(*) FROM tasks c WHERE c.parent_id = t.id AND c.deleted_at IS NULL AND c.completed_at IS NOT NULL) AS subtask_done,
  (SELECT COUNT(*) FROM comments cm WHERE cm.object_type = 'task' AND cm.object_id = t.id AND cm.deleted_at IS NULL) AS comment_count,
  (SELECT COUNT(*) FROM attachments at WHERE at.object_type = 'task' AND at.object_id = t.id AND at.deleted_at IS NULL) AS attachment_count,
  (SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id AND ci.deleted_at IS NULL) AS checklist_total,
  (SELECT COUNT(*) FROM checklist_items ci WHERE ci.task_id = t.id AND ci.deleted_at IS NULL AND ci.done = 1) AS checklist_done,
  (SELECT COUNT(*) FROM task_dependencies d JOIN tasks b ON b.id = d.blocker_id
     WHERE d.blocked_id = t.id AND b.deleted_at IS NULL AND b.completed_at IS NULL) AS open_blockers,
  (SELECT json_group_array(json_object('id', l.id, 'name', l.name, 'color', l.color))
     FROM task_labels tl JOIN labels l ON l.id = tl.label_id WHERE tl.task_id = t.id AND l.deleted_at IS NULL) AS labels_json,
  (SELECT json_group_object(fv.field_id, json(fv.value)) FROM task_field_values fv WHERE fv.task_id = t.id AND fv.value IS NOT NULL) AS fields_json`;

export const TASK_FROM = `tasks t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN users ua ON ua.id = t.assignee_id
  LEFT JOIN sections s ON s.id = t.section_id
  LEFT JOIN task_statuses ts ON ts.key = t.status`;

export function decorate(row) {
  row.labels = row.labels_json ? JSON.parse(row.labels_json) : [];
  row.fields = row.fields_json ? JSON.parse(row.fields_json) : {};
  delete row.labels_json; delete row.fields_json;
  return row;
}

export async function statusCategory(db, key) {
  const s = await first(db, `SELECT category FROM task_statuses WHERE key = ?`, key);
  return s ? s.category : null;
}

export const isClosed = (cat) => cat === 'done' || cat === 'cancelled';

// Creates the next occurrence of a recurring series from its latest task.
// Returns the new task id, or null when the series has ended.
export async function spawnOccurrence(db, rec, src, due, actorId = null) {
  if (rec.until_date && due > rec.until_date) {
    await db.prepare(`UPDATE recurrences SET ended_at = ? WHERE id = ?`).bind(nowIso(), rec.id).run();
    return null;
  }
  const span = src.start_date && src.due_date ? daysBetween(src.start_date, src.due_date) : null;
  const pos = (await first(db, `SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id IS ? AND section_id IS ?`, src.project_id, src.section_id)).p;
  const id = await insert(db, 'tasks', {
    project_id: src.project_id, parent_id: src.parent_id, section_id: src.section_id, title: src.title, description: src.description,
    status: 'todo', priority: src.priority, assignee_id: src.assignee_id, assigned_at: src.assignee_id ? nowIso() : null,
    start_date: span != null ? addDays(due, -span) : null, due_date: due, estimate_hours: src.estimate_hours,
    is_internal: src.is_internal, position: pos, recurrence_id: rec.id, created_by: actorId ?? src.created_by,
  });
  const next = nextOccurrence(rec, due);
  await db.batch([
    stmt(db, `INSERT INTO task_labels (task_id, label_id) SELECT ?, label_id FROM task_labels WHERE task_id = ?`, id, src.id),
    stmt(db, `INSERT INTO task_followers (task_id, user_id, reason) SELECT ?, user_id, reason FROM task_followers WHERE task_id = ?`, id, src.id),
    stmt(db, `INSERT INTO checklist_items (task_id, text, position) SELECT ?, text, position FROM checklist_items WHERE task_id = ? AND deleted_at IS NULL`, id, src.id),
    stmt(db, `INSERT INTO task_field_values (task_id, field_id, value, value_num) SELECT ?, field_id, value, value_num FROM task_field_values WHERE task_id = ?`, id, src.id),
    stmt(db, `UPDATE recurrences SET source_task_id = ?, next_due = ? WHERE id = ?`, id, next, rec.id),
  ]);
  return id;
}

// Called when a task closes. 'completion' series always spawn from the
// completion date; 'schedule' series spawn early if the next one does not
// exist yet, so finishing ahead of time shows what comes next.
export async function onTaskClosed(db, task, actorId) {
  if (!task.recurrence_id) return null;
  const rec = await first(db, `SELECT * FROM recurrences WHERE id = ? AND ended_at IS NULL`, task.recurrence_id);
  if (!rec || rec.source_task_id !== task.id) return null;
  const due = rec.mode === 'completion' ? nextOccurrence(rec, today()) : (rec.next_due || nextOccurrence(rec, task.due_date || today()));
  return spawnOccurrence(db, rec, task, due, actorId);
}

// Recursive descendants (subtasks of subtasks…) of a task.
export async function descendantIds(db, id, { includeDeleted = false, deletedAt = null } = {}) {
  const rows = await all(db, `WITH RECURSIVE d(id) AS (
      SELECT id FROM tasks WHERE parent_id = ?
      UNION SELECT t.id FROM tasks t JOIN d ON t.parent_id = d.id)
    SELECT t.id FROM tasks t JOIN d ON d.id = t.id
     WHERE ${includeDeleted ? (deletedAt ? 't.deleted_at = ?' : '1') : 't.deleted_at IS NULL'}`, id, ...(deletedAt ? [deletedAt] : []));
  return rows.map(r => r.id);
}

export const MENTION_RE = /@\[([^\]]{1,120})\]\(user:(\d+)\)/g;
export function mentionedIds(text) {
  const out = new Set();
  if (!text) return [];
  for (const m of text.matchAll(MENTION_RE)) out.add(Number(m[2]));
  return [...out];
}
