// One project: header, then tabs — Tasks (list/board/timeline/calendar),
// Workload, Members & allocations, Files, Activity, Settings.

import { h, mount, icon, todayStr, projectMonth } from '../lib/dom.js';
import { api, listAll } from '../lib/api.js';
import { state, t, can, entityById, deptName, emit } from '../lib/state.js';
import { formDialog, confirmDialog, showError, toast, openMenu, avatar, fmtDate, fmtDateTime, timeAgo, emptyState, labelChip } from '../lib/ui.js';
import { taskCollection } from '../lib/collection.js';
import { getProject, invalidateProject } from '../lib/task-drawer.js';
import { md } from '../lib/markdown.js';

const TABS = ['tasks', 'workload', 'members', 'files', 'activity', 'settings'];

export default async function projectView(root, params) {
  const id = Number(params.id);
  const tab = TABS.includes(params.tab) ? params.tab : 'tasks';
  invalidateProject(id);
  const p = await getProject(id, true);
  const today = todayStr();
  const e = entityById(p.entity_id);
  const total = p.start_date && p.end_date ? projectMonth(p.start_date, p.end_date) : null;
  const cur = p.start_date ? projectMonth(p.start_date, today) : null;
  const pms = p.members.filter(m => m.role === 'pm');
  const tabs = TABS.filter(x => (x !== 'settings' || p.access.manage) && (x !== 'workload' || !(p.access.guest || state.me.is_external)));

  const content = h('div');
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' },
      h('span', { style: { width: '14px', height: '14px', borderRadius: '4px', background: p.color || 'var(--text-3)' } }),
      h('h1', null, p.code ? `${p.code} — ${p.name}` : p.name),
      h('span', { class: 'chip', title: e?.name, style: { background: (e?.color || '#888') + '22', color: e?.color } }, e?.code),
      h('span', { class: ['chip', p.status === 'active' ? 'ok' : ''] }, t('project.status_' + p.status)),
      p.archived_at ? h('span', { class: 'chip warn' }, t('project.archived')) : null,
      cur && total && cur > 0 && cur <= total ? h('span', { class: 'chip accent', title: t('project.month_hint') }, `M${cur} / ${total}`) : null,
      h('span', { class: 'sub' }, [p.funder, p.our_role].filter(Boolean).join(' · ')),
      h('div', { class: 'right row gap-4' }, pms.map(m => avatar(m.name, m.user_id, { title: `${m.name} (PM)` })), p.my_role ? h('span', { class: 'chip outline' }, t('project.role_' + p.my_role)) : h('span', { class: 'chip outline' }, t('project.viewing_by_role')))),
    h('nav', { class: 'tabs', 'aria-label': t('project.sections') }, tabs.map(x => h('a', { href: `#/projects/${id}${x === 'tasks' ? '' : '/' + x}`, 'aria-current': x === tab ? 'page' : null }, t('project.tab_' + x)))),
    content));

  if (tab === 'tasks') {
    if (p.description && !p.total_tasks) content.append(h('div', { class: 'card pad mb-16 md', html: md(p.description) }));
    return taskCollection(content, { scope: `project:${id}`, base: { project_id: id }, project: p, members: p.members, defaultFilters: { state: 'recent' } });
  }
  if (tab === 'workload') {
    const { workloadGrid } = await import('./workload.js');
    return workloadGrid(content, { project_id: id, project: p });
  }
  if (tab === 'members') return membersTab(content, p);
  if (tab === 'files') return filesTab(content, p);
  if (tab === 'activity') return activityTab(content, p);
  if (tab === 'settings') return settingsTab(content, p);
}

// ---- members & allocations -----------------------------------------------

