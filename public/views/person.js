// One person: who they are, their projects, capacity, allocations, leave,
// the next weeks of workload, the evaluation metrics (only for the roles
// allowed to see them — the server decides, we never hint at them
// otherwise) and, for administrators, their access.

import { h, mount, icon, todayStr } from '../lib/dom.js';
import { api, listAll } from '../lib/api.js';
import { state, t, can, entityById, deptById, deptName, roleLabel, moduleLabel } from '../lib/state.js';
import { formDialog, confirmDialog, showError, toast, avatar, fmtDate, fmtDateTime, timeAgo, emptyState, spinner } from '../lib/ui.js';
import { ISO_DAYS, weekdayName, workDaysText } from './people.js';

const LEAVE_KINDS = ['annual', 'sick', 'training', 'unpaid', 'other'];
const leaveKindLabel = (k) => ({
  annual: t('leave.kind_annual'), sick: t('leave.kind_sick'), training: t('leave.kind_training'),
  unpaid: t('leave.kind_unpaid'), other: t('leave.kind_other'), away: t('leave.kind_away'),
}[k] || k);
const levelLabel = (n) => [t('common.level_0'), t('common.level_1'), t('common.level_2'), t('common.level_3')][n] ?? String(n);
const roleLabelOf = (r) => (state.locale === 'el' ? r.label_el : r.label_en) || roleLabel(r.role);
const entityCode = (id) => (id == null ? t('access.all_entities') : (entityById(id)?.code || `#${id}`));
const sensitiveModule = (key) => !!state.modules.find(m => m.key === key)?.sensitive;

export default async function person(root, params) {
  const id = Number(params.id);
  const u = await api.get(`/users/${id}`);
  const self = u.id === state.me.id;
  const e = entityById(u.entity_id);
  const d = deptById(u.department_id);
  const canEditCapacity = u.can_edit || self;
  const canEditLeave = u.can_edit || self;
  // Guests see co-members of shared projects only as names: no capacity,
  // leave or workload of staff.
  const limited = state.me.is_external && !self;
  const cleanups = [];
  const staffCards = !u.is_external && !limited;

  const managerSlot = h('span');
  const cards = h('div', { class: 'person-grid' });
  const wide = h('div', { class: 'col gap-16 mt-16' });

  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head person-head' },
      avatar(u.name, u.id, { size: 'lg' }),
      h('div', { class: 'col', style: { gap: '2px', minWidth: 0 } },
        h('h1', null, u.name),
        h('div', { class: 'row wrap gap-4 small muted' },
          u.title ? h('span', null, u.title) : null,
          e ? h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code) : null,
          e ? h('span', { class: 'hide-mobile' }, e.name) : null,
          d ? h('span', null, '· ', deptName(d)) : null,
          u.is_external ? h('span', { class: 'chip warn', title: u.external_org || '' }, t('common.external'), u.external_org ? ` · ${u.external_org}` : '') : null,
          !u.active ? h('span', { class: 'chip danger' }, t('people.inactive')) : null),
        h('div', { class: 'row wrap gap-12 small' },
          u.email ? h('a', { href: `mailto:${u.email}` }, icon('comment', 12), ' ', u.email) : null,
          managerSlot,
          u.last_login_at ? h('span', { class: 'muted', title: fmtDateTime(u.last_login_at) }, t('person.last_seen', { when: timeAgo(u.last_login_at) })) : null)),
      self ? h('a', { class: 'btn right', href: '#/settings' }, icon('gear', 14), t('nav.settings')) : null),
    cards, wide));

  if (u.manager_id && !limited) {
    api.get(`/users/${u.manager_id}`).then(m => mount(managerSlot, h('span', { class: 'muted' }, t('person.manager'), ': '), h('a', { href: `#/people/${m.id}` }, m.name)))
      .catch(() => {});
  }

  // Cards: each loads on its own so one forbidden call never blanks the page.
  cards.append(projectsCard(u));
  if (staffCards) {
    cards.append(capacityCard(u, canEditCapacity));
    const allocSlot = h('div', { class: 'card' });
    const leaveSlot = h('div', { class: 'card' });
    cards.append(allocSlot, leaveSlot);
    allocationsCard(allocSlot, u);
    leaveCard(leaveSlot, u, canEditLeave);

    const wl = h('div');
    const section = h('section', { class: 'card pad', 'aria-labelledby': 'pp-wl' },
      h('div', { class: 'row mb-8' }, h('h2', { id: 'pp-wl' }, t('person.workload_title')), h('a', { class: 'right small', href: '#/workload' }, t('person.full_workload'))),
      wl);
    wide.append(section);
    // The server only returns workload for people your access covers; if
    // this person is not among them, the section goes rather than sit empty.
    import('./workload.js').then(({ workloadGrid }) => workloadGrid(wl, { user_ids: String(u.id), weeks: 4, controls: false, explain: false }))
      .then((c) => { if (typeof c === 'function') cleanups.push(c); if (!wl.querySelector('.wl') && !wl.querySelector('.banner')) section.remove(); })
      .catch(err => mount(wl, h('div', { class: 'banner danger' }, err.message)));
  }

  if (u.can_see_metrics) {
    const slot = h('div');
    wide.append(slot);
    metricsCard(slot, u, self);
  }

  if (can('admin', 2)) wide.append(accessSection(u, self));
  if (self || can('admin', 2)) wide.append(personalDataSection(u, self));
  return () => cleanups.forEach(c => c());
}

