// Turns an agent's output (<project>-draft.json, <project>-minutes.json) into
// one JSON file per Co-Work database document, for loading as a draft and as
// open suggestions. Nothing here changes the record: a person reviews both.
//   node co-work/agents/prepare-load.mjs <project> <out-dir>
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const [pid, out] = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });
const now = new Date().toISOString(), runId = `session-${pid}`;
const docs = [];
const put = (c, id, d) => docs.push({ c, id, d });
const draftF = join(here, 'out', `${pid}-draft.json`), minF = join(here, 'out', `${pid}-minutes.json`);
if (existsSync(draftF)) {
  const d = JSON.parse(readFileSync(draftF, 'utf8'));
  const { project, ...rest } = d;
  put('drafts', `${pid}__session`, { ...rest, project: pid, status: 'draft', generated_at: now, generated_by: 'session', run_id: runId,
    sources: (d.sources || []).map(s => ({ file_id: s.file_id, title: s.title, url: s.url || null, role: s.role, note: s.note || null })) });
}
let nS = 0;
if (existsSync(minF)) {
  const m = JSON.parse(readFileSync(minF, 'utf8'));
  const meet = new Map();
  for (const mt of m.meetings || []) { const id = `${pid}__${mt.file_id}`; meet.set(mt.file_id, { id, ...mt }); }
  for (const s of m.suggestions || []) {
    const mt = meet.get(s.meeting_file_id || s.cite?.file_id) || {};
    put('suggestions', `${pid}__s${String(++nS).padStart(3, '0')}`, { ...s, project: pid, agent: 'minutes', meeting_id: mt.id || null, status: 'open', run_id: runId, created_at: now,
      cite: { ...(s.cite || {}), url: s.cite?.url || mt.url || null } });
  }
  for (const mt of meet.values()) put('meetings', mt.id, { project: pid, file_id: mt.file_id, title: mt.title, date: mt.date || null, type: mt.type || 'other', url: mt.url || null, note: mt.note || null,
    extracted_at: now, extracted_by: 'session', suggestion_count: (m.suggestions || []).filter(s => (s.meeting_file_id || s.cite?.file_id) === mt.file_id).length });
}
put('agent_runs', runId, { agent: 'onboarding', project: pid, by: 'session', at: now, status: 'done', finished_at: now,
  files: docs.find(x => x.c === 'drafts')?.d.sources?.map(s => ({ id: s.file_id, title: s.title, role: s.role })) || [],
  counts: { draft: docs.some(x => x.c === 'drafts') ? 1 : 0, suggestions: nS } });
for (const x of docs) { mkdirSync(join(out, x.c), { recursive: true }); const f = join(out, x.c, `${x.id}.json`); writeFileSync(f, JSON.stringify(x.d)); if (JSON.stringify(x.d).length > 250000) console.error('TOO BIG', f); }
const writes = docs.map(x => ({ op: 'set', collection: x.c, doc_id: x.id, file_path: join(out, x.c, `${x.id}.json`) }));
for (let i = 0; i < writes.length; i += 50) writeFileSync(join(out, `batch-${i / 50 + 1}.json`), JSON.stringify(writes.slice(i, i + 50)));
console.log(pid, docs.length, 'docs', Math.ceil(writes.length / 50), 'batches');
