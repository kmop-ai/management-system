#!/usr/bin/env node
// Smoke test: exercises every API route against a running dev server and
// fails if any route was not called, any call returned an unexpected status,
// or access rules let the wrong person through.
//
//   npm run dev            # in one terminal (DEV_MODE=1, seeded database)
//   npm run smoke          # in another;  BASE=http://localhost:8787 by default
//
// It signs in through the real magic-link flow (DEV_MODE returns the token),
// creates its own throwaway admin, members and project, and leaves the seed
// data alone. Server-side timings from the server-timing header are
// reported; list endpoints over 200 ms are flagged.

const BASE = process.env.BASE || process.argv[2] || 'http://localhost:8787';
const stamp = Date.now().toString(36);
let failures = 0, calls = 0;
const timings = [];

// ---- route coverage ---------------------------------------------------------
const routes = (await (await fetch(BASE + '/api/_routes')).json()).data;
const compiled = routes.map(r => ({ ...r, re: new RegExp('^' + r.path.replace(/:[a-zA-Z_]+/g, '[^/]+') + '$'), hit: false }));
function cover(method, path) {
  const p = path.split('?')[0];
  const r = compiled.find(x => x.method === method && x.re.test(p));
  if (r) r.hit = true;
}

// ---- client -------------------------------------------------------------------
class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async req(method, path, { body, form, version, expect = [200, 201], raw = false } = {}) {
    calls++;
    cover(method, '/api' + path);
    const headers = { origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    if (version) headers['if-match'] = version;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + '/api' + path, { method, headers, body: payload, redirect: 'manual' });
    const setc = res.headers.get('set-cookie');
    if (setc) { const m = /kmop_session=([^;]*)/.exec(setc); if (m) this.cookie = m[1] ? `kmop_session=${m[1]}` : ''; }
    const st = res.headers.get('server-timing');
    if (st) timings.push({ ms: Number(/dur=([\d.]+)/.exec(st)?.[1] || 0), what: `${method} ${path.split('?')[0]}`, list: method === 'GET' });
    const exp = Array.isArray(expect) ? expect : [expect];
    let data = null;
    if (raw) data = await res.text();
    else { const txt = await res.text(); try { data = JSON.parse(txt); } catch { data = txt; } }
    if (!exp.includes(res.status)) {
      failures++;
      console.error(`✗ [${this.name}] ${method} ${path} → ${res.status} (expected ${exp.join('/')})`, typeof data === 'object' ? JSON.stringify(data).slice(0, 300) : String(data).slice(0, 200));
    }
    return { status: res.status, data: raw ? data : data?.data, meta: data?.meta, error: data?.error, headers: res.headers };
  }
  get(p, o) { return this.req('GET', p, o); }
  post(p, body, o = {}) { return this.req('POST', p, { body: body ?? {}, ...o }); }
  put(p, body, o = {}) { return this.req('PUT', p, { body, ...o }); }
  patch(p, body, o = {}) { return this.req('PATCH', p, { body, ...o }); }
  del(p, o) { return this.req('DELETE', p, o); }
  async signIn(email) {
    const r = await this.post('/auth/request-link', { email });
    if (!r.data?.dev_token) { failures++; console.error(`✗ no dev_token for ${email} — is DEV_MODE=1 and does the user exist?`); return; }
    await this.post('/auth/verify', { token: r.data.dev_token });
    if (!this.cookie) { failures++; console.error(`✗ sign-in failed for ${email}`); }
  }
}

function check(cond, msg) {
  if (cond) return;
  failures++;
  console.error('✗ ' + msg);
}

const step = (s) => console.log('· ' + s);

// =============================================================================
step('health and auth');
const anon = new Client('anon');
await anon.get('/health');
await anon.get('/me', { expect: 401 });
await anon.post('/auth/verify', { token: 'nope' }, { expect: 400 });
const cross = await fetch(BASE + '/api/auth/request-link', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"email":"x@kmop.org"}' });
check(cross.status === 403, `cross-origin POST should be refused, got ${cross.status}`);