// ---- personal data (GDPR): export for the person or admins; erasure for super admins ----

function personalDataSection(u, self) {
  const canErase = can('admin', 3) && !u.active && !self;
  return h('section', { class: 'card pad', 'aria-labelledby': 'pp-data' },
    h('h2', { id: 'pp-data', class: 'mb-8' }, t('person.data_title')),
    h('p', { class: 'muted small' }, self ? t('person.data_hint_self') : t('person.data_hint_admin')),
    h('div', { class: 'row wrap' },
      h('a', { class: 'btn', href: `/api/users/${u.id}/export`, download: `kmop-hq-personal-data-${u.id}.json` }, icon('log', 14), t('person.data_download')),
      canErase ? h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog(t('person.anonymise_confirm', { name: u.name }), { okLabel: t('person.anonymise') })) return;
        try { await api.post(`/users/${u.id}/anonymise`); toast(t('person.anonymised')); location.hash = '#/people'; } catch (e) { showError(e); }
      } }, icon('trash', 14), t('person.anonymise')) : null),
    canErase ? h('p', { class: 'muted xs mt-8' }, t('person.anonymise_hint')) : null);
}

// ---- projects ----------------------------------------------------------------

function projectsCard(u) {
  return h('section', { class: 'card', 'aria-labelledby': 'pp-projects' },
    h('div', { class: 'card-head' }, h('h2', { id: 'pp-projects' }, t('nav.projects')), h('span', { class: 'muted small' }, String(u.projects.length))),
    u.projects.length ? h('ul', { class: 'plain-list' }, u.projects.map(p => {
      const e = entityById(p.entity_id);
      return h('li', { class: 'row' },
        h('a', { class: 'grow ellipsis', href: `#/projects/${p.id}`, title: p.name }, p.code ? `${p.code} — ${p.name}` : p.name),
        e ? h('span', { class: 'chip', title: e.name }, e.code) : null,
        h('span', { class: 'chip outline' }, t('project.role_' + p.role)));
    })) : emptyState(t('person.no_projects'), 'folder'));
}

// ---- capacity ----------------------------------------------------------------

