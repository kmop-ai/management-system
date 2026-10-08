// Templates: project templates (a whole work plan as one JSON body — sections,
// labels, tasks with subtasks, dependencies and due dates as project months or
// day offsets) and task templates (one task with checklist and subtasks,
// applied into any project). #/templates lists both; #/templates/:id shows one
// project template readably, with a JSON editor for those who may edit it.

import { h, mount, icon } from '../lib/dom.js';
import { api, listAll, ApiError } from '../lib/api.js';
import { state, t, can, entityById } from '../lib/state.js';
import { formDialog, confirmDialog, modal, showError, toast, emptyState, spinner, timeAgo, labelChip, prioIcon } from '../lib/ui.js';
import { newProjectDialog } from './projects.js';

const KINDS = ['eu', 'national', 'internal', 'other'];
const kindLabel = (k) => ({ eu: t('project.kind_eu'), national: t('project.kind_national'), internal: t('project.kind_internal'), other: t('project.kind_other') })[k] || k;
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const prioLabel = (p) => ({ none: t('task.priority_none'), low: t('task.priority_low'), medium: t('task.priority_medium'), high: t('task.priority_high'), urgent: t('task.priority_urgent') })[p] || p;

export default async function templatesView(root, params, query = {}) {
  if (!can('templates', 1)) {
    mount(root, h('div', { class: 'page' }, h('h1', { class: 'mb-16' }, t('nav.templates')), h('div', { class: 'banner warn' }, t('tpl.no_access'))));
    return;
  }
  if (params.id) return detail(root, Number(params.id), query.edit === '1');
  return list(root);
}

function entityChip(id) {
  const e = id ? entityById(id) : null;
  if (!e) return h('span', { class: 'chip outline' }, t('tpl.all_entities'));
  return h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code);
}

// ---- list -------------------------------------------------------------------

