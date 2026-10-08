// The audit log, readable by humans: who did what, when, in which entity and
// project — the summary sentence is the main column; each row expands to the
// field-by-field before → after. Filters live in the URL so a filtered view
// can be shared with an auditor; "Export CSV" downloads the same selection.

import { h, mount, icon, debounce } from '../lib/dom.js';
import { api, listAll } from '../lib/api.js';
import { state, t, can, entityById, projectRole } from '../lib/state.js';
import { avatar, fmtDateTime, timeAgo, emptyState, spinner, errorText } from '../lib/ui.js';

const ACTIONS = ['create', 'update', 'delete', 'restore', 'grant', 'revoke', 'login', 'export', 'purge', 'anonymise'];
const actionLabel = (a) => ({
  create: t('audit.action_create'), update: t('audit.action_update'), delete: t('audit.action_delete'), restore: t('audit.action_restore'),
  grant: t('audit.action_grant'), revoke: t('audit.action_revoke'), login: t('audit.action_login'), export: t('audit.action_export'), purge: t('audit.action_purge'), anonymise: t('audit.action_anonymise'),
})[a] || a;
const ACTION_CLASS = { create: 'ok', restore: 'ok', update: 'accent', delete: 'danger', purge: 'danger', anonymise: 'danger', grant: 'warn', revoke: 'warn' };

const TYPES = ['task', 'project', 'project_member', 'comment', 'attachment', 'allocation', 'leave', 'section', 'label', 'custom_field', 'checklist_item',
  'dependency', 'project_template', 'task_template', 'user', 'role', 'entity', 'holiday', 'department', 'setting', 'audit_log', 'retention'];
const typeLabel = (k) => ({
  task: t('audit.type_task'), project: t('audit.type_project'), project_member: t('audit.type_project_member'), comment: t('audit.type_comment'),
  attachment: t('audit.type_attachment'), allocation: t('audit.type_allocation'), leave: t('audit.type_leave'), section: t('audit.type_section'),
  label: t('audit.type_label'), custom_field: t('audit.type_custom_field'), checklist_item: t('audit.type_checklist_item'), dependency: t('audit.type_dependency'),
  project_template: t('audit.type_project_template'), task_template: t('audit.type_task_template'), user: t('audit.type_user'), role: t('audit.type_role'),
  entity: t('audit.type_entity'), holiday: t('audit.type_holiday'), department: t('audit.type_department'), setting: t('audit.type_setting'),
  audit_log: t('audit.type_audit_log'), retention: t('audit.type_retention'),
})[k] || k;

const FILTER_KEYS = ['q', 'actor_id', 'action', 'object_type', 'object_id', 'entity_id', 'project_id', 'from', 'to'];
const LONG = 140;