function capacityCard(u, editable) {
  const body = h('div', { class: 'card-body' });
  const card = h('section', { class: 'card', 'aria-labelledby': 'pp-cap' },
    h('div', { class: 'card-head' }, h('h2', { id: 'pp-cap' }, t('person.capacity')),
      editable ? h('button', { class: 'btn ghost sm right', onclick: () => edit() }, icon('log', 12), t('common.edit')) : null),
    body);
  const view = () => mount(body,
    h('dl', { class: 'kv' },
      h('dt', null, t('people.weekly_hours')), h('dd', null, t('person.hours_per_week', { h: u.weekly_hours ?? '—' })),
      h('dt', null, t('people.work_days')), h('dd', null, ISO_DAYS.filter(n => (u.work_days || '').includes(String(n))).map(n => weekdayName(n, 'long')).join(', ') || '—'),
      h('dt', null, t('person.daily_hours')), h('dd', null, u.work_days?.length ? t('person.hours_per_day', { h: Math.round((u.weekly_hours || 0) / u.work_days.length * 10) / 10 }) : '—')),
    h('p', { class: 'muted xs mt-8' }, t('person.capacity_hint')));
  function edit() {
    const hoursId = 'cap-h-' + u.id;
    const boxes = ISO_DAYS.map(n => h('input', { type: 'checkbox', id: `cap-d${n}-${u.id}`, value: String(n), checked: (u.work_days || '').includes(String(n)) }));
    const hoursInput = h('input', { class: 'input', id: hoursId, type: 'number', min: 0, max: 60, step: 0.5, value: u.weekly_hours ?? 40, style: { width: '110px' } });
    const err = h('div', { class: 'error small danger-text', 'aria-live': 'polite' });
    mount(body, h('form', { class: 'col gap-12', onsubmit: async (ev) => {
      ev.preventDefault();
      const work_days = boxes.filter(b => b.checked).map(b => b.value).join('');
      try {
        const r = await api.patch(`/users/${u.id}`, { weekly_hours: Number(hoursInput.value), work_days }, u.updated_at);
        Object.assign(u, r);
        if (u.id === state.me.id) Object.assign(state.me, r);
        toast(t('common.saved'));
        view();
      } catch (e2) { err.textContent = e2.code === 'conflict' ? t('common.conflict') : e2.message; }
    } },
      h('div', { class: 'field' }, h('label', { for: hoursId }, t('people.weekly_hours')), hoursInput),
      h('fieldset', { class: 'plain-fieldset' }, h('legend', { class: 'label' }, t('people.work_days')),
        h('div', { class: 'row wrap gap-12' }, boxes.map((b, i) => h('label', { class: 'checkbox', for: b.id }, b, weekdayName(i + 1))))),
      err,
      h('div', { class: 'row' }, h('button', { class: 'btn primary sm', type: 'submit' }, t('common.save')), h('button', { class: 'btn sm', type: 'button', onclick: view }, t('common.cancel')))));
    hoursInput.focus();
  }
  view();
  return card;
}

// ---- allocations -------------------------------------------------------------

async function allocationsCard(el, u) {
  mount(el, h('div', { class: 'card-head' }, h('h2', null, t('person.allocations'))), spinner());
  let rows;
  try { rows = await listAll('/allocations', { user_id: u.id }); }
  catch (e) { el.remove(); return; }
  const today = todayStr();
  const current = rows.filter(a => a.end_date >= today);
  const totalNow = rows.filter(a => a.start_date <= today && a.end_date >= today).reduce((s, a) => s + (a.fte_pct || 0), 0);
  mount(el,
    h('div', { class: 'card-head' }, h('h2', { id: 'pp-alloc' }, t('person.allocations')),
      h('span', { class: ['chip', 'right', totalNow > 100 ? 'danger' : totalNow ? 'accent' : ''], title: t('person.fte_now_hint') }, t('person.fte_now', { n: totalNow }))),
    current.length ? h('ul', { class: 'plain-list' }, current.map(a => h('li', { class: 'row' },
      h('span', { class: 'chip accent' }, `${a.fte_pct}%`),
      h('a', { class: 'grow ellipsis', href: `#/projects/${a.project_id}/members`, title: a.project_name }, a.project_code || a.project_name),
      h('span', { class: 'muted xs nowrap' }, `${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}`),
      a.person_months ? h('span', { class: 'xs nowrap hide-mobile' }, `${a.person_months} ${t('project.pm_unit')}`) : null)))
      : emptyState(t('person.no_allocations'), 'chart'),
    h('p', { class: 'muted xs card-body', style: { paddingTop: 0 } }, t('person.allocations_hint')));
}

