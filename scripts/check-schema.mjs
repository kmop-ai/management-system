#!/usr/bin/env node
// schema.sql is the canonical, commented description of the database;
// migrations/ is how a live database gets there. This check builds one
// in-memory SQLite database from each and fails if they differ in any
// table, column (name, type, nullability, default, primary key), index,
// trigger or reference row. It also checks the code against the schema:
// every table named in an INSERT/UPDATE/FROM in src/ must exist.
//
// Uses node:sqlite (Node 22+), so it needs no dependencies and no wrangler.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = new URL('..', import.meta.url).pathname;
process.removeAllListeners('warning');

function build(sqlFiles) {
  const db = new DatabaseSync(':memory:');
  for (const f of sqlFiles) {
    try { db.exec(readFileSync(f, 'utf8')); }
    catch (e) { console.error(`${f.replace(root, '')}: ${e.message}`); process.exit(1); }
  }
  return db;
}

function describe(db) {
  const out = {};
  const objs = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts_%' ORDER BY type, name`).all();
  for (const o of objs) {
    if (o.type === 'table') {
      const cols = db.prepare(`PRAGMA table_xinfo("${o.name}")`).all().map(c => `${c.name} ${c.type} ${c.notnull ? 'NOT NULL' : ''} ${c.dflt_value ?? ''} ${c.pk ? 'PK' + c.pk : ''}`.replace(/\s+/g, ' ').trim());
      out[`table ${o.name}`] = cols.join('\n');
      const fks = db.prepare(`PRAGMA foreign_key_list("${o.name}")`).all().map(f => `${f.from}->${f.table}.${f.to}`).sort();
      if (fks.length) out[`fks ${o.name}`] = fks.join(', ');
    } else {
      out[`${o.type} ${o.name}`] = (o.sql || '').replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    }
  }
  for (const t of ['roles', 'modules', 'role_module_access', 'task_statuses', 'settings']) {
    try { out[`rows ${t}`] = JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all().map(r => { delete r.updated_at; return r; })); } catch {}
  }
  return out;
}

const migDir = join(root, 'migrations');
const migrations = readdirSync(migDir).filter(f => f.endsWith('.sql')).sort().map(f => join(migDir, f));
const a = describe(build([join(root, 'schema.sql')]));
const b = describe(build(migrations));

let bad = 0;
for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
  if (a[k] === b[k]) continue;
  bad++;
  if (!(k in a)) console.error(`only in migrations: ${k}`);
  else if (!(k in b)) console.error(`only in schema.sql: ${k}`);
  else console.error(`differs: ${k}\n  schema.sql: ${a[k].replace(/\n/g, ' | ')}\n  migrations: ${b[k].replace(/\n/g, ' | ')}`);
}

// Code ↔ schema: tables referenced by SQL in src/ must exist.
const tables = new Set(Object.keys(a).filter(k => k.startsWith('table ')).map(k => k.slice(6)));
tables.add('schema_migrations'); // created by wrangler's migration runner
const src = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) src.push(p); } })(join(root, 'src'));
src.push(join(root, 'worker.js'));
const refRe = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|FROM|JOIN)\s+([a-z_][a-z0-9_]*)\b/gi;
const ignore = new Set(['json_each', 'select', 'a', 'd', 'down', 'x', 'set', 'where', 'tc']);
for (const f of src) {
  // Only look inside string literals that contain SQL, never comments or prose.
  const code = readFileSync(f, 'utf8');
  const sqlStrings = [...code.matchAll(/`([^`]*)`|'([^'\n]*)'/g)].map(m => m[1] ?? m[2]).filter(x => /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(x)).join('\n').replace(/\$\{[^}]*\}/g, ' ');
  for (const m of sqlStrings.matchAll(refRe)) {
    const name = m[1];
    if (ignore.has(name.toLowerCase()) || /^[A-Z]/.test(name) || name.length < 3 && !tables.has(name)) continue;
    if (!tables.has(name)) { console.error(`${f.replace(root, '')}: references unknown table "${name}"`); bad++; }
  }
}

if (bad) { console.error(`\nschema check failed: ${bad} problem(s)`); process.exit(1); }
console.log(`schema OK: schema.sql and ${migrations.length} migrations agree (${tables.size - 1} tables); code references only known tables.`);