async function membersTab(el, p) {
  const allocs = await listAll('/allocations', { project_id: p.id });
  const manage = p.access.manage;
  const byUser = new Map();
  for (const a of allocs) (byUser.get(a.user_id) || byUser.set(a.user_id, []).get(a.user_id)).push(a);
  const roles = ['pm', 'member', 'viewer', 'guest'];

  const rows = p.members.map(m => h('tr', null,
    h('td', null, h('div', { class: 'row' }, avatar(m.name, m.user_id), h('div', { class: 'col gap-4' },
      h('a', { href: `#/people/${m.user_id}` }, m.name), h('span', { class: 'muted xs' }, m.is_external ? m.external_org || t('common.external') : (m.title || entityById(m.entity_id)?.code || ''))))),
    h('td', null, manage ? h('select', { class: 'input sm', 'aria-label': t('common.role'), onchange: async (e) => {
      try { await api.patch(`/projects/${p.id}/members/${m.user_id}`, { role: e.target.value }); toast(t('common.saved')); invalidateProject(p.id); } catch (err) { showError(err); e.target.value = m.role; }
    } }, roles.filter(r => !m.is_external || ['guest', 'viewer'].includes(r)).map(r => h('option', { value: r, selected: r === m.role }, t('project.role_' + r)))) : t('project.role_' + m.role)),
    h('td', { class: 'small' }, (byUser.get(m.user_id) || []).map(a => h('div', { class: 'row gap-4' },
      h('span', { class: 'chip accent' }, `${a.fte_pct}%`), h('span', { class: 'muted xs' }, `${fmtDate(a.start_date)} – ${fmtDate(a.end_date)}`), a.person_months ? h('span', { class: 'xs' }, `${a.person_months} ${t('project.pm_unit')}`) : null,
      manage ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('common.edit'), onclick: () => allocationDialog(p, m, a) }, icon('log', 12)) : null)),
      manage && !m.is_external ? h('button', { class: 'btn ghost sm', onclick: () => allocationDialog(p, m) }, icon('plus', 12), t('project.add_allocation')) : null),
    h('td', null, manage ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.remove')} ${m.name}`, onclick: async () => {
      if (!await confirmDialog(t('project.remove_member_confirm', { name: m.name }), { okLabel: t('common.remove') })) return;
      try { await api.del(`/projects/${p.id}/members/${m.user_id}`); invalidateProject(p.id); location.reload(); } catch (err) { showError(err); }
    } }, icon('x', 14)) : null)));

  mount(el,
    h('div', { class: 'row mb-8' }, h('h2', null, t('project.members_title'), ` (${p.members.length})`),
      manage ? h('button', { class: 'btn primary sm right', onclick: (e) => addMember(e.currentTarget, p) }, icon('plus', 13), t('project.add_member')) : null),
    h('p', { class: 'muted small' }, t('project.members_hint')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, t('common.name')), h('th', null, t('common.role')), h('th', null, t('project.allocation')), h('th'))),
      h('tbody', null, rows))));
}

async function addMember(anchor, p) {
  try {
    const people = await listAll('/users', { active: '1' });
    const existing = new Set(p.members.map(m => m.user_id));
    openMenu(anchor, people.filter(u => !existing.has(u.id)).map(u => ({ label: u.name, value: u, keywords: u.email, hint: u.is_external ? t('common.external') : u.entity_code, icon: avatar(u.name, u.id) })),
      { search: true, placeholder: t('project.find_person'), onSelect: async (u) => {
        try { await api.post(`/projects/${p.id}/members`, { user_id: u.id }); invalidateProject(p.id); toast(t('project.member_added', { name: u.name })); location.reload(); } catch (e) { showError(e); }
      } });
  } catch (e) { showError(e); }
}

function allocationDialog(p, m, a) {
  formDialog({
    title: t('project.allocation_for', { name: m.name }),
    intro: h('p', { class: 'muted small' }, t('project.allocation_hint')),
    fields: [
      { name: 'fte_pct', label: t('project.fte_pct'), type: 'number', min: 1, max: 100, required: true, value: a?.fte_pct ?? 20 },
      { name: 'start_date', label: t('project.start'), type: 'date', required: true, value: a?.start_date || p.start_date || todayStr() },
      { name: 'end_date', label: t('project.end'), type: 'date', required: true, value: a?.end_date || p.end_date || '' },
      { name: 'person_months', label: t('project.person_months'), type: 'number', step: 0.1, min: 0, value: a?.person_months ?? '', hint: t('project.person_months_hint') },
      { name: 'note', label: t('project.note'), value: a?.note || '' },
    ],
    extraFooter: a ? (close) => [h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { await api.del(`/allocations/${a.id}`); close(); location.reload(); } catch (e) { showError(e); } } }, t('common.delete'))] : null,
    onSubmit: async (v) => {
      if (a) await api.patch(`/allocations/${a.id}`, v, a.updated_at);
      else await api.post('/allocations', { ...v, user_id: m.user_id, project_id: p.id });
      location.reload();
    },
  });
}