// ---- leave -------------------------------------------------------------------

async function leaveCard(el, u, editable) {
  mount(el, h('div', { class: 'card-head' }, h('h2', null, t('person.leave'))), spinner());
  let rows;
  try { rows = await listAll('/leave', { user_id: u.id, from: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10) }); }
  catch (e) { el.remove(); return; }
  const reload = () => leaveCard(el, u, editable);
  const today = todayStr();
  mount(el,
    h('div', { class: 'card-head' }, h('h2', null, t('person.leave')),
      editable ? h('button', { class: 'btn ghost sm right', onclick: () => leaveDialog(u, null, reload) }, icon('plus', 12), t('leave.add')) : null),
    rows.length ? h('ul', { class: 'plain-list' }, rows.map(l => h('li', { class: ['row', l.end_date < today && 'muted'] },
      icon('calendar', 13),
      h('span', { class: 'grow' }, l.start_date === l.end_date ? fmtDate(l.start_date, { weekday: true }) : `${fmtDate(l.start_date)} – ${fmtDate(l.end_date, { year: true })}`,
        l.half_day ? h('span', { class: 'muted xs' }, ' · ', t('leave.half_day')) : null,
        l.note ? h('span', { class: 'muted xs' }, ' · ', l.note) : null),
      h('span', { class: 'chip' }, leaveKindLabel(l.kind)),
      editable ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('leave.edit'), title: t('leave.edit'), onclick: () => leaveDialog(u, l, reload) }, icon('log', 12)) : null,
      editable ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('leave.delete'), title: t('leave.delete'), onclick: async () => {
        if (!await confirmDialog(t('leave.delete_confirm', { from: fmtDate(l.start_date), to: fmtDate(l.end_date) }))) return;
        try { await api.del(`/leave/${l.id}`); toast(t('common.deleted')); reload(); } catch (err) { showError(err); }
      } }, icon('trash', 12)) : null)))
      : emptyState(t('person.no_leave'), 'calendar'),
    h('p', { class: 'muted xs card-body', style: { paddingTop: 0 } }, u.id === state.me.id || u.can_edit ? t('person.leave_hint_private') : t('person.leave_hint_public')));
}

function leaveDialog(u, l, done) {
  formDialog({
    title: l ? t('leave.edit') : t('leave.add_for', { name: u.name }),
    fields: [
      { name: 'start_date', label: t('common.from'), type: 'date', required: true, value: l?.start_date || todayStr() },
      { name: 'end_date', label: t('common.to'), type: 'date', required: true, value: l?.end_date || l?.start_date || todayStr() },
      { name: 'kind', label: t('leave.kind'), type: 'select', value: l?.kind && l.kind !== 'away' ? l.kind : 'annual', options: LEAVE_KINDS.map(k => ({ value: k, label: leaveKindLabel(k) })) },
      { name: 'half_day', label: t('leave.half_day'), type: 'checkbox', value: !!l?.half_day, hint: t('leave.half_day_hint') },
      { name: 'note', label: t('leave.note'), value: l?.note || '', hint: t('leave.note_hint') },
    ],
    onSubmit: async (v) => {
      const body = { ...v, half_day: !!v.half_day };
      if (l) await api.patch(`/leave/${l.id}`, body, l.updated_at);
      else await api.post('/leave', { ...body, user_id: u.id });
      toast(t('common.saved'));
      done();
    },
  });
}

// ---- evaluation metrics --------------------------------------------------------