async function list(root) {
  const write = can('templates', 2);
  const projBox = h('div', null, spinner());
  const taskBox = h('div', null, spinner());
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.templates')), h('span', { class: 'sub' }, t('tpl.subtitle'))),
    h('section', { class: 'mb-16', 'aria-labelledby': 'tpl-proj-h' },
      h('div', { class: 'row wrap mb-8' }, h('h2', { id: 'tpl-proj-h' }, t('tpl.project_templates')),
        write ? h('button', { class: 'btn primary sm right', onclick: () => newProjectTemplateDialog() }, icon('plus', 13), t('tpl.new_project_template')) : null),
      projBox),
    h('section', { 'aria-labelledby': 'tpl-task-h' },
      h('div', { class: 'row wrap mb-8' }, h('h2', { id: 'tpl-task-h' }, t('tpl.task_templates')),
        write ? h('button', { class: 'btn sm right', onclick: () => taskTemplateDialog(null, loadTasks) }, icon('plus', 13), t('tpl.new_task_template')) : null),
      h('p', { class: 'muted small' }, t('tpl.task_templates_hint')),
      taskBox)));

  async function loadProjects() {
    try {
      const rows = await listAll('/templates/projects');
      if (!rows.length) { mount(projBox, h('div', { class: 'card' }, emptyState(t('tpl.no_project_templates'), 'template'))); return; }
      mount(projBox, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, t('common.name')), h('th', { scope: 'col', class: 'hide-mobile' }, t('project.kind')), h('th', { scope: 'col' }, t('common.entity')),
          h('th', { scope: 'col', class: 'num hide-mobile' }, t('tpl.top_tasks')), h('th', { scope: 'col', class: 'num hide-mobile' }, t('tpl.used')),
          h('th', { scope: 'col', class: 'hide-mobile' }, t('tpl.author')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('tpl.actions'))))),
        h('tbody', null, rows.map(x => h('tr', null,
          h('td', null, h('div', { class: 'col gap-4', style: { minWidth: 0 } },
            h('a', { href: `#/templates/${x.id}`, style: { fontWeight: 600 } }, x.name),
            x.description ? h('span', { class: 'muted xs tpl-desc' }, x.description) : null)),
          h('td', { class: 'hide-mobile' }, x.kind ? h('span', { class: 'chip' }, kindLabel(x.kind)) : h('span', { class: 'muted' }, '—')),
          h('td', null, entityChip(x.entity_id)),
          h('td', { class: 'num hide-mobile' }, String(x.top_tasks ?? 0)),
          h('td', { class: 'num hide-mobile' }, t('tpl.used_n', { n: x.used || 0 })),
          h('td', { class: 'small muted hide-mobile' }, x.created_by_name || '—'),
          h('td', { class: 'nowrap' }, h('div', { class: 'row gap-4' },
            can('project_create', 2) ? h('button', { class: 'btn sm primary', onclick: () => newProjectDialog({ template_id: x.id }) }, t('tpl.use')) : null,
            h('a', { class: 'btn sm ghost', href: `#/templates/${x.id}` }, t('common.open'))))))))));
    } catch (e) { mount(projBox, h('div', { class: 'banner danger' }, e.message)); }
  }

  async function loadTasks() {
    try {
      const rows = (await api.list('/templates/tasks')).data;
      if (!rows.length) { mount(taskBox, h('div', { class: 'card' }, emptyState(t('tpl.no_task_templates'), 'tasks'))); return; }
      mount(taskBox, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col' }, t('common.name')), h('th', { scope: 'col', class: 'hide-mobile' }, t('tpl.task_title')),
          h('th', { scope: 'col', class: 'num hide-mobile' }, t('task.checklist')), h('th', { scope: 'col', class: 'num hide-mobile' }, t('task.subtasks')),
          h('th', { scope: 'col', class: 'hide-mobile' }, t('tpl.author')), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('tpl.actions'))))),
        h('tbody', null, rows.map(x => {
          const b = x.body || {};
          const mayEdit = can('templates', 2) || x.created_by === state.me.id;
          return h('tr', null,
            h('td', null, h('div', { class: 'col gap-4' }, h('strong', null, x.name),
              x.project_id ? h('span', { class: 'muted xs' }, t('tpl.project_only')) : null,
              h('span', { class: 'muted xs tpl-narrow' }, b.title || ''))),
            h('td', { class: 'small hide-mobile' }, b.title || '—', b.estimate_hours ? h('span', { class: 'muted xs' }, ` · ${b.estimate_hours}${t('common.hours_short')}`) : null),
            h('td', { class: 'num hide-mobile' }, String((b.checklist || []).length)),
            h('td', { class: 'num hide-mobile' }, String((b.subtasks || []).length)),
            h('td', { class: 'small muted hide-mobile' }, x.created_by_name || '—'),
            h('td', { class: 'nowrap' }, h('div', { class: 'row gap-4' },
              h('button', { class: 'btn sm primary', onclick: () => applyDialog(x) }, t('tpl.apply')),
              mayEdit ? h('button', { class: 'btn sm ghost', onclick: () => taskTemplateDialog(x, loadTasks) }, t('common.edit')) : null,
              mayEdit ? h('button', { class: 'btn sm ghost icon-only', 'aria-label': `${t('common.delete')} ${x.name}`, onclick: async () => {
                if (!await confirmDialog(t('tpl.delete_task_confirm', { name: x.name }))) return;
                try { await api.del(`/templates/tasks/${x.id}`); toast(t('common.deleted')); loadTasks(); } catch (e) { showError(e); }
              } }, icon('trash', 13)) : null)));
        })))));
    } catch (e) { mount(taskBox, h('div', { class: 'banner danger' }, e.message)); }
  }

  await Promise.all([loadProjects(), loadTasks()]);
}

// ---- task templates -----------------------------------------------------------

const lines = (s) => (s || '').split('\n').map(x => x.trim()).filter(Boolean);