// ---- files -----------------------------------------------------------------

async function filesTab(el, p) {
  const r = await api.list('/attachments', { project_id: p.id });
  const input = h('input', { type: 'file', class: 'hidden', multiple: true, onchange: async (e) => {
    for (const f of e.target.files) {
      const form = new FormData(); form.append('object_type', 'project'); form.append('object_id', String(p.id)); form.append('file', f);
      try { await api.upload('/attachments', form); } catch (err) { showError(err); }
    }
    filesTab(el, p);
  } });
  mount(el,
    h('div', { class: 'row mb-8' }, h('h2', null, t('project.tab_files')), p.access.work ? h('button', { class: 'btn sm right', onclick: () => input.click() }, icon('upload', 13), t('task.upload')) : null, input),
    r.data.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, t('common.name')), h('th', null, t('project.attached_to')), h('th', null, t('project.uploaded_by')), h('th', { class: 'num' }, t('project.size')), h('th'))),
      h('tbody', null, r.data.map(a => h('tr', null,
        h('td', null, h('a', { href: `/api/attachments/${a.id}/download`, download: a.filename }, icon('clip', 13), ' ', a.filename)),
        h('td', { class: 'small' }, a.object_type === 'task' ? h('a', { href: `#/tasks/${a.object_id}` }, a.task_title || `#${a.object_id}`) : t('project.the_project')),
        h('td', { class: 'small muted' }, `${a.uploaded_by_name || ''} · ${timeAgo(a.created_at)}`),
        h('td', { class: 'num small' }, `${Math.max(1, Math.round(a.size_bytes / 1024))} KB`),
        h('td', null, (a.uploaded_by === state.me.id || p.access.manage) ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.remove')} ${a.filename}`, onclick: async () => {
          try { await api.del(`/attachments/${a.id}`); filesTab(el, p); } catch (e) { showError(e); }
        } }, icon('trash', 13)) : null)))))) : h('div', { class: 'card' }, emptyState(t('project.no_files'), 'clip')));
}

// ---- activity --------------------------------------------------------------

async function activityTab(el, p) {
  let offset = 0;
  const list = h('div', { class: 'card' });
  const more = h('button', { class: 'btn sm mt-8 hidden', onclick: () => load() }, t('common.load_more'));
  mount(el, h('h2', { class: 'mb-8' }, t('project.tab_activity')), list, more,
    p.access.manage || can('audit', 1) ? h('p', { class: 'small mt-16' }, h('a', { href: `#/audit?project_id=${p.id}` }, icon('log', 13), ' ', t('project.full_audit'))) : null);
  async function load() {
    const r = await api.list('/activity', { project_id: p.id, limit: 50, offset });
    for (const a of r.data) {
      const pl = a.payload || {};
      list.append(h('div', { class: 'row', style: { padding: '8px 12px', borderBottom: '1px solid var(--border)' } },
        avatar(a.actor_name, a.actor_id),
        h('div', { class: 'grow small' }, h('strong', null, a.actor_name || t('common.someone')), ' ', t('activity.' + a.verb.replace('.', '_'), { title: pl.title || a.task_title || '', name: pl.name || '', blocker: pl.blocker || '', text: pl.text || '', filename: pl.filename || '' }),
          a.task_id && a.verb !== 'task.deleted' ? [' · ', h('a', { href: `#/tasks/${a.task_id}` }, a.task_title || '')] : null,
          pl.excerpt && pl.excerpt !== '…' ? h('div', { class: 'muted xs ellipsis' }, '“', pl.excerpt, '”') : null),
        h('span', { class: 'muted xs nowrap', title: fmtDateTime(a.at) }, timeAgo(a.at))));
    }
    if (!r.data.length && !offset) mount(list, emptyState(t('project.no_activity'), 'clock'));
    offset = r.meta.next_offset ?? offset;
    more.classList.toggle('hidden', r.meta.next_offset == null);
  }
  await load();
}