const root = new Client('root');
await root.signIn('y.markou@kmop.org');

// Our own throwaway super admin, so session revocation at the end hurts nobody.
const S = new Client('smoke-admin');
const adminEmail = `smoke-${stamp}@kmop.org`;
const adm = await root.post('/users', { email: adminEmail, name: `Smoke Admin ${stamp}`, entity_id: 1, role: 'super_admin' });
await S.signIn(adminEmail);
const me = await S.get('/me');
check(me.data?.access?.modules?.admin === 3, 'smoke admin should have admin level 3');
await S.patch('/me', { digest_hour: 9, locale: 'en' });
const prefs = await S.get('/me/notification-prefs');
await S.put('/me/notification-prefs', { prefs: [{ kind: 'commented', in_app: 1, email: 'off' }] });
check(Array.isArray(prefs.data) && prefs.data.length >= 5, 'notification prefs list');

// =============================================================================
step('people and roles');
const mEmail = `smoke-member-${stamp}@kmop.org`, gEmail = `smoke-guest-${stamp}@partner.example`;
const member = (await S.post('/users', { email: mEmail, name: `Smoke Member ${stamp}`, entity_id: 1, department_id: 2, weekly_hours: 40 })).data;
const guest = (await S.post('/users', { email: gEmail, name: `Smoke Guest ${stamp}`, is_external: true, external_org: 'Partner NGO' })).data;
await S.post('/users', { email: mEmail, name: 'dup' }, { expect: 409 });
await S.post('/users', { email: `aud-${stamp}@kmop.org`, name: 'Auditor', role: 'auditor' }, { expect: 400 });
await S.post('/users', { email: `bad-${stamp}@kmop.org`, name: 'Bad', role: 'nope' }, { expect: 400 });
await S.get('/users?q=Smoke');
const mu = await S.get(`/users/${member.id}`);
await S.patch(`/users/${member.id}`, { title: 'Project Officer' }, { version: mu.data.updated_at });
await S.patch(`/users/${member.id}`, { title: 'stale' }, { version: '2000-01-01T00:00:00.000Z', expect: 409 });
await S.get(`/users/${member.id}/roles`);
await S.post(`/users/${member.id}/roles`, { role: 'auditor' }, { expect: 400 }); // auditor needs an end date
const aud = await S.post(`/users/${member.id}/roles`, { role: 'auditor', valid_until: '2099-01-01' });
await S.del(`/users/${member.id}/roles/${aud.data.id}`);
const ma = await S.post(`/users/${member.id}/module-access`, { module: 'finance', entity_id: 1, level: 1, reason: 'smoke test' });
await S.del(`/users/${member.id}/module-access/${ma.data.id}`);
const M = new Client('member'); await M.signIn(mEmail);
const G = new Client('guest'); await G.signIn(gEmail);
await M.post('/users', { email: 'x@kmop.org', name: 'Nope' }, { expect: 403 });