function taskTemplateDialog(tt, done) {
  const b = tt?.body || {};
  formDialog({
    title: tt ? t('tpl.edit_task_template') : t('tpl.new_task_template'),
    submitLabel: tt ? t('common.save') : t('common.create'),
    wide: true,
    fields: [
      { name: 'name', label: t('tpl.template_name'), required: true, value: tt?.name || '', hint: t('tpl.template_name_hint') },
      { name: 'title', label: t('tpl.task_title'), required: true, value: b.title || '' },
      { name: 'description', label: t('common.description'), type: 'textarea', rows: 3, value: b.description || '' },
      { name: 'estimate_hours', label: t('task.estimate'), type: 'number', min: 0, step: 0.5, value: b.estimate_hours ?? '' },
      { name: 'priority', label: t('task.priority'), type: 'select', value: b.priority || 'none', options: PRIORITIES.map(p => ({ value: p, label: prioLabel(p) })) },
      { name: 'checklist', label: t('task.checklist'), type: 'textarea', rows: 4, value: (b.checklist || []).join('\n'), hint: t('tpl.one_per_line') },
      { name: 'subtasks', label: t('task.subtasks'), type: 'textarea', rows: 3, value: (b.subtasks || []).map(s => s.title).join('\n'), hint: t('tpl.one_per_line') },
    ],
    onSubmit: async (v) => {
      // Keep whatever else a subtask carried (its own checklist, estimate) when its title is unchanged.
      const prevSubs = new Map((b.subtasks || []).map(s => [s.title, s]));
      const body = { ...b, title: v.title, description: v.description || undefined, estimate_hours: v.estimate_hours ?? undefined,
        priority: v.priority && v.priority !== 'none' ? v.priority : undefined,
        checklist: lines(v.checklist), subtasks: lines(v.subtasks).map(title => prevSubs.get(title) || { title }) };
      for (const k of Object.keys(body)) if (body[k] === undefined || (Array.isArray(body[k]) && !body[k].length)) delete body[k];
      if (tt) await api.patch(`/templates/tasks/${tt.id}`, { name: v.name, body }, tt.updated_at);
      else await api.post('/templates/tasks', { name: v.name, body });
      toast(t('common.saved'));
      await done();
    },
  });
}

