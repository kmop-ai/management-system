// Thin helpers over D1. The point is consistency, not abstraction: SQL stays
// visible in every route so a reader can see exactly what a screen costs.

import { conflict, notFound } from './http.js';

export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);

export async function all(db, sql, ...params) {
  const r = await db.prepare(sql).bind(...params).all();
  return r.results || [];
}

export async function first(db, sql, ...params) {
  return (await db.prepare(sql).bind(...params).first()) || null;
}

export async function run(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run();
}

export const stmt = (db, sql, ...params) => db.prepare(sql).bind(...params);

// INSERT built from an object, returns the new id.
export async function insert(db, table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const r = await db.prepare(sql).bind(...keys.map(k => row[k])).run();
  return r.meta.last_row_id;
}

// UPDATE built from an object; always bumps updated_at. The WHERE clause
// includes the updated_at the client last saw when one is supplied, so two
// people editing the same task cannot silently overwrite each other.
export async function update(db, table, id, patch, { expected, touch = true } = {}) {
  const keys = Object.keys(patch);
  if (!keys.length && !touch) return null;
  const sets = keys.map(k => `${k} = ?`);
  const ts = nowIso();
  if (touch) sets.push('updated_at = ?');
  const params = keys.map(k => patch[k]);
  if (touch) params.push(ts);
  let sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`;
  params.push(id);
  if (expected) { sql += ' AND updated_at = ?'; params.push(expected); }
  const r = await db.prepare(sql).bind(...params).run();
  if (expected && r.meta.changes === 0) {
    const cur = await first(db, `SELECT updated_at FROM ${table} WHERE id = ?`, id);
    if (!cur) throw notFound();
    throw conflict('This was changed by someone else since you opened it. Reload to see their changes.', { current_updated_at: cur.updated_at });
  }
  return ts;
}

// The updated_at the client saw, from If-Match (preferred) or the body.
export function expectedVersion(req, body) {
  const h = req.headers.get('if-match');
  if (h) return h.replace(/^W\//, '').replace(/"/g, '');
  return body && typeof body.updated_at === 'string' ? body.updated_at : null;
}

// Count + page in a single D1 round trip.
export async function paged(db, { select, from, where = [], params = [], order, limit, offset }) {
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [count, page] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${w}`).bind(...params),
    db.prepare(`SELECT ${select} FROM ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params, limit, offset),
  ]);
  return { total: count.results[0].n, rows: page.results };
}

// Rows store JSON in a few TEXT columns; parse them on the way out.
export function parseJson(v, fallback = null) {
  if (v == null || v === '') return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

// For "WHERE id IN (...)" with a variable list: bind one JSON array instead
// of N placeholders, which keeps statements cacheable and avoids the
// bound-parameter limit.
export const jsonIds = (ids) => JSON.stringify([...new Set(ids)].filter(x => x != null));
export const IN_JSON = (col) => `${col} IN (SELECT value FROM json_each(?))`;
