// People: the directory of everyone the viewer's 'people' access covers
// (plus co-members of shared projects). Entity is always shown: the three
// KMOP entities are separate employers, not one organisation.

import { h, mount, icon, debounce } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, can, local, entityById, deptById, deptName, roleLabel } from '../lib/state.js';
import { formDialog, toast, avatar, emptyState, spinner, timeAgo, fmtDateTime, showCredentials } from '../lib/ui.js';

export const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7];
// ISO weekday (1 = Monday) → short or long localised name.
export function weekdayName(n, style = 'short') {
  const d = new Date(2024, 0, n); // 1 Jan 2024 was a Monday
  return new Intl.DateTimeFormat(state.locale === 'el' ? 'el-GR' : 'en-GB', { weekday: style }).format(d);
}
export const workDaysText = (wd) => (wd || '').split('').map(Number).filter(n => n >= 1 && n <= 7).sort().map(n => weekdayName(n)).join(', ') || '—';

export default async function people(root) {
  const f = local.get('people.filters', { q: '', entity: '', dept: '', external: '' });
  const bar = h('div', { class: 'filterbar' });
  const table = h('div');
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.people')),
      can('admin', 2) ? h('button', { class: 'btn primary right', onclick: () => addPersonDialog() }, icon('plus', 14), t('people.add')) : null),
    bar, table));

  const save = () => { local.set('people.filters', f); renderBar(); load(); };
  const renderBar = () => mount(bar,
    h('input', { class: 'input sm', type: 'search', placeholder: t('people.search_placeholder'), 'aria-label': t('common.search'), value: f.q || '',
      oninput: debounce((e) => { f.q = e.target.value; local.set('people.filters', f); load(); }, 300) }),
    h('div', { class: 'seg', role: 'group', 'aria-label': t('common.entity') },
      [{ id: '', code: t('common.all') }, ...state.entities].map(e => h('button', { class: 'btn sm', title: e.name || '', 'aria-pressed': String(String(f.entity || '') === String(e.id)), onclick: () => { f.entity = e.id || ''; save(); } }, e.code))),
    h('select', { class: 'input sm', 'aria-label': t('common.department'), onchange: (e) => { f.dept = e.target.value; save(); } },
      h('option', { value: '' }, t('people.all_departments')),
      state.departments.map(d => h('option', { value: d.id, selected: String(f.dept) === String(d.id) }, deptName(d)))),
    h('select', { class: 'input sm', 'aria-label': t('people.who'), onchange: (e) => { f.external = e.target.value; save(); } },
      [['', t('people.staff_and_external')], ['0', t('people.staff_only')], ['1', t('people.external_only')]].map(([v, l]) => h('option', { value: v, selected: f.external === v }, l))),
    can('admin', 2) ? h('label', { class: 'checkbox small right' }, h('input', { type: 'checkbox', checked: !!f.inactive, onchange: (e) => { f.inactive = e.target.checked; save(); } }), t('people.show_inactive')) : null);

  async function load() {
    mount(table, spinner());
    try {
      const r = await api.list('/users', { q: f.q || null, entity_id: f.entity || null, department_id: f.dept || null, external: f.external || null, active: f.inactive && can('admin', 2) ? 'all' : null, limit: 500, sort: f.sort || 'name' });
      if (!r.data.length) { mount(table, h('div', { class: 'card' }, emptyState(t('people.none'), 'people'))); return; }
      const sortTh = (k, l, cls) => h('th', { scope: 'col', class: cls, 'aria-sort': f.sort === k ? 'ascending' : f.sort === '-' + k ? 'descending' : null },
        k ? h('button', { class: 'sort', onclick: () => { f.sort = f.sort === k ? '-' + k : k; save(); } }, l, f.sort === k ? ' ↑' : f.sort === '-' + k ? ' ↓' : '') : l);
      mount(table, h('div', { class: 'table-wrap' }, h('table', { class: 'table people-table' },
        h('caption', { class: 'sr-only' }, t('nav.people')),
        h('thead', null, h('tr', null,
          sortTh('name', t('common.name')), sortTh(null, t('common.title'), 'hide-mobile'), sortTh('entity', t('common.entity')), sortTh('department', t('common.department'), 'hide-mobile'),
          sortTh(null, t('people.roles'), 'hide-mobile'), sortTh(null, t('people.capacity'), 'hide-mobile'), sortTh('last_login', t('people.last_login'), 'hide-mobile'))),
        h('tbody', null, r.data.map(u => {
          const e = entityById(u.entity_id);
          const d = deptById(u.department_id);
          const roles = [...new Set(u.roles || [])];
          return h('tr', { class: !u.active ? 'muted' : null },
            h('td', null, h('div', { class: 'row' }, avatar(u.name, u.id),
              h('div', { class: 'col', style: { gap: '1px', minWidth: 0 } },
                h('a', { href: `#/people/${u.id}`, class: 'ellipsis', style: { fontWeight: 600 } }, u.name),
                h('span', { class: 'muted xs ellipsis' }, u.is_external ? [t('common.external'), u.external_org].filter(Boolean).join(' · ') : u.email),
                h('span', { class: 'muted xs ellipsis show-mobile' }, u.title || '')))),
            h('td', { class: 'small hide-mobile' }, u.title || '—'),
            h('td', null, e ? h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code) : h('span', { class: 'muted' }, '—')),
            h('td', { class: 'small hide-mobile' }, d ? deptName(d) : (u.department_name || '—')),
            h('td', { class: 'hide-mobile' }, h('div', { class: 'row wrap gap-4' }, roles.map(k => h('span', { class: 'chip' }, roleLabel(k))), !u.active ? h('span', { class: 'chip warn' }, t('people.inactive')) : null)),
            h('td', { class: 'small nowrap hide-mobile' }, u.is_external ? '—' : t('people.hours_days', { h: u.weekly_hours ?? '—', d: workDaysText(u.work_days) })),
            h('td', { class: 'small muted nowrap hide-mobile', title: u.last_login_at ? fmtDateTime(u.last_login_at) : '' }, u.last_login_at ? timeAgo(u.last_login_at) : t('people.never')));
        })))),
        r.meta.total > r.data.length ? h('div', { class: 'muted small mt-8' }, t('coll.truncated', { n: r.data.length, total: r.meta.total })) : h('div', { class: 'muted small mt-8' }, t('people.count', { n: r.meta.total })));
    } catch (e) { mount(table, h('div', { class: 'banner danger' }, e.message || t('common.error'))); }
  }
  renderBar();
  load();
}

