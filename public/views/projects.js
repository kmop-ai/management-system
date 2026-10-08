// Projects: every project the person can see, across the three entities.
// The entity is always shown — nothing here pretends the entities are one.

import { h, mount, icon, debounce, todayStr, projectMonth } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, can, local, entityById, deptName, emit } from '../lib/state.js';
import { formDialog, emptyState, fmtDate, timeAgo, spinner, toast } from '../lib/ui.js';

const STATUSES = ['planning', 'active', 'on_hold', 'closing', 'closed'];

export default async function projects(root) {
  const f = local.get('projects.filters', { scope: 'all', status: 'planning,active,on_hold,closing' });
  const table = h('div');
  const bar = h('div', { class: 'filterbar' });
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.projects')),
      can('project_create', 2) ? h('button', { class: 'btn primary right', onclick: () => newProjectDialog() }, icon('plus', 14), t('project.new')) : null),
    bar, table));

  const renderBar = () => mount(bar,
    h('div', { class: 'seg' }, ['all', 'mine'].map(s => h('button', { class: 'btn sm', 'aria-pressed': String(f.scope === s), onclick: () => { f.scope = s; save(); } }, t('project.scope_' + s)))),
    h('span', { class: 'sep' }),
    h('div', { class: 'seg' }, [{ id: '', code: t('common.all') }, ...state.entities].map(e => h('button', { class: 'btn sm', 'aria-pressed': String(String(f.entity || '') === String(e.id)), title: e.name || '', onclick: () => { f.entity = e.id || ''; save(); } }, e.code))),
    h('select', { class: 'input sm', 'aria-label': t('common.status'), onchange: (e) => { f.status = e.target.value; save(); } },
      [['planning,active,on_hold,closing', t('project.status_current')], ['', t('common.all')], ...STATUSES.map(s => [s, t('project.status_' + s)])].map(([v, l]) => h('option', { value: v, selected: f.status === v }, l))),
    h('input', { class: 'input sm', type: 'search', placeholder: t('common.search'), value: f.q || '', 'aria-label': t('common.search'), oninput: debounce((e) => { f.q = e.target.value; save(); }, 300) }),
    h('label', { class: 'checkbox small right' }, h('input', { type: 'checkbox', checked: f.archived === '1', onchange: (e) => { f.archived = e.target.checked ? '1' : ''; save(); } }), t('project.show_archived')));

  const save = () => { local.set('projects.filters', f); renderBar(); load(); };

  async function load() {
    mount(table, spinner());
    try {
      const r = await api.list('/projects', { member: f.scope === 'mine' ? 'me' : null, entity_id: f.entity || null, status: f.status || null, q: f.q || null, archived: f.archived || null, limit: 200, sort: f.sort || 'name' });
      if (!r.data.length) { mount(table, h('div', { class: 'card' }, emptyState(t('project.none'), 'folder'))); return; }
      const today = todayStr();
      mount(table, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, ...[['name', t('common.name')], ['entity', t('common.entity')], [null, t('project.pms')], ['status', t('common.status')], ['start', t('project.period')], [null, t('project.month')], ['overdue', t('project.tasks')], ['activity', t('project.last_activity')]]
          .map(([k, l]) => h('th', { scope: 'col', class: ['overdue'].includes(k) ? 'num' : '' }, k ? h('button', { class: 'sort', onclick: () => { f.sort = f.sort === k ? '-' + k : k; save(); } }, l, f.sort === k ? ' ↑' : f.sort === '-' + k ? ' ↓' : '') : l)))),
        h('tbody', null, r.data.map(p => {
          const e = entityById(p.entity_id);
          const total = p.start_date && p.end_date ? projectMonth(p.start_date, p.end_date) : null;
          const cur = p.start_date ? projectMonth(p.start_date, today) : null;
          return h('tr', null,
            h('td', null, h('div', { class: 'row' }, h('span', { style: { width: '10px', height: '10px', borderRadius: '3px', background: p.color || 'var(--text-3)', flex: 'none' } }),
              h('div', { class: 'col gap-4', style: { minWidth: 0 } }, h('a', { href: `#/projects/${p.id}`, class: 'ellipsis', style: { fontWeight: 600 } }, p.code ? `${p.code} — ${p.name}` : p.name),
                h('span', { class: 'muted xs ellipsis' }, [p.funder, p.our_role ? t('project.our_role') + ': ' + p.our_role : null].filter(Boolean).join(' · '))))),
            h('td', null, h('span', { class: 'chip', title: e?.name, style: { background: (e?.color || '#888') + '22', color: e?.color } }, e?.code || '—')),
            h('td', { class: 'small' }, p.pm_names || '—'),
            h('td', null, h('span', { class: ['chip', p.status === 'active' ? 'ok' : p.status === 'on_hold' ? 'warn' : ''] }, t('project.status_' + p.status)), p.archived_at ? h('span', { class: 'chip outline', style: { marginLeft: '4px' } }, t('project.archived')) : null),
            h('td', { class: 'small nowrap' }, p.start_date ? `${fmtDate(p.start_date)} – ${p.end_date ? fmtDate(p.end_date) : '…'}` : '—'),
            h('td', { class: 'small nowrap' }, cur && cur > 0 && (!total || cur <= total) ? `M${cur}${total ? ' / ' + total : ''}` : cur > total ? t('project.ended') : '—'),
            h('td', { class: 'num small nowrap' }, `${p.open_tasks}`, p.overdue_tasks ? h('span', { class: 'danger-text' }, ` · ${p.overdue_tasks} ${t('project.overdue_short')}`) : null),
            h('td', { class: 'small muted nowrap' }, p.last_activity_at ? timeAgo(p.last_activity_at) : '—'));
        })))),
        r.meta.total > r.data.length ? h('div', { class: 'muted small mt-8' }, t('coll.truncated', { n: r.data.length, total: r.meta.total })) : null);
    } catch (e) { mount(table, h('div', { class: 'banner danger' }, e.message)); }
  }
  renderBar();
  load();
}