const METRICS = () => [
  ['open_tasks', t('metric.open_tasks'), t('metric.def_open_tasks')],
  ['overdue_tasks', t('metric.overdue_tasks'), t('metric.def_overdue_tasks')],
  ['completed_90d', t('metric.completed_90d'), t('metric.def_completed_90d')],
  ['on_time_rate', t('metric.on_time_rate'), t('metric.def_on_time_rate')],
  ['avg_days_in_hand', t('metric.avg_days_in_hand'), t('metric.def_avg_days_in_hand')],
  ['open_avg_age_days', t('metric.open_avg_age_days'), t('metric.def_open_avg_age_days')],
  ['active_projects', t('metric.active_projects'), t('metric.def_active_projects')],
];

async function metricsCard(el, u, self) {
  let m;
  try { m = await api.get(`/people/${u.id}/metrics`); }
  catch (e) { el.remove(); return; } // not allowed after all: show nothing at all
  const fmtVal = (k) => {
    const v = m[k];
    if (v == null) return '—';
    if (k === 'on_time_rate') return `${v}%`;
    if (k === 'avg_days_in_hand' || k === 'open_avg_age_days') return t('metric.n_days', { n: new Intl.NumberFormat(state.locale === 'el' ? 'el-GR' : 'en-GB', { maximumFractionDigits: 1 }).format(v) });
    return String(v);
  };
  const rolesList = (m.visible_to?.roles || []).map(r => (state.locale === 'el' ? r.label_el : r.label_en)).filter(Boolean);
  const selfSees = !!m.visible_to?.self;
  mount(el, h('section', { class: 'card', 'aria-labelledby': 'pp-metrics' },
    h('div', { class: 'card-head', style: { flexWrap: 'wrap' } }, h('h2', { id: 'pp-metrics' }, t('metric.title')), h('span', { class: 'muted small' }, t('metric.window', { n: m.window_days })),
      h('span', { class: 'chip outline right', title: t('metric.restricted_hint') }, icon('lock', 11), t('metric.restricted'))),
    h('div', { class: 'card-body' },
      h('div', { class: 'metrics-grid' }, METRICS().map(([k, label]) => h('div', { class: 'stat' },
        h('span', { class: ['v', k === 'overdue_tasks' && m[k] ? 'danger-text' : ''] }, fmtVal(k)),
        h('span', { class: 'k' }, label),
        k === 'on_time_rate' ? h('span', { class: 'k' }, m.on_time_basis ? t('metric.on_time_basis', { n: m.on_time_basis }) : t('metric.no_basis')) : null))),
      h('details', { class: 'metric-defs mt-16' },
        h('summary', null, t('metric.definitions')),
        h('dl', { class: 'kv' }, METRICS().map(([k, label, def]) => [h('dt', null, label), h('dd', null, state.locale === 'el' ? def : (m.definitions?.[k] || def))]))),
      h('div', { class: 'banner mt-16 small' },
        h('strong', null, t('metric.who_sees')), ' ',
        rolesList.length ? t('metric.roles_list', { roles: rolesList.join(', ') }) : t('metric.roles_none'), ' ',
        self ? (selfSees ? t('metric.self_sees_you') : t('metric.self_hidden_you')) : (selfSees ? t('metric.self_sees', { name: u.name }) : t('metric.self_hidden', { name: u.name }))))));
}

// ---- access (administrators only) ---------------------------------------------