// =============================================================================
step('organisation config');
const ents = await S.get('/entities');
check(ents.data?.length >= 3, 'three entities');
const ne = await S.post('/entities', { code: 'SMK' + stamp.slice(-3).toUpperCase(), name: 'Smoke entity', country: 'gr' });
const e1 = await S.get(`/entities/${ne.data.id}`);
await S.patch(`/entities/${ne.data.id}`, { city: 'Patras' }, { version: e1.data.updated_at });
const hol = await S.post(`/entities/${ne.data.id}/holidays`, { date: '2030-03-25', name: 'Independence Day' });
await S.get(`/entities/${ne.data.id}/holidays?from=2030-01-01&to=2030-12-31`);
await S.del(`/holidays/${hol.data.id}`);
await S.del(`/entities/${ne.data.id}`);
await M.post('/entities', { code: 'NOPE', name: 'x', country: 'GR' }, { expect: 403 });
await S.get('/departments');
const dep = await S.post('/departments', { name: `Smoke dept ${stamp}`, entity_id: 1 });
await S.patch(`/departments/${dep.data.id}`, { name_el: 'Τμήμα δοκιμής' });
await S.del(`/departments/${dep.data.id}`);
const roles = await S.get('/roles');
check(roles.data?.matrix?.length > 20, 'role matrix');
const tm = roles.data.matrix.filter(r => r.role === 'team_member');
await S.put('/roles/team_member/access', { levels: Object.fromEntries(tm.map(r => [r.module, r.level])) });
const tmRole = roles.data.roles.find(r => r.key === 'team_member');
await S.patch('/roles/team_member', { label_en: tmRole.label_en });
await S.get('/settings');
await S.patch('/settings/due_soon_days', { value: '2' });
await S.get('/task-statuses');

// =============================================================================
step('projects, members, sections, allocations');
const start = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const end = new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10);
await M.post('/projects', { name: 'Not allowed', entity_id: 1 }, { expect: 403 });
await S.post('/projects', { name: 'No entity' }, { expect: 400 });
const proj = (await S.post('/projects', { name: `Smoke project ${stamp}`, code: 'SMOKE', entity_id: 1, start_date: start, end_date: end, kind: 'eu', funder: 'Erasmus+ KA220-ADU' })).data;
await S.get('/projects?member=me&sort=-start');
let pr = await S.get(`/projects/${proj.id}`);
await S.patch(`/projects/${proj.id}`, { description: 'Smoke **test** project' }, { version: pr.data.updated_at });
await S.post(`/projects/${proj.id}/members`, { user_id: member.id, role: 'member' });
await S.post(`/projects/${proj.id}/members`, { user_id: guest.id, role: 'pm' }); // externals are forced to guest
await S.get(`/projects/${proj.id}/members`);
await S.patch(`/projects/${proj.id}/members/${member.id}`, { role: 'viewer' });
await S.patch(`/projects/${proj.id}/members/${member.id}`, { role: 'member' });
await S.patch(`/projects/${proj.id}/members/${guest.id}`, { role: 'member' }, { expect: 400 });
const sec1 = (await S.post(`/projects/${proj.id}/sections`, { name: 'WP1 — Management' })).data;
const sec2 = (await S.post(`/projects/${proj.id}/sections`, { name: 'Temp' })).data;
await S.get(`/projects/${proj.id}/sections`);
await S.patch(`/sections/${sec1.id}`, { name: 'WP1 — Project management' });
await S.del(`/sections/${sec2.id}`);
const al = await S.post('/allocations', { user_id: member.id, project_id: proj.id, start_date: start, end_date: end, fte_pct: 40, person_months: 4 });
await S.get(`/allocations?project_id=${proj.id}`);
await S.patch(`/allocations/${al.data.id}`, { fte_pct: 50 });
const al2 = await S.post('/allocations', { user_id: member.id, project_id: proj.id, start_date: start, end_date: start, fte_pct: 10 });
await S.del(`/allocations/${al2.data.id}`);
const gp = await G.get('/projects');
check(gp.data?.length === 1 && gp.data[0].id === proj.id, `guest should see exactly the one project they are in, saw ${gp.data?.length}`);

// =============================================================================
step('labels and custom fields');
const lab = (await S.post('/labels', { name: 'smoke', color: '#123456', project_id: proj.id })).data;
await S.get(`/labels?project_id=${proj.id}`);
await S.patch(`/labels/${lab.id}`, { color: '#654321' });
const lab2 = (await S.post('/labels', { name: 'temp', project_id: proj.id })).data;
await S.del(`/labels/${lab2.id}`);
const fld = (await S.post(`/projects/${proj.id}/fields`, { name: 'Lead partner', type: 'select', options: ['KMOP', 'APE'] })).data;
await S.get(`/projects/${proj.id}/fields`);
await S.patch(`/fields/${fld.id}`, { name: 'Lead partner (WP)' });
const fld2 = (await S.post(`/projects/${proj.id}/fields`, { name: 'Temp', type: 'number' })).data;
await S.del(`/fields/${fld2.id}`);