async function applyDialog(tt) {
  let projects = [];
  try { projects = await listAll('/projects', { member: 'me', sort: 'name' }); } catch (e) { showError(e); }
  const ids = { project: 'ap-project', section: 'ap-section', assignee: 'ap-assignee', due: 'ap-due' };
  const projectSel = h('select', { class: 'input', id: ids.project },
    h('option', { value: '' }, t('tpl.personal_task')),
    projects.filter(p => !p.archived_at).map(p => h('option', { value: p.id }, p.code ? `${p.code} — ${p.name}` : p.name)));
  const sectionSel = h('select', { class: 'input', id: ids.section, disabled: true }, h('option', { value: '' }, t('task.no_section')));
  const assigneeSel = h('select', { class: 'input', id: ids.assignee, disabled: true }, h('option', { value: '' }, t('tpl.assign_me_personal')));
  const due = h('input', { class: 'input', type: 'date', id: ids.due });
  const err = h('div', { class: 'error small', 'aria-live': 'polite' });
  const field = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);

  projectSel.addEventListener('change', async () => {
    const id = Number(projectSel.value);
    if (!id) {
      mount(sectionSel, h('option', { value: '' }, t('task.no_section'))); sectionSel.disabled = true;
      mount(assigneeSel, h('option', { value: '' }, t('tpl.assign_me_personal'))); assigneeSel.disabled = true;
      return;
    }
    try {
      const p = await api.get(`/projects/${id}`);
      if (Number(projectSel.value) !== id) return;
      mount(sectionSel, h('option', { value: '' }, t('task.no_section')), p.sections.map(s => h('option', { value: s.id }, s.name)));
      mount(assigneeSel, h('option', { value: '' }, t('task.unassigned')), p.members.filter(m => m.role !== 'viewer').map(m => h('option', { value: m.user_id, selected: m.user_id === state.me.id }, m.name)));
      sectionSel.disabled = false; assigneeSel.disabled = false;
    } catch (e) { showError(e); }
  });

  const submit = h('button', { class: 'btn primary', type: 'submit' }, t('tpl.create_task'));
  const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const body = {};
    if (projectSel.value) body.project_id = Number(projectSel.value);
    if (sectionSel.value) body.section_id = Number(sectionSel.value);
    if (assigneeSel.value) body.assignee_id = Number(assigneeSel.value);
    if (due.value) body.due_date = due.value;
    submit.disabled = true;
    try {
      const r = await api.post(`/templates/tasks/${tt.id}/apply`, body);
      m.close();
      toast(t('tpl.task_created', { title: tt.body?.title || tt.name }), { action: () => { location.hash = `#/tasks/${r.id}`; }, actionLabel: t('common.open') });
    } catch (ex) { err.textContent = ex instanceof ApiError && ex.details?.fields ? Object.entries(ex.details.fields).map(([k, v]) => `${k}: ${v}`).join('; ') : ex.message; }
    finally { submit.disabled = false; }
  } },
    h('p', { class: 'muted small', style: { margin: 0 } }, t('tpl.apply_intro', { title: tt.body?.title || tt.name, n: (tt.body?.checklist || []).length, s: (tt.body?.subtasks || []).length })),
    field(ids.project, t('task.project'), projectSel),
    field(ids.section, t('task.section'), sectionSel),
    field(ids.assignee, t('task.assignee'), assigneeSel),
    field(ids.due, t('task.due_date'), due, t('tpl.due_hint')),
    err);
  const m = modal({ title: t('tpl.apply_title', { name: tt.name }), body: form,
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('common.cancel')), submit] });
  submit.addEventListener('click', () => form.requestSubmit());
}

// ---- project templates: create ------------------------------------------------

function starterBody() {
  const s1 = t('tpl.starter_section_1'), s2 = t('tpl.starter_section_2');
  return {
    sections: [{ name: s1 }, { name: s2 }],
    labels: [{ name: 'deliverable', color: '#9333ea' }],
    tasks: [
      { key: 'kickoff', title: t('tpl.starter_task_1'), section: s1, due_offset: 14, is_milestone: true, assign: 'creator', checklist: [t('tpl.starter_check_1'), t('tpl.starter_check_2')] },
      { key: 'plan', title: t('tpl.starter_task_2'), section: s1, due_month: 2, blocked_by: ['kickoff'] },
      { key: 'deliverable', title: t('tpl.starter_task_3'), section: s2, start_month: 2, due_month: 6, labels: ['deliverable'],
        subtasks: [{ key: 'draft', title: t('tpl.starter_sub_1'), due_month: 5 }, { key: 'review', title: t('tpl.starter_sub_2'), due_month: 6 }] },
    ],
  };
}

function newProjectTemplateDialog() {
  formDialog({
    title: t('tpl.new_project_template'),
    submitLabel: t('common.create'),
    intro: h('p', { class: 'muted small' }, t('tpl.new_project_template_hint')),
    fields: [
      { name: 'name', label: t('common.name'), required: true },
      { name: 'description', label: t('common.description'), type: 'textarea', rows: 3 },
      { name: 'kind', label: t('project.kind'), type: 'select', value: 'eu', options: KINDS.map(k => ({ value: k, label: kindLabel(k) })) },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: '', hint: t('tpl.entity_hint'),
        options: [{ value: '', label: t('tpl.all_entities') }, ...state.entities.map(e => ({ value: e.id, label: e.name }))] },
    ],
    onSubmit: async (v) => {
      const r = await api.post('/templates/projects', { ...v, body: starterBody() });
      toast(t('tpl.created'));
      location.hash = `#/templates/${r.id}?edit=1`;
    },
  });
}

