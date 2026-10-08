#!/usr/bin/env node
// Migrations must be numbered strictly: 001_name.sql, 002_name.sql, … with
// no gaps and no duplicates (ARTIT HQ ended up with two 010_ files; never
// again). Runs before every `db:migrate` and `deploy`.

import { readdirSync } from 'node:fs';

const dir = new URL('../migrations/', import.meta.url);
const files = readdirSync(dir).filter(f => !f.startsWith('.')).sort();
let bad = 0;
files.forEach((f, i) => {
  const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f);
  if (!m) { console.error(`bad name: ${f} (expected NNN_lower_snake.sql)`); bad++; return; }
  const n = Number(m[1]);
  if (n !== i + 1) { console.error(`out of sequence: ${f} should be number ${String(i + 1).padStart(3, '0')}`); bad++; }
});
if (bad) process.exit(1);
console.log(`migrations OK: ${files.length} files, 001–${String(files.length).padStart(3, '0')}`);