// =============================================================================
step('task engine');
const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
const A = (await S.post('/tasks', { title: 'Draft the toolkit outline', project_id: proj.id, section_id: sec1.id, assignee_id: member.id, start_date: start, due_date: soon,
  estimate_hours: 12, priority: 'high', label_ids: [lab.id], fields: { [fld.id]: 'kmop' }, checklist: ['Outline', 'Learning outcomes'], description: 'Ask @[Smoke Member](user:' + member.id + ') to review' })).data;
check(A.checklist?.length === 2 && A.labels?.length === 1 && A.fields?.[fld.id] === 'kmop', 'task created with checklist, label, field');
await S.post('/tasks', { title: 'Bad assignee', project_id: proj.id, assignee_id: adm.data.id + 99999 }, { expect: 422 });
const sub = (await S.post('/tasks', { title: 'Section 1 of the outline', parent_id: A.id })).data;
check(sub.project_id === proj.id, 'subtask inherits project');
const B = (await S.post('/tasks', { title: 'Partner review', project_id: proj.id, due_date: end })).data;
const INT = (await S.post('/tasks', { title: 'Chase the late partner', project_id: proj.id, is_internal: true })).data;
const P = (await S.post('/tasks', { title: 'Personal reminder' })).data;
check(P.assignee_id === S.me?.id || P.assignee_id === adm.data.id, 'personal task assigned to creator');
await S.get(`/tasks?project_id=${proj.id}&parent=none&sort=section,position`);
await S.get(`/tasks?assignee=me&state=open&due_to=${end}&q=reminder`);
await S.get(`/tasks?project_id=${proj.id}&field.${fld.id}=kmop`);
await S.get(`/tasks?project_id=${proj.id}&sort=bogus`, { expect: 400 });
const full = await S.get(`/tasks/${A.id}`);
check(full.data.subtasks.length === 1, 'detail includes subtask');
await S.patch(`/tasks/${A.id}`, { title: 'Draft the toolkit outline (v2)' }, { version: full.data.updated_at });
await S.patch(`/tasks/${A.id}`, { title: 'stale write' }, { version: full.data.updated_at, expect: 409 });
await S.patch(`/tasks/${A.id}`, { start_date: soon, due_date: start }, { expect: 422 });
await S.patch(`/tasks/${sub.id}`, { parent_id: sub.id }, { expect: 400 });
await S.patch(`/tasks/${A.id}`, { parent_id: sub.id }, { expect: 400 }); // would be a cycle
const done = await S.patch(`/tasks/${B.id}`, { status: 'done' });
check(!!done.data?.completed_at, 'done sets completed_at');
await S.patch(`/tasks/${B.id}`, { completed: false });
await S.req('PATCH', '/tasks', { body: { ids: [A.id, B.id], patch: { priority: 'medium' } } });
await S.get('/my-tasks');
const dup = await S.post(`/tasks/${A.id}/duplicate`);
await S.del(`/tasks/${dup.data.id}`);
await S.post(`/tasks/${dup.data.id}/restore`);
await S.del(`/tasks/${dup.data.id}`);
await S.post(`/tasks/${A.id}/followers`, { user_id: member.id });
await S.post(`/tasks/${A.id}/followers`, { user_id: guest.id });
await S.del(`/tasks/${A.id}/followers/${guest.id}`);
await S.post(`/tasks/${B.id}/dependencies`, { blocker_id: A.id });
await S.post(`/tasks/${A.id}/dependencies`, { blocker_id: B.id }, { expect: 409 }); // cycle refused
const deps = await S.get(`/projects/${proj.id}/dependencies`);
check(deps.data?.length === 1, 'one dependency');
await S.del(`/tasks/${B.id}/dependencies/${A.id}`);
await S.post(`/tasks/${B.id}/dependencies`, { blocker_id: A.id });
const ci = (await S.post(`/tasks/${A.id}/checklist`, { text: 'Send to partners' })).data;
await S.patch(`/checklist/${ci.id}`, { done: true });
await S.del(`/checklist/${ci.id}`);
// recurrence: completion mode spawns the next one when this is completed
const R = (await S.post('/tasks', { title: 'Monthly partner report chase', project_id: proj.id, due_date: soon, checklist: ['Email partners'] })).data;
await S.put(`/tasks/${R.id}/recurrence`, { freq: 'monthly', interval_n: 1, mode: 'completion' });
await S.patch(`/tasks/${R.id}`, { completed: true });
const series = await S.get(`/tasks?project_id=${proj.id}&q=Monthly partner report chase&state=all`);
check(series.data?.length === 2, `completing a recurring task should create the next occurrence (found ${series.data?.length})`);
const R2 = series.data.find(x => x.id !== R.id);
await S.put(`/tasks/${R2.id}/recurrence`, { freq: 'weekly', by_weekday: '15', mode: 'schedule' });
await S.del(`/tasks/${R2.id}/recurrence`);