// ---- project template: detail --------------------------------------------------

function flatten(tasks, out = []) { for (const x of tasks || []) { out.push(x); flatten(x.subtasks, out); } return out; }

const when = (month, offset) => month != null ? `M${month}` : offset != null ? t('tpl.day_offset', { n: (offset >= 0 ? '+' : '') + offset }) : null;

async function detail(root, id, startEditing) {
  const tpl = await api.get(`/templates/projects/${id}`);
  const page = h('div', { class: 'page wide' });
  mount(root, page);
  let editing = startEditing && tpl.can_edit;

  const render = () => {
    const body = tpl.body || {};
    const flat = flatten(body.tasks);
    const e = tpl.entity_id ? entityById(tpl.entity_id) : null;
    mount(page,
      h('div', { class: 'breadcrumbs mb-8' }, h('a', { href: '#/templates' }, t('nav.templates')), ' / '),
      h('div', { class: 'page-head' },
        h('h1', null, tpl.name),
        tpl.kind ? h('span', { class: 'chip' }, kindLabel(tpl.kind)) : null,
        entityChip(tpl.entity_id),
        h('span', { class: 'sub' }, t('tpl.updated_ago', { when: timeAgo(tpl.updated_at) })),
        h('div', { class: 'right row wrap gap-4' },
          can('project_create', 2) ? h('button', { class: 'btn primary', onclick: () => newProjectDialog({ template_id: tpl.id, entity_id: tpl.entity_id || undefined }) }, icon('plus', 14), t('tpl.use_this')) : null,
          tpl.can_edit && !editing ? h('button', { class: 'btn', onclick: () => { editing = true; render(); } }, t('common.edit')) : null,
          tpl.can_edit ? h('button', { class: 'btn danger icon-only', 'aria-label': t('tpl.delete_template'), title: t('tpl.delete_template'), onclick: async () => {
            if (!await confirmDialog(t('tpl.delete_confirm', { name: tpl.name }))) return;
            try { await api.del(`/templates/projects/${tpl.id}`); toast(t('common.deleted')); location.hash = '#/templates'; } catch (err) { showError(err); }
          } }, icon('trash', 14)) : null)),
      editing ? editor() : [
        tpl.description ? h('p', { class: 'tpl-intro' }, tpl.description) : null,
        h('div', { class: 'row wrap gap-16 mb-16 small' },
          stat(body.sections?.length || 0, t('tpl.stat_sections')), stat(flat.length, t('tpl.stat_tasks')),
          stat(flat.filter(x => x.is_milestone).length, t('tpl.stat_milestones')), stat(flat.filter(x => x.blocked_by?.length).length, t('tpl.stat_dependencies')),
          e ? null : h('span', { class: 'muted small', style: { alignSelf: 'center' } }, t('tpl.any_entity_note'))),
        structure(body, flat),
      ]);
  };

  const stat = (v, k) => h('div', { class: 'stat' }, h('span', { class: 'v' }, String(v)), h('span', { class: 'k' }, k));

  function structure(body, flat) {
    const titleOf = Object.fromEntries(flat.map(x => [x.key, x.title]));
    const labelColor = Object.fromEntries((body.labels || []).map(l => [l.name, l.color]));
    const sections = (body.sections || []).map(s => s.name);
    const groups = sections.map(name => ({ name, tasks: (body.tasks || []).filter(x => x.section === name) }));
    const loose = (body.tasks || []).filter(x => !x.section || !sections.includes(x.section));
    if (loose.length) groups.push({ name: t('task.no_section'), tasks: loose, none: true });

    const node = (x) => {
      const start = when(x.start_month, x.start_offset), due = when(x.due_month, x.due_offset);
      const waits = (x.blocked_by || []).map(k => titleOf[k] || k);
      return h('li', { class: ['tpl-task', x.is_milestone && 'milestone'] },
        h('div', { class: 'tpl-task-row' },
          x.is_milestone ? h('span', { class: 'tpl-ms', title: t('tpl.milestone') }, icon('diamond', 13), h('span', { class: 'sr-only' }, t('tpl.milestone'))) : h('span', { class: 'tpl-bullet', 'aria-hidden': 'true' }),
          h('span', { class: 'tpl-title' }, x.title),
          x.priority && x.priority !== 'none' ? prioIcon(x.priority) : null,
          h('span', { class: 'tpl-when' },
            start ? h('span', { class: 'chip outline', title: t('task.start_date') }, start, ' →') : null,
            due ? h('span', { class: ['chip', x.is_milestone ? 'accent' : 'outline'], title: t('task.due_date') }, due) : null),
          (x.labels || []).map(l => labelChip({ name: l, color: labelColor[l] })),
          x.estimate_hours ? h('span', { class: 'muted xs' }, `${x.estimate_hours}${t('common.hours_short')}`) : null,
          x.is_internal ? h('span', { class: 'chip warn' }, icon('lock', 11), t('common.internal')) : null,
          x.assign === 'creator' ? h('span', { class: 'chip', title: t('tpl.assign_creator_hint') }, icon('user', 11), t('tpl.assign_creator')) : null),
        waits.length ? h('div', { class: 'tpl-sub small muted' }, icon('link', 12), ' ', t('tpl.waits_on', { list: waits.join(', ') })) : null,
        x.description ? h('div', { class: 'tpl-sub small muted' }, x.description) : null,
        x.checklist?.length ? h('ul', { class: 'tpl-checklist tpl-sub', 'aria-label': t('task.checklist') }, x.checklist.map(c => h('li', null, c))) : null,
        x.subtasks?.length ? h('ul', { class: 'tpl-tree nested', 'aria-label': t('task.subtasks') }, x.subtasks.map(node)) : null);
    };

    if (!flat.length && !sections.length) return h('div', { class: 'card' }, emptyState(t('tpl.empty_body'), 'template'));
    return h('div', { class: 'col gap-16' },
      groups.map(g => h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { class: ['grow', g.none && 'muted'] }, g.name), h('span', { class: 'muted small' }, t('tpl.n_tasks', { n: flatten(g.tasks).length }))),
        g.tasks.length ? h('ul', { class: 'tpl-tree card-body' }, g.tasks.map(node)) : h('p', { class: 'muted small card-body', style: { margin: 0 } }, t('tpl.section_empty')))),
      (body.labels?.length || body.custom_fields?.length) ? h('div', { class: 'grid-cards' },
        body.labels?.length ? h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('task.labels')), h('div', { class: 'row wrap gap-4' }, body.labels.map(l => labelChip(l)))) : null,
        body.custom_fields?.length ? h('div', { class: 'card pad' }, h('h3', { class: 'mb-8' }, t('project.custom_fields')),
          h('ul', { class: 'tpl-checklist' }, body.custom_fields.map(f => h('li', null, f.name, h('span', { class: 'muted xs' }, ' · ', f.type || 'text',
            f.options?.length ? ` (${f.options.map(o => typeof o === 'string' ? o : o.label).join(', ')})` : ''))))) : null) : null);
  }

  function editor() {
    const ids = { name: 'te-name', desc: 'te-desc', kind: 'te-kind', entity: 'te-entity', body: 'te-body' };
    const name = h('input', { class: 'input', id: ids.name, value: tpl.name, required: true });
    const desc = h('textarea', { class: 'input', id: ids.desc, rows: 3 }, tpl.description || '');
    const kind = h('select', { class: 'input', id: ids.kind }, h('option', { value: '' }, '—'), KINDS.map(k => h('option', { value: k, selected: k === tpl.kind }, kindLabel(k))));
    const entity = h('select', { class: 'input', id: ids.entity }, h('option', { value: '' }, t('tpl.all_entities')), state.entities.map(e => h('option', { value: e.id, selected: e.id === tpl.entity_id }, e.name)));
    const json = h('textarea', { class: 'input tpl-json', id: ids.body, rows: 24, spellcheck: 'false', autocapitalize: 'off', 'aria-describedby': 'te-status' }, JSON.stringify(tpl.body || {}, null, 2));
    const status = h('div', { id: 'te-status', class: 'small', 'aria-live': 'polite' });
    const serverErr = h('div', { class: 'hidden banner danger', role: 'alert' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, t('common.save'));

    const check = () => {
      try {
        const b = JSON.parse(json.value);
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(t('tpl.json_not_object'));
        if (b.tasks !== undefined && !Array.isArray(b.tasks)) throw new Error(t('tpl.json_tasks_array'));
        const n = flatten(b.tasks).length;
        status.className = 'small ok-text'; status.textContent = t('tpl.json_ok', { n });
        save.disabled = false;
        return b;
      } catch (e) {
        status.className = 'small danger-text'; status.textContent = t('tpl.json_invalid', { msg: e.message });
        save.disabled = true;
        return null;
      }
    };
    json.addEventListener('input', check);
    json.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        // two-space indent instead of leaving the field; Esc then Tab still moves on
        if (json.dataset.escaped) { delete json.dataset.escaped; return; }
        e.preventDefault(); json.setRangeText('  ', json.selectionStart, json.selectionEnd, 'end'); check();
      } else if (e.key === 'Escape') { json.dataset.escaped = '1'; e.stopPropagation(); }
    });

    const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
      e.preventDefault();
      const b = check();
      if (!b) return;
      serverErr.classList.add('hidden');
      save.disabled = true;
      try {
        const out = await api.patch(`/templates/projects/${tpl.id}`, { name: name.value.trim(), description: desc.value || null, kind: kind.value || null,
          entity_id: entity.value ? Number(entity.value) : null, body: b }, tpl.updated_at);
        Object.assign(tpl, out);
        editing = false;
        toast(t('common.saved'));
        history.replaceState(null, '', `#/templates/${tpl.id}`);
        render();
      } catch (ex) {
        const fields = ex instanceof ApiError && ex.details?.fields;
        mount(serverErr, h('strong', null, t('tpl.server_rejected')), ' ',
          fields ? h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } }, Object.entries(fields).map(([k, v]) => h('li', null, h('code', { class: 'mono' }, k), ': ', String(v)))) : ex.message);
        serverErr.classList.remove('hidden');
        save.disabled = false;
      }
    } },
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: ids.name }, t('common.name')), name),
        h('div', { class: 'field' }, h('label', { for: ids.kind }, t('project.kind')), kind),
        h('div', { class: 'field' }, h('label', { for: ids.entity }, t('common.entity')), entity)),
      h('div', { class: 'field' }, h('label', { for: ids.desc }, t('common.description')), desc),
      h('div', { class: 'field' },
        h('div', { class: 'row wrap' }, h('label', { for: ids.body, class: 'label' }, t('tpl.body_json')),
          h('button', { class: 'btn ghost sm right', type: 'button', onclick: () => { const b = check(); if (b) { json.value = JSON.stringify(b, null, 2); check(); } } }, t('tpl.format_json'))),
        json, status),
      h('details', { class: 'card pad small tpl-help' }, h('summary', null, t('tpl.format_help_title')),
        h('ul', null, [t('tpl.help_sections'), t('tpl.help_tasks'), t('tpl.help_dates'), t('tpl.help_deps'), t('tpl.help_more')].map(x => h('li', null, x)))),
      serverErr,
      h('div', { class: 'row tpl-actions' }, save, h('button', { class: 'btn', type: 'button', onclick: () => { editing = false; history.replaceState(null, '', `#/templates/${tpl.id}`); render(); } }, t('common.cancel'))));
    queueMicrotask(check);
    return form;
  }

  render();
}