export async function newProjectDialog(defaults = {}) {
  let templates = [];
  try { templates = (await api.list('/templates/projects', { limit: 100 })).data; } catch {}
  formDialog({
    title: t('project.new'),
    submitLabel: t('common.create'),
    wide: true,
    fields: [
      { name: 'name', label: t('common.name'), required: true, value: defaults.name || '' },
      { name: 'code', label: t('project.code'), hint: t('project.code_hint') },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, required: true, value: defaults.entity_id || state.me.entity_id || '', options: state.entities.map(e => ({ value: e.id, label: e.name })), hint: t('project.entity_hint') },
      { name: 'department_id', label: t('common.department'), type: 'select', numeric: true, options: [{ value: '', label: '—' }, ...state.departments.map(d => ({ value: d.id, label: deptName(d) }))] },
      { name: 'kind', label: t('project.kind'), type: 'select', value: 'eu', options: ['eu', 'national', 'internal', 'other'].map(k => ({ value: k, label: t('project.kind_' + k) })) },
      { name: 'funder', label: t('project.funder'), placeholder: 'Erasmus+ KA220-ADU, CERV-2025-DAPHNE, ΕΣΠΑ 2021–27…' },
      { name: 'our_role', label: t('project.our_role'), type: 'select', options: [{ value: '', label: '—' }, ...['coordinator', 'partner', 'sole beneficiary', 'contractor'].map(r => ({ value: r, label: t('project.role_' + r.replace(' ', '_')) }))] },
      { name: 'start_date', label: t('project.start'), type: 'date', hint: t('project.start_hint') },
      { name: 'end_date', label: t('project.end'), type: 'date' },
      { name: 'template_id', label: t('project.template'), type: 'select', numeric: true, options: [{ value: '', label: t('project.no_template') }, ...templates.map(x => ({ value: x.id, label: x.name }))], value: defaults.template_id || '' },
      { name: 'visibility', label: t('project.visibility'), type: 'select', value: 'members', options: [{ value: 'members', label: t('project.visibility_members') }, { value: 'entity', label: t('project.visibility_entity') }] },
    ],
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));
      const p = await api.post('/projects', body);
      emit('projects:changed');
      toast(t('project.created'));
      location.hash = `#/projects/${p.id}`;
    },
  });
}