// =============================================================================
step('access rules');
await G.get(`/tasks/${INT.id}`, { expect: 404 });            // internal tasks are invisible to guests
await G.get(`/tasks/${A.id}`);
await G.post('/tasks', { title: 'guest task', project_id: proj.id }, { expect: 403 });
const gt = await G.get(`/tasks?project_id=${proj.id}`);
check(!gt.data?.some(x => x.id === INT.id), 'guest list hides internal task');
await M.get(`/tasks/${P.id}`, { expect: 404 });              // personal tasks are private
const mt = await M.get(`/tasks/${A.id}`);
await M.patch(`/tasks/${A.id}`, { status: 'in_progress' }, { version: mt.data.updated_at });

// =============================================================================
step('comments, mentions, attachments');
const cm = (await S.post('/comments', { object_type: 'task', object_id: A.id, body: `Please check, @[Smoke Member](user:${member.id})` })).data;
await S.get(`/comments?object_type=task&object_id=${A.id}`);
await S.patch(`/comments/${cm.id}`, { body: 'Edited comment' });
await M.patch(`/comments/${cm.id}`, { body: 'not mine' }, { expect: 403 });
const pc = (await S.post('/comments', { object_type: 'project', object_id: proj.id, body: 'Project-level note' })).data;
await S.del(`/comments/${pc.id}`);
const form = new FormData();
form.append('object_type', 'task'); form.append('object_id', String(A.id));
form.append('file', new Blob(['hello from the smoke test'], { type: 'text/plain' }), 'smoke.txt');
const att = (await S.req('POST', '/attachments', { form })).data;
await S.get(`/attachments?object_type=task&object_id=${A.id}`);
await S.get(`/attachments?project_id=${proj.id}`);
const dl = await S.req('GET', `/attachments/${att.id}/download`, { raw: true });
check(dl.data === 'hello from the smoke test', 'download returns the uploaded bytes');
await G.req('GET', `/attachments/${att.id}/download`, { raw: true });
await S.del(`/attachments/${att.id}`);

// =============================================================================
step('inbox');
const inbox = await M.get('/notifications');
check(inbox.data?.some(n => n.kind === 'mentioned'), 'member was notified of the mention');
check(inbox.data?.some(n => n.kind === 'assigned'), 'member was notified of the assignment');
await M.get('/notifications/count');
await M.get('/notifications?box=unread');
const nid = inbox.data[0].id;
await M.post(`/notifications/${nid}/read`);
await M.post(`/notifications/${nid}/unread`);
await M.post(`/notifications/${nid}/archive`);
await M.post('/notifications/read-all');
await M.post('/notifications/archive-read');
await M.post(`/notifications/${inbox.data[0].id + 999999}/read`, {}, { expect: 404 });