function accessSection(u, self) {
  const roleRows = u.roles.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('common.role')), h('th', { scope: 'col' }, t('access.scope')), h('th', { scope: 'col' }, t('access.valid')), h('th', { scope: 'col', class: 'hide-mobile' }, t('access.granted_by')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('access.actions'))))),
    h('tbody', null, u.roles.map(r => {
      const expired = r.valid_until && r.valid_until < todayStr();
      return h('tr', null,
        h('td', null, roleLabelOf(r)),
        h('td', { class: 'small' }, r.department_id ? `${deptName(deptById(r.department_id)) || '#' + r.department_id}${r.entity_id ? ' · ' + entityCode(r.entity_id) : ''}` : entityCode(r.entity_id)),
        h('td', { class: 'small nowrap' }, r.valid_from || r.valid_until ? `${r.valid_from ? fmtDate(r.valid_from, { year: true }) : '…'} – ${r.valid_until ? fmtDate(r.valid_until, { year: true }) : '…'}` : t('access.no_expiry'),
          expired ? h('span', { class: 'chip danger', style: { marginLeft: '4px' } }, t('access.expired')) : null),
        h('td', { class: 'small muted hide-mobile' }, r.granted_by_name || '—'),
        h('td', null, h('button', { class: 'btn ghost sm', 'aria-label': t('access.revoke_role_label', { role: roleLabelOf(r) }), onclick: async () => {
          if (!await confirmDialog(t('access.revoke_role_confirm', { role: roleLabelOf(r), name: u.name }), { okLabel: t('access.revoke') })) return;
          try { await api.del(`/users/${u.id}/roles/${r.id}`); toast(t('access.revoked')); location.reload(); } catch (e) { showError(e); }
        } }, t('access.revoke'))));
    })))) : h('p', { class: 'muted small' }, t('access.no_roles'));

  const overrides = u.module_access || [];
  const overrideRows = overrides.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('access.module')), h('th', { scope: 'col' }, t('common.entity')), h('th', { scope: 'col' }, t('access.level')), h('th', { scope: 'col', class: 'hide-mobile' }, t('access.reason')), h('th', { scope: 'col' }, t('access.valid')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('access.actions'))))),
    h('tbody', null, overrides.map(o => h('tr', null,
      h('td', null, moduleCell(o.module)),
      h('td', { class: 'small' }, entityCode(o.entity_id)),
      h('td', null, h('span', { class: ['chip', o.level === 0 ? 'danger' : 'accent'] }, levelLabel(o.level))),
      h('td', { class: 'small hide-mobile' }, o.reason || '—', o.granted_by_name ? h('div', { class: 'muted xs' }, o.granted_by_name) : null),
      h('td', { class: 'small nowrap' }, o.valid_until ? t('common.until', { date: fmtDate(o.valid_until, { year: true }) }) : t('access.no_expiry')),
      h('td', null, h('button', { class: 'btn ghost sm', 'aria-label': t('access.revoke_override_label', { module: moduleLabel(o.module) }), onclick: async () => {
        if (!await confirmDialog(t('access.revoke_override_confirm', { module: moduleLabel(o.module), name: u.name }), { okLabel: t('access.revoke') })) return;
        try { await api.del(`/users/${u.id}/module-access/${o.id}`); toast(t('access.revoked')); location.reload(); } catch (e) { showError(e); }
      } }, t('access.revoke')))))))) : h('p', { class: 'muted small' }, t('access.no_overrides'));

  return h('section', { class: 'card pad', 'aria-labelledby': 'pp-access' },
    h('div', { class: 'row mb-8' }, h('h2', { id: 'pp-access' }, icon('shield', 15), ' ', t('access.title')), h('span', { class: 'muted small' }, t('access.admin_only'))),
    h('div', { class: 'row mb-8 mt-16' }, h('h3', null, t('access.roles')), h('button', { class: 'btn sm right', onclick: () => grantRoleDialog(u) }, icon('plus', 12), t('access.grant_role'))),
    roleRows,
    h('div', { class: 'row mb-8 mt-16' }, h('h3', null, t('access.overrides')), h('button', { class: 'btn sm right', onclick: () => grantOverrideDialog(u) }, icon('plus', 12), t('access.grant_override'))),
    h('p', { class: 'muted xs' }, t('access.overrides_hint'), ' ', h('span', { class: 'warn-text' }, icon('alert', 11), ' ', t('access.sensitive_legend'))),
    overrideRows,
    h('h3', { class: 'mt-16 mb-8' }, t('access.sessions')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: async () => {
        if (!await confirmDialog(t('access.revoke_sessions_confirm', { name: u.name }), { okLabel: t('access.revoke_sessions') })) return;
        try { await api.post(`/users/${u.id}/revoke-sessions`); toast(t('access.sessions_revoked')); if (self) location.reload(); } catch (e) { showError(e); }
      } }, icon('key', 14), t('access.revoke_sessions')),
      !self ? h('button', { class: ['btn', u.active ? 'danger' : ''], onclick: async () => {
        const deactivate = !!u.active;
        if (deactivate && !await confirmDialog(t('access.deactivate_confirm', { name: u.name }), { okLabel: t('access.deactivate') })) return;
        try { await api.patch(`/users/${u.id}`, { active: !deactivate }, u.updated_at); toast(deactivate ? t('access.deactivated') : t('access.reactivated')); location.reload(); } catch (e) { showError(e); }
      } }, icon(u.active ? 'lock' : 'check', 14), u.active ? t('access.deactivate') : t('access.reactivate')) : null),
    h('p', { class: 'muted xs mt-8' }, t('access.audit_note')));
}