export default async function auditView(root, params, query = {}) {
  const f = Object.fromEntries(FILTER_KEYS.map(k => [k, query[k] || '']));
  const page = h('div', { class: 'page wide' });
  mount(root, page);
  const head = h('div', { class: 'page-head' }, h('h1', null, t('nav.audit')));

  // Without the audit module only a project's managers may read its trail
  // (PMs, or project write access in scope); the server has the last word.
  if (!can('audit', 1) && (!f.project_id || (projectRole(Number(f.project_id)) !== 'pm' && !can('projects', 2)))) {
    mount(page, head, h('div', { class: 'card pad col gap-8', style: { maxWidth: '640px' } },
      h('div', { class: 'row' }, icon('lock', 18), h('h2', null, t('audit.no_access_title'))),
      h('p', { class: 'muted', style: { margin: 0 } }, t('audit.no_access'))));
    return;
  }

  let people = [];
  try { people = await listAll('/users', { active: 'all', sort: 'name' }); } catch { /* the person filter is optional */ }
  let projectName = '';
  if (f.project_id) { try { const p = await api.get(`/projects/${f.project_id}`); projectName = p.code ? `${p.code} — ${p.name}` : p.name; } catch { /* the row data names it too */ } }

  const exportBtn = h('a', { class: 'btn sm right', download: '', title: t('audit.export_hint') }, t('common.export_csv'));
  head.append(exportBtn);
  const bar = h('div', { class: 'filterbar adm-auditbar' });
  const presets = h('div', { class: 'row wrap gap-4' });
  const summary = h('div', { class: 'muted small mb-8' });
  const tbody = h('tbody');
  const tableWrap = h('div', { class: 'table-wrap' }, h('table', { class: 'table audit-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('audit.details'))),
      h('th', { scope: 'col' }, t('audit.when')), h('th', { scope: 'col' }, t('audit.who')), h('th', { scope: 'col' }, t('audit.action')),
      h('th', { scope: 'col' }, t('audit.what')), h('th', { scope: 'col', class: 'hide-mobile' }, t('common.entity')), h('th', { scope: 'col', class: 'hide-mobile' }, t('task.project')))),
    tbody));
  const body = h('div', null, tableWrap);
  const more = h('button', { class: 'btn sm mt-8 hidden', onclick: () => load(false) }, t('common.load_more'));
  mount(page, head, bar, presets, summary, body, more);

  const qs = () => {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
    return p.toString();
  };
  const sync = () => {
    const s = qs();
    history.replaceState(null, '', '#/audit' + (s ? '?' + s : ''));
    exportBtn.href = '/api/audit/export' + (s ? '?' + s : '');
  };
  const set = (k, v) => { f[k] = v || ''; sync(); renderPresets(); load(true); };

  // ---- filter bar ----
  const fid = (k) => 'audit-f-' + k;
  const labelled = (k, label, input) => [h('label', { class: 'sr-only', for: fid(k) }, label), input];
  const sel = (k, label, opts) => labelled(k, label, h('select', { class: 'input sm', id: fid(k), onchange: (e) => set(k, e.target.value) },
    h('option', { value: '' }, label), opts.map(([v, l]) => h('option', { value: v, selected: String(f[k]) === String(v) }, l))));
  const dateInput = (k, label) => h('span', { class: 'row gap-4' }, h('label', { class: 'small muted', for: fid(k) }, label),
    h('input', { class: 'input sm', type: 'date', id: fid(k), value: f[k], onchange: (e) => set(k, e.target.value) }));

  const renderBar = () => mount(bar,
    labelled('q', t('common.search'), h('input', { class: 'input sm', type: 'search', id: fid('q'), placeholder: t('audit.search'), value: f.q, style: { minWidth: '200px' },
      oninput: debounce((e) => set('q', e.target.value.trim()), 300) })),
    people.length ? sel('actor_id', t('audit.anyone'), people.map(u => [u.id, u.name])) : null,
    sel('action', t('audit.any_action'), ACTIONS.map(a => [a, actionLabel(a)])),
    sel('object_type', t('audit.any_type'), TYPES.map(k => [k, typeLabel(k)]).sort((a, b) => a[1].localeCompare(b[1]))),
    sel('entity_id', t('audit.any_entity'), state.entities.map(e => [e.id, e.code])),
    h('span', { class: 'row wrap gap-4' }, dateInput('from', t('common.from')), dateInput('to', t('common.to'))),
    FILTER_KEYS.some(k => f[k]) ? h('button', { class: 'btn ghost sm', onclick: () => { for (const k of FILTER_KEYS) f[k] = ''; sync(); renderBar(); renderPresets(); load(true); } }, icon('x', 12), t('common.clear')) : null);

  // project / object presets have no control in the bar: show them as removable chips
  const renderPresets = () => mount(presets,
    f.project_id ? h('span', { class: 'chip accent mb-8 audit-preset' }, t('audit.preset_project', { name: projectName || '#' + f.project_id }),
      can('audit', 1) ? h('button', { 'aria-label': t('common.remove'), onclick: () => set('project_id', '') }, '×') : null) : null,
    f.object_id ? h('span', { class: 'chip accent mb-8 audit-preset' }, t('audit.preset_object', { type: f.object_type ? typeLabel(f.object_type) : '', id: f.object_id }),
      h('button', { 'aria-label': t('common.remove'), onclick: () => set('object_id', '') }, '×')) : null);

  // ---- rows ----
  let offset = 0, seq = 0;
  async function load(reset) {
    const my = ++seq;
    if (reset) { offset = 0; mount(tbody); mount(body, h('div', { class: 'card' }, spinner())); }
    try {
      const r = await api.list('/audit', { ...Object.fromEntries(FILTER_KEYS.map(k => [k, f[k]])), limit: 100, offset });
      if (my !== seq) return;
      if (reset) mount(body, tableWrap);
      if (f.project_id && !projectName) { const p = r.data.find(x => x.project_name); if (p) { projectName = p.project_name; renderPresets(); } }
      for (const a of r.data) tbody.append(...auditRows(a));
      if (reset && !r.data.length) mount(body, h('div', { class: 'card' }, emptyState(FILTER_KEYS.some(k => f[k]) ? t('audit.no_match') : t('audit.empty'), 'log')));
      summary.textContent = r.meta.total ? t('audit.showing', { n: offset + r.data.length, total: r.meta.total }) : '';
      offset = r.meta.next_offset ?? offset;
      more.classList.toggle('hidden', r.meta.next_offset == null);
    } catch (e) {
      if (my !== seq) return;
      mount(body, h('div', { class: 'banner danger' }, e.status === 403 ? (e.message || t('common.forbidden')) : errorText(e)));
      more.classList.add('hidden');
    }
  }

  sync(); renderBar(); renderPresets();
  await load(true);
}