// =============================================================================
step('templates');
await S.get('/templates/projects');
const tplBody = { sections: [{ name: 'WP1' }], labels: [{ name: 'deliverable' }], tasks: [
  { key: 'k', title: 'Kick-off', section: 'WP1', due_month: 1, is_milestone: true, assign: 'creator', checklist: ['Agenda'] },
  { key: 'r', title: 'Report', section: 'WP1', due_offset: 90, blocked_by: ['k'], labels: ['deliverable'], subtasks: [{ key: 'r1', title: 'Draft' }] } ] };
await S.post('/templates/projects', { name: 'bad', body: { tasks: [{ key: 'a', title: 'x', blocked_by: ['nope'] }] } }, { expect: 422 });
const tpl = (await S.post('/templates/projects', { name: `Smoke template ${stamp}`, body: tplBody })).data;
await S.get(`/templates/projects/${tpl.id}`);
await S.patch(`/templates/projects/${tpl.id}`, { description: 'Used by the smoke test' });
const fromTpl = (await S.post('/projects', { name: `From template ${stamp}`, entity_id: 3, start_date: start, template_id: tpl.id })).data;
const ft = await S.get(`/tasks?project_id=${fromTpl.id}`);
check(ft.data?.length === 3, `template created 3 tasks (got ${ft.data?.length})`);
const ftd = await S.get(`/projects/${fromTpl.id}/dependencies`);
check(ftd.data?.length === 1, 'template dependency created');
const saved = await S.post(`/projects/${proj.id}/save-as-template`, { name: `Saved ${stamp}` });
check(saved.data?.tasks >= 4, 'save-as-template captured tasks');
await S.del(`/templates/projects/${saved.data.id}`);
await S.del(`/templates/projects/${tpl.id}`);
await S.get('/templates/tasks');
const tt = (await S.post('/templates/tasks', { name: `Timesheet run ${stamp}`, body: { title: 'Quarterly timesheet run', checklist: ['Export', 'Sign'], subtasks: [{ title: 'Remind staff' }] } })).data;
await S.patch(`/templates/tasks/${tt.id}`, { name: `Timesheet run ${stamp} (v2)` });
const applied = await S.post(`/templates/tasks/${tt.id}/apply`, { project_id: proj.id, section_id: sec1.id, assignee_id: member.id, due_date: soon });
check(!!applied.data?.id, 'task template applied');
await S.del(`/templates/tasks/${tt.id}`);
await S.del(`/projects/${fromTpl.id}`);

// =============================================================================
step('workload, leave, metrics');
await S.get(`/workload?project_id=${proj.id}&weeks=8`);
const wl = await S.get(`/workload?user_ids=${member.id}&from=${start}&weeks=12`);
check(wl.data?.people?.[0]?.weeks?.length === 12, 'workload has 12 weeks');
await S.get('/workload?scope=all&weeks=4');
await G.get(`/workload?project_id=${proj.id}`, { expect: 403 });
const lv = (await M.post('/leave', { start_date: soon, end_date: soon, kind: 'annual' })).data;
await M.get('/leave?user_id=me');
await S.get(`/leave?from=${start}&to=${end}`);
await M.patch(`/leave/${lv.id}`, { half_day: true });
await M.post('/leave', { user_id: adm.data.id, start_date: soon, end_date: soon }, { expect: 403 });
await M.del(`/leave/${lv.id}`);
await S.get(`/people/${member.id}/metrics`);
await M.get(`/people/${member.id}/metrics`);                       // own numbers: visible
await M.get(`/people/${adm.data.id}/metrics`, { expect: 403 });    // someone else's: restricted by role