function moduleCell(key) {
  return h('span', { class: 'row gap-4' }, moduleLabel(key), sensitiveModule(key) ? h('span', { class: 'warn-text', title: t('access.sensitive'), 'aria-label': t('access.sensitive') }, icon('alert', 12)) : null);
}

function grantRoleDialog(u) {
  const needsExpiry = state.roles.filter(r => r.requires_expiry).map(r => state.locale === 'el' ? r.label_el : r.label_en);
  formDialog({
    title: t('access.grant_role_for', { name: u.name }),
    intro: h('p', { class: 'muted small' }, t('access.grant_role_intro'), needsExpiry.length ? [' ', t('access.requires_expiry', { roles: needsExpiry.join(', ') })] : null),
    fields: [
      { name: 'role', label: t('common.role'), type: 'select', required: true, options: state.roles.map(r => ({ value: r.key, label: (state.locale === 'el' ? r.label_el : r.label_en) + (r.requires_expiry ? ` (${t('access.needs_end_date')})` : '') })) },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: '', options: [{ value: '', label: t('access.all_entities') }, ...state.entities.map(e => ({ value: e.id, label: e.name }))] },
      { name: 'department_id', label: t('common.department'), type: 'select', numeric: true, value: '', options: [{ value: '', label: t('access.whole_scope') }, ...state.departments.map(d => ({ value: d.id, label: deptName(d) }))], hint: t('access.department_hint') },
      { name: 'valid_from', label: t('access.valid_from'), type: 'date' },
      { name: 'valid_until', label: t('access.valid_until'), type: 'date', hint: t('access.valid_until_hint') },
    ],
    submitLabel: t('access.grant'),
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));
      await api.post(`/users/${u.id}/roles`, body);
      toast(t('access.granted'));
      location.reload();
    },
  });
}

function grantOverrideDialog(u) {
  formDialog({
    title: t('access.grant_override_for', { name: u.name }),
    intro: h('p', { class: 'muted small' }, t('access.overrides_hint')),
    fields: [
      { name: 'module', label: t('access.module'), type: 'select', required: true, options: state.modules.map(m => ({ value: m.key, label: (m.sensitive ? '⚠ ' : '') + moduleLabel(m.key) + (m.sensitive ? ` — ${t('access.sensitive')}` : '') })) },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: '', options: [{ value: '', label: t('access.all_entities') }, ...state.entities.map(e => ({ value: e.id, label: e.name }))] },
      { name: 'level', label: t('access.level'), type: 'select', numeric: true, required: true, value: 1, options: [0, 1, 2, 3].map(n => ({ value: n, label: `${n} — ${levelLabel(n)}` })) },
      { name: 'reason', label: t('access.reason'), required: true, hint: t('access.reason_hint') },
      { name: 'valid_until', label: t('access.valid_until'), type: 'date' },
    ],
    submitLabel: t('access.grant'),
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));
      await api.post(`/users/${u.id}/module-access`, body);
      toast(t('access.granted'));
      location.reload();
    },
  });
}