// ---- settings --------------------------------------------------------------

async function settingsTab(el, p) {
  const field = (name, label, input) => h('div', { class: 'field' }, h('label', { for: 'ps-' + name }, label), input);
  const inp = (name, attrs = {}) => h('input', { class: 'input', id: 'ps-' + name, name, value: p[name] ?? '', ...attrs });
  const form = h('form', { class: 'card pad', onsubmit: async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) body[k] = v === '' ? null : (['entity_id', 'department_id'].includes(k) ? Number(v) : v);
    try { await api.patch(`/projects/${p.id}`, body, p.updated_at); toast(t('common.saved')); emit('projects:changed'); location.reload(); } catch (err) { showError(err); }
  } },
    h('div', { class: 'form-grid' },
      field('name', t('common.name'), inp('name', { required: true })),
      field('code', t('project.code'), inp('code')),
      field('entity_id', t('common.entity'), h('select', { class: 'input', id: 'ps-entity_id', name: 'entity_id' }, state.entities.map(e => h('option', { value: e.id, selected: e.id === p.entity_id }, e.name)))),
      field('department_id', t('common.department'), h('select', { class: 'input', id: 'ps-department_id', name: 'department_id' }, h('option', { value: '' }, '—'), state.departments.map(d => h('option', { value: d.id, selected: d.id === p.department_id }, deptName(d))))),
      field('status', t('common.status'), h('select', { class: 'input', id: 'ps-status', name: 'status' }, ['planning', 'active', 'on_hold', 'closing', 'closed'].map(s => h('option', { value: s, selected: s === p.status }, t('project.status_' + s))))),
      field('kind', t('project.kind'), h('select', { class: 'input', id: 'ps-kind', name: 'kind' }, ['eu', 'national', 'internal', 'other'].map(k => h('option', { value: k, selected: k === p.kind }, t('project.kind_' + k))))),
      field('funder', t('project.funder'), inp('funder')),
      field('our_role', t('project.our_role'), inp('our_role')),
      field('start_date', t('project.start'), inp('start_date', { type: 'date' })),
      field('end_date', t('project.end'), inp('end_date', { type: 'date' })),
      field('color', t('project.color'), inp('color', { type: 'color', value: p.color || '#2563eb' })),
      field('visibility', t('project.visibility'), h('select', { class: 'input', id: 'ps-visibility', name: 'visibility' }, [['members', t('project.visibility_members')], ['entity', t('project.visibility_entity')]].map(([v, l]) => h('option', { value: v, selected: v === p.visibility }, l))))),
    h('div', { class: 'field mt-16' }, h('label', { for: 'ps-description' }, t('common.description'), h('span', { class: 'muted' }, ' — ', t('task.markdown_hint'))), h('textarea', { class: 'input', id: 'ps-description', name: 'description', rows: 5 }, p.description || '')),
    h('div', { class: 'row mt-16' }, h('button', { class: 'btn primary', type: 'submit' }, t('common.save'))));

  // sections
  const sections = h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('project.sections_title')),
    p.sections.map((s, i) => h('div', { class: 'row mb-8' },
      h('input', { class: 'input sm grow', value: s.name, 'aria-label': t('common.name'), onchange: async (e) => { try { await api.patch(`/sections/${s.id}`, { name: e.target.value }, s.updated_at); toast(t('common.saved')); } catch (err) { showError(err); } } }),
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('project.move_up'), disabled: i === 0, onclick: async () => { const prev = p.sections[i - 1]; try { await api.patch(`/sections/${s.id}`, { position: prev.position - 0.5 }); location.reload(); } catch (e) { showError(e); } } }, '↑'),
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.delete')} ${s.name}`, onclick: async () => { if (await confirmDialog(t('project.delete_section_confirm', { name: s.name }))) { try { await api.del(`/sections/${s.id}`); location.reload(); } catch (e) { showError(e); } } } }, icon('trash', 13)))),
    h('input', { class: 'input sm', style: { width: '100%' }, placeholder: t('project.add_section'), 'aria-label': t('project.add_section'), onkeydown: async (e) => { if (e.key === 'Enter' && e.target.value.trim()) { try { await api.post(`/projects/${p.id}/sections`, { name: e.target.value.trim() }); location.reload(); } catch (err) { showError(err); } } } }));

  // labels
  const labels = h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('task.labels')),
    h('div', { class: 'row wrap gap-4 mb-8' }, p.labels.map(l => labelChip(l, l.project_id ? async () => { if (await confirmDialog(t('common.confirm_delete', { name: l.name }))) { try { await api.del(`/labels/${l.id}`); location.reload(); } catch (e) { showError(e); } } } : null))),
    h('p', { class: 'muted xs' }, t('project.labels_hint')),
    h('button', { class: 'btn sm', onclick: () => formDialog({ title: t('task.add_label'), fields: [{ name: 'name', label: t('common.name'), required: true }, { name: 'color', label: t('project.color'), type: 'color', value: '#0ea5e9' }],
      onSubmit: async (v) => { await api.post('/labels', { ...v, project_id: p.id }); location.reload(); } }) }, icon('plus', 13), t('task.add_label')));

  // custom fields
  const types = ['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url'];
  const fields = h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('project.custom_fields')),
    p.custom_fields.length ? h('table', { class: 'table mb-8' }, h('tbody', null, p.custom_fields.map(f => h('tr', null, h('td', null, f.name), h('td', { class: 'muted small' }, t('field.type_' + f.type)),
      h('td', { class: 'small' }, (f.options || []).map(o => o.label).join(', ')),
      h('td', null, h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.delete')} ${f.name}`, onclick: async () => { if (await confirmDialog(t('common.confirm_delete', { name: f.name }))) { try { await api.del(`/fields/${f.id}`); location.reload(); } catch (e) { showError(e); } } } }, icon('trash', 13))))))) : h('p', { class: 'muted small' }, t('project.no_fields')),
    h('button', { class: 'btn sm', onclick: () => formDialog({ title: t('project.add_field'),
      fields: [{ name: 'name', label: t('common.name'), required: true }, { name: 'type', label: t('field.type'), type: 'select', value: 'text', options: types.map(x => ({ value: x, label: t('field.type_' + x) })) },
        { name: 'options', label: t('field.options'), hint: t('field.options_hint') }],
      onSubmit: async (v) => { await api.post(`/projects/${p.id}/fields`, { name: v.name, type: v.type, options: v.options ? v.options.split(',').map(s => s.trim()).filter(Boolean) : undefined }); location.reload(); } }) }, icon('plus', 13), t('project.add_field')));

  // danger zone
  const danger = h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('project.more_actions')),
    h('div', { class: 'row wrap' },
      can('templates', 2) ? h('button', { class: 'btn', onclick: () => formDialog({ title: t('project.save_as_template'), intro: h('p', { class: 'muted small' }, t('project.save_as_template_hint')),
        fields: [{ name: 'name', label: t('common.name'), required: true, value: `${p.code || p.name} template` }, { name: 'description', label: t('common.description'), type: 'textarea' }],
        onSubmit: async (v) => { const r = await api.post(`/projects/${p.id}/save-as-template`, v); toast(t('project.template_saved', { n: r.tasks })); } }) }, icon('template', 14), t('project.save_as_template')) : null,
      h('button', { class: 'btn', onclick: async () => { try { await api.post(`/projects/${p.id}/archive`, { archived: !p.archived_at }); emit('projects:changed'); location.reload(); } catch (e) { showError(e); } } }, icon('archive', 14), p.archived_at ? t('project.unarchive') : t('project.archive')),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog(t('project.delete_confirm', { name: p.name }))) return;
        try { await api.del(`/projects/${p.id}`); emit('projects:changed'); location.hash = '#/projects'; toast(t('project.deleted'), { action: async () => { await api.post(`/projects/${p.id}/restore`); emit('projects:changed'); location.hash = `#/projects/${p.id}`; } }); } catch (e) { showError(e); }
      } }, icon('trash', 14), t('project.delete'))));

  mount(el, h('div', { class: 'col gap-16', style: { maxWidth: '980px' } }, form, h('div', { class: 'grid-cards' }, sections, labels), fields, danger));
}