// =============================================================================
step('views, search, activity, audit, cron');
const v = (await S.post('/views', { scope: `project:${proj.id}`, name: 'Open WP1', view_type: 'board', config: { filters: { state: 'open' } }, shared: true })).data;
await S.get(`/views?scope=project:${proj.id}`);
await S.patch(`/views/${v.id}`, { name: 'Open WP1 tasks' });
await S.del(`/views/${v.id}`);
const sr = await S.get('/search?q=toolkit outline');
check(sr.data?.tasks?.some(x => x.id === A.id), 'search finds the task');
const gs = await G.get('/search?q=chase late partner');
check(!gs.data?.tasks?.some(x => x.id === INT.id), 'search hides internal tasks from guests');
await S.get(`/activity?project_id=${proj.id}`);
await S.get(`/activity?task_id=${A.id}`);
await S.get('/activity');
const au = await S.get(`/audit?project_id=${proj.id}`);
check(au.data?.length > 10 && au.data.every(r => typeof r.summary === 'string' && r.summary.length > 10), 'audit rows have readable summaries');
await S.get('/audit?q=Smoke&limit=20');
await M.get('/audit', { expect: 403 });
const csv = await S.req('GET', `/audit/export?project_id=${proj.id}`, { raw: true });
check(String(csv.data).startsWith('at,actor,action'), 'audit CSV export');
await S.get('/dev/outbox');
const cron = await S.post('/dev/cron', {});
check(cron.data && 'due_notices' in cron.data, 'cron ran');

// =============================================================================
step('archive, delete, restore, sign-out');
await S.post(`/projects/${proj.id}/archive`, { archived: true });
await S.post(`/projects/${proj.id}/archive`, { archived: false });
await S.del(`/projects/${proj.id}/members/${guest.id}`);
await S.del(`/tasks/${A.id}`);
await S.post(`/tasks/${A.id}/restore`);
await S.del(`/projects/${proj.id}`);
await S.post(`/projects/${proj.id}/restore`);
await S.del(`/projects/${proj.id}`);
await S.post(`/users/${member.id}/revoke-sessions`);
await M.get('/me', { expect: 401 });
await M.get(`/users/${member.id}/export`, { expect: 401 });  // sessions were revoked above
const ex = await S.req('GET', `/users/${member.id}/export`, { raw: true });
check(JSON.parse(ex.data).profile?.email === mEmail, 'personal data export');
await S.post(`/users/${member.id}/anonymise`, {}, { expect: 400 });   // still active
await S.del(`/users/${guest.id}`);
await S.del(`/users/${member.id}`);
await S.post(`/users/${member.id}/anonymise`);
await S.get(`/users?q=anonymised&active=all`);
await root.post('/auth/logout');
await S.post('/auth/logout-everywhere');
await S.get('/me', { expect: 401 });
await root.del(`/users/${adm.data.id}`, { expect: 401 }); // root signed out above
const root2 = new Client('root2'); await root2.signIn('y.markou@kmop.org');
await root2.del(`/users/${adm.data.id}`);
await root2.post('/auth/logout');

// =============================================================================
const missed = compiled.filter(r => !r.hit && r.path !== '/api/_routes');
for (const r of missed) { failures++; console.error(`✗ route never exercised: ${r.method} ${r.path}`); }
const slowLists = timings.filter(x => x.list && x.ms > 200);
const p95 = timings.map(x => x.ms).sort((a, b) => a - b)[Math.floor(timings.length * 0.95)] || 0;
console.log(`\n${calls} calls, ${compiled.length - missed.length - 1}/${compiled.length - 1} routes covered, p95 server time ${p95} ms`);
for (const s of slowLists) console.warn(`  slow: ${s.what} ${s.ms} ms`);
if (failures) { console.error(`\nSMOKE FAILED: ${failures} problem(s)`); process.exit(1); }
console.log('SMOKE OK');