export function addPersonDialog() {
  formDialog({
    title: t('people.add'),
    submitLabel: t('people.add_submit'),
    wide: true,
    intro: h('p', { class: 'muted small' }, t('people.add_intro')),
    fields: [
      { name: 'email', label: t('common.email'), type: 'email', required: true, placeholder: 'name@kmop.org' },
      { name: 'name', label: t('common.name'), required: true },
      { name: 'title', label: t('people.job_title') },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: state.me.entity_id || '', options: [{ value: '', label: '—' }, ...state.entities.map(e => ({ value: e.id, label: e.name }))], hint: t('people.entity_hint') },
      { name: 'department_id', label: t('common.department'), type: 'select', numeric: true, options: [{ value: '', label: '—' }, ...state.departments.map(d => ({ value: d.id, label: deptName(d) }))] },
      { name: 'role', label: t('common.role'), type: 'select', value: '', options: [{ value: '', label: t('people.role_default') }, ...state.roles.map(r => ({ value: r.key, label: state.locale === 'el' ? r.label_el : r.label_en }))], hint: t('people.role_hint') },
      { name: 'is_external', label: t('people.is_external'), type: 'checkbox', hint: t('people.is_external_hint') },
      { name: 'external_org', label: t('people.external_org') },
      { name: 'weekly_hours', label: t('people.weekly_hours'), type: 'number', min: 0, max: 60, step: 0.5, value: 40 },
      { name: 'work_days', label: t('people.work_days'), value: '12345', hint: t('people.work_days_hint') },
      { name: 'locale', label: t('settings.language'), type: 'select', value: 'el', options: [{ value: 'el', label: 'Ελληνικά' }, { value: 'en', label: 'English' }] },
    ],
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));
      body.is_external = !!v.is_external;
      if (!body.is_external) delete body.external_org;
      const u = await api.post('/users', body);
      if (u.temporary_password) showCredentials({ name: u.name, email: u.email, password: u.temporary_password });
      toast(t('people.added', { name: u.name }));
      location.hash = `#/people/${u.id}`;
    },
  });
}