function auditRows(a) {
  const hasChanges = a.changes && typeof a.changes === 'object' && Object.keys(a.changes).length;
  const detail = h('tr', { class: 'audit-detail hidden' }, h('td', { colspan: 7 }, detailBody(a, hasChanges)));
  const toggleBtn = h('button', { class: 'btn ghost sm icon-only', 'aria-expanded': 'false', 'aria-label': t('audit.show_details'), onclick: (e) => { e.stopPropagation(); toggle(); } }, icon('chevronRight', 14));
  const toggle = () => {
    const open = detail.classList.toggle('hidden') === false;
    toggleBtn.setAttribute('aria-expanded', String(open));
    toggleBtn.replaceChildren(icon(open ? 'chevronDown' : 'chevronRight', 14));
    row.classList.toggle('open', open);
  };
  const e = a.entity_id ? entityById(a.entity_id) : null;
  const row = h('tr', { class: 'audit-row', tabindex: 0, onclick: (ev) => { if (!ev.target.closest('a,button')) toggle(); },
    onkeydown: (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === row) { ev.preventDefault(); toggle(); } } },
    h('td', { class: 'audit-toggle' }, toggleBtn),
    h('td', { class: 'nowrap small' }, h('div', null, fmtDateTime(a.at)), h('div', { class: 'muted xs' }, timeAgo(a.at))),
    h('td', { class: 'small' }, a.actor_id
      ? h('span', { class: 'row gap-4 nowrap' }, avatar(a.actor_name, a.actor_id), h('a', { href: `#/people/${a.actor_id}` }, a.actor_name || t('common.someone')))
      : h('span', { class: 'row gap-4 muted nowrap' }, h('span', { class: 'avatar empty' }, icon('gear', 12)), t('audit.system'))),
    h('td', null, h('span', { class: ['chip', ACTION_CLASS[a.action]] }, actionLabel(a.action))),
    h('td', { class: 'audit-summary' }, a.summary,
      hasChanges ? h('span', { class: 'muted xs' }, ' · ', t('audit.n_fields', { n: Object.keys(a.changes).length })) : null,
      h('div', { class: 'muted xs audit-mobile-meta' }, [e?.code, a.project_name].filter(Boolean).join(' · '))),
    h('td', { class: 'hide-mobile' }, e ? h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code) : a.entity_code ? h('span', { class: 'chip' }, a.entity_code) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'small hide-mobile' }, a.project_id ? h('a', { href: `#/projects/${a.project_id}`, class: 'audit-project' }, a.project_name || '#' + a.project_id) : h('span', { class: 'muted' }, '—')));
  return [row, detail];
}

function detailBody(a, hasChanges) {
  const meta = h('dl', { class: 'audit-meta' },
    h('dt', null, t('audit.object')), h('dd', null, typeLabel(a.object_type), a.object_id ? ` #${a.object_id}` : '', a.object_label ? ` — ${a.object_label}` : '',
      a.object_type === 'task' && a.object_id && a.action !== 'delete' ? [' ', h('a', { href: `#/tasks/${a.object_id}` }, t('common.open'))] : null,
      a.object_type === 'project' && a.object_id ? [' ', h('a', { href: `#/projects/${a.object_id}` }, t('common.open'))] : null),
    h('dt', null, t('audit.exact_time')), h('dd', { class: 'mono' }, a.at),
    a.ip ? [h('dt', null, t('audit.ip')), h('dd', { class: 'mono' }, a.ip)] : null,
    a.request_id ? [h('dt', null, t('audit.request')), h('dd', { class: 'mono' }, a.request_id)] : null);
  if (!hasChanges) return h('div', { class: 'audit-detail-body' }, meta, h('p', { class: 'muted small', style: { margin: 0 } }, t('audit.no_changes')));
  return h('div', { class: 'audit-detail-body' }, meta,
    h('table', { class: 'table audit-diff' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('audit.field')), h('th', { scope: 'col' }, t('audit.before')), h('th', { scope: 'col', 'aria-hidden': 'true' }), h('th', { scope: 'col' }, t('audit.after')))),
      h('tbody', null, Object.entries(a.changes).map(([field, pair]) => {
        const [before, after] = Array.isArray(pair) && pair.length === 2 ? pair : [undefined, pair];
        return h('tr', null, h('th', { scope: 'row', class: 'mono' }, field), h('td', { class: 'audit-before' }, val(before)), h('td', { class: 'muted', 'aria-hidden': 'true' }, '→'), h('td', { class: 'audit-after' }, val(after)));
      }))));
}

function val(v) {
  if (v === null || v === undefined || v === '') return h('span', { class: 'muted' }, t('audit.empty_value'));
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length <= LONG) return h('span', { class: 'audit-val' }, s);
  const text = h('span', { class: 'audit-val' }, s.slice(0, LONG) + '…');
  let open = false;
  const btn = h('button', { class: 'btn ghost sm', 'aria-expanded': 'false', onclick: () => {
    open = !open; text.textContent = open ? s : s.slice(0, LONG) + '…';
    btn.textContent = open ? t('audit.show_less') : t('audit.show_all'); btn.setAttribute('aria-expanded', String(open));
  } }, t('audit.show_all'));
  return h('span', null, text, ' ', btn);
}
