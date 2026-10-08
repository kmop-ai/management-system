// The task detail drawer, and the quick-add dialog. Every view opens tasks
// through #/tasks/:id, which lands here, so there is exactly one task editor.

import { h, mount, icon, projectMonth } from './dom.js';
import { api, ApiError } from './api.js';
import { state, t, emit } from './state.js';
import { toast, showError, openMenu, closeMenu, modal, formDialog, confirmDialog, avatar, statusPill, prioIcon, labelChip, fmtDate, fmtDateTime, timeAgo, copyText, hours } from './ui.js';
import { md } from './markdown.js';

const projectCache = new Map();
export async function getProject(id, fresh = false) {
  if (!id) return null;
  if (!fresh && projectCache.has(id)) return projectCache.get(id);
  const p = api.get(`/projects/${id}`);
  projectCache.set(id, p);
  try { return await p; } catch (e) { projectCache.delete(id); throw e; }
}
export function invalidateProject(id) { projectCache.delete(id); }

let drawer = null;

export function closeTaskDrawer(silent = false) {
  if (!drawer) return;
  const d = drawer;
  drawer = null;
  d.back.remove();
  d.el.remove();
  closeMenu();
  if (d.prevFocus && d.prevFocus.focus && document.contains(d.prevFocus)) d.prevFocus.focus();
  if (!silent && d.onClose) d.onClose();
}

export async function openTaskDrawer(id, { onClose } = {}) {
  if (drawer && drawer.id === id) return;
  const prevFocus = drawer ? drawer.prevFocus : document.activeElement;
  closeTaskDrawer(true);
  const body = h('div', { class: 'drawer-body' }, h('div', { class: 'loading-page' }, h('span', { class: 'spinner' })));
  const head = h('div', { class: 'drawer-head' });
  const el = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('task.details'), tabindex: '-1' }, head, body);
  const back = h('div', { class: 'drawer-back', onclick: () => closeTaskDrawer() });
  document.body.append(back, el);
  drawer = { id, el, back, onClose, prevFocus };
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('.menu') && !document.querySelector('dialog[open]')) {
      const tag = (e.target.tagName || '').toLowerCase();
      if ((tag === 'textarea' || tag === 'input') && e.target.dataset.dirty === '1') { e.target.blur(); return; }
      closeTaskDrawer();
    }
    // Focus trap
    if (e.key === 'Tab') {
      const f = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { f[f.length - 1].focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { f[0].focus(); e.preventDefault(); }
    }
  });
  el.focus();
  try {
    const task = await api.get(`/tasks/${id}`);
    if (!drawer || drawer.id !== id) return;
    const project = task.project_id ? await getProject(task.project_id) : null;
    if (!drawer || drawer.id !== id) return;
    new TaskEditor(task, project, head, body).render();
  } catch (e) {
    mount(body, h('div', { class: 'banner danger' }, e.status === 404 ? t('task.not_found') : e.message));
    mount(head, h('div', { class: 'grow' }), h('button', { class: 'btn ghost icon-only', 'aria-label': t('common.close'), onclick: () => closeTaskDrawer() }, icon('x')));
  }
}

class TaskEditor {
  constructor(task, project, head, body) {
    this.task = task; this.project = project; this.head = head; this.body = body;
    this.members = project ? project.members.filter(m => m.role !== 'viewer') : [];
    this.canEdit = task.access.edit;
    this.fullEdit = this.canEdit && (!project || ['pm', 'member'].includes(project.my_role) || project.access?.work);
  }

  async save(patch, { quiet = false } = {}) {
    try {
      const updated = await api.patch(`/tasks/${this.task.id}`, patch, this.task.updated_at);
      const access = this.task.access;
      this.task = { ...updated, access };
      emit('task:changed', this.task);
      this.render();
      if (!quiet) toast(t('common.saved'), { ms: 1500 });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'conflict') {
        toast(t('common.conflict'), { error: true, action: () => this.reload(), actionLabel: t('common.reload') });
      } else showError(e);
    }
  }

  async reload() {
    const access = this.task.access;
    this.task = { ...(await api.get(`/tasks/${this.task.id}`)), access };
    this.render();
  }

  render() {
    const tk = this.task;
    const done = !!tk.completed_at;
    // ---- head
    const crumbs = h('div', { class: 'breadcrumbs grow ellipsis' },
      this.project ? h('a', { href: `#/projects/${this.project.id}` }, this.project.code || this.project.name) : h('span', null, t('task.personal')),
      ...(tk.ancestors || []).flatMap(a => [h('span', null, '›'), h('a', { href: `#/tasks/${a.id}` }, a.title)]));
    mount(this.head,
      h('button', { class: ['btn', 'sm', done ? '' : 'primary'], disabled: !this.canEdit, onclick: () => this.save({ completed: !done }) }, icon('check', 14), done ? t('task.reopen') : t('task.mark_done')),
      crumbs,
      h('button', { class: 'btn ghost sm icon-only', title: tk.following ? t('task.unfollow') : t('task.follow'), 'aria-label': tk.following ? t('task.unfollow') : t('task.follow'), 'aria-pressed': String(!!tk.following), onclick: () => this.toggleFollow() }, icon('bell', 15)),
      h('button', { class: 'btn ghost sm icon-only', title: t('common.copy_link'), 'aria-label': t('common.copy_link'), onclick: () => copyText(`${location.origin}/#/tasks/${tk.id}`) }, icon('link', 15)),
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('common.more'), onclick: (e) => this.moreMenu(e.currentTarget) }, icon('more', 15)),
      h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('common.close'), title: t('common.close') + ' (Esc)', onclick: () => closeTaskDrawer() }, icon('x', 16)),
    );

    // ---- body
    const title = h('textarea', { class: 'title-input', rows: 1, 'aria-label': t('common.title'), readonly: !this.fullEdit,
      oninput: (e) => { e.target.dataset.dirty = '1'; autosize(e.target); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
      onblur: (e) => { const v = e.target.value.trim(); e.target.dataset.dirty = ''; if (v && v !== tk.title) this.save({ title: v }, { quiet: true }); else e.target.value = tk.title; } }, tk.title);

    const banners = [];
    if (tk.deleted_at) banners.push(h('div', { class: 'banner danger mb-8' }, t('task.is_deleted')));
    if (tk.open_blockers > 0 && !done) banners.push(h('div', { class: 'banner warn mb-8' }, icon('alert', 14), ' ', t('task.waiting_on', { n: tk.open_blockers })));
    if (tk.is_internal) banners.push(h('div', { class: 'banner info mb-8' }, icon('lock', 14), ' ', t('task.internal_note')));

    mount(this.body,
      ...banners,
      title,
      this.renderProps(),
      this.renderDescription(),
      this.renderSubtasks(),
      this.renderChecklist(),
      this.renderDependencies(),
      this.attachmentsBox = h('div'),
      this.commentsBox = h('div'),
      this.activityBox = h('div'),
    );
    requestAnimationFrame(() => autosize(title));
    this.loadAttachments();
    this.loadComments();
  }

  renderProps() {
    const tk = this.task;
    const p = this.project;
    const rows = [];
    const row = (k, v) => rows.push(h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
    const dis = !this.fullEdit;

    // assignee
    const assigneeBtn = h('button', { class: 'btn ghost sm', disabled: dis, onclick: (e) => {
      const people = p ? this.members : [{ user_id: state.me.id, name: state.me.name }];
      openMenu(e.currentTarget, [
        { label: t('common.nobody'), value: null, checked: tk.assignee_id == null },
        ...people.map(m => ({ label: m.name, value: m.user_id, checked: tk.assignee_id === m.user_id, icon: avatar(m.name, m.user_id), hint: m.role === 'guest' ? t('project.role_guest') : '' })),
      ], { search: true, onSelect: (v) => this.save({ assignee_id: v }) });
    } }, avatar(tk.assignee_name, tk.assignee_id), tk.assignee_name || t('task.unassigned'));
    row(t('task.assignee'), assigneeBtn);

    // dates
    const start = h('input', { type: 'date', class: 'input sm', value: tk.start_date || '', disabled: dis, 'aria-label': t('task.start_date'), onchange: (e) => this.save({ start_date: e.target.value || null }, { quiet: true }) });
    const due = h('input', { type: 'date', class: 'input sm', value: tk.due_date || '', disabled: !this.canEdit || dis, 'aria-label': t('task.due_date'), onchange: (e) => this.save({ due_date: e.target.value || null }, { quiet: true }) });
    const m = p?.start_date && tk.due_date ? projectMonth(p.start_date, tk.due_date) : null;
    row(t('task.dates'), [start, h('span', { class: 'muted' }, '→'), due, m && m > 0 ? h('span', { class: 'chip outline', title: t('task.project_month_hint') }, `M${m}`) : null,
      tk.recurrence ? h('span', { class: 'chip accent', title: t('task.repeats') }, icon('repeat', 12), recurrenceText(tk.recurrence)) : null]);

    // status
    row(t('common.status'), h('button', { class: 'btn ghost sm', disabled: !this.canEdit, onclick: (e) => openMenu(e.currentTarget,
      state.statuses.map(s => ({ label: state.locale === 'el' ? s.label_el : s.label_en, value: s.key, checked: tk.status === s.key, icon: h('span', { class: 'status-pill', style: { '--c': s.color } }) })),
      { onSelect: (v) => this.save({ status: v }) }) }, statusPill(tk.status)));

    // priority
    row(t('task.priority'), h('button', { class: 'btn ghost sm', disabled: dis, onclick: (e) => openMenu(e.currentTarget,
      ['urgent', 'high', 'medium', 'low', 'none'].map(v => ({ label: t('task.priority_' + v), value: v, checked: tk.priority === v, icon: prioIcon(v) })),
      { onSelect: (v) => this.save({ priority: v }) }) }, prioIcon(tk.priority), t('task.priority_' + tk.priority)));

    // estimate
    row(t('task.estimate'), [h('input', { type: 'number', class: 'input sm', style: { width: '80px' }, min: 0, step: 0.5, value: tk.estimate_hours ?? '', disabled: !this.canEdit, 'aria-label': t('task.estimate'),
      onchange: (e) => this.save({ estimate_hours: e.target.value === '' ? null : Number(e.target.value) }, { quiet: true }) }), h('span', { class: 'muted small' }, t('common.hours'))]);

    if (p) {
      // section
      const sec = p.sections.find(s => s.id === tk.section_id);
      if (!tk.parent_id) row(t('task.section'), h('button', { class: 'btn ghost sm', disabled: dis, onclick: (e) => openMenu(e.currentTarget,
        [{ label: t('task.no_section'), value: null, checked: !tk.section_id }, ...p.sections.map(s => ({ label: s.name, value: s.id, checked: s.id === tk.section_id }))],
        { onSelect: (v) => this.save({ section_id: v }) }) }, sec ? sec.name : t('task.no_section')));

      // labels
      const labels = h('div', { class: 'row wrap gap-4' }, tk.labels.map(l => labelChip(l, dis ? null : () => this.save({ label_ids: tk.labels.filter(x => x.id !== l.id).map(x => x.id) }, { quiet: true }))),
        dis ? null : h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('task.add_label'), onclick: (e) => openMenu(e.currentTarget,
          p.labels.map(l => ({ label: l.name, value: l.id, checked: tk.labels.some(x => x.id === l.id), icon: h('span', { class: 'chip label', style: { background: l.color, width: '10px', padding: 0 } }) })),
          { search: true, onSelect: (v) => { const ids = tk.labels.map(x => x.id); this.save({ label_ids: ids.includes(v) ? ids.filter(x => x !== v) : [...ids, v] }, { quiet: true }); } }) }, icon('plus', 14)));
      row(t('task.labels'), labels);

      // custom fields
      for (const f of p.custom_fields || []) row(f.name, this.fieldInput(f, dis));

      // internal flag — only meaningful when guests are around, but always settable by members
      if (this.fullEdit) row(t('common.internal'), h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: !!tk.is_internal, onchange: (e) => this.save({ is_internal: e.target.checked }) }), h('span', { class: 'muted small' }, t('task.internal_hint'))));
    }

    // repeat
    if (this.canEdit && this.fullEdit) row(t('task.repeats'), h('button', { class: 'btn ghost sm', onclick: () => this.recurrenceDialog() }, icon('repeat', 14), tk.recurrence ? recurrenceText(tk.recurrence) : t('task.does_not_repeat')));

    // followers
    row(t('task.followers'), h('div', { class: 'row wrap gap-4' }, tk.followers.map(f => avatar(f.name, f.user_id)),
      p && this.fullEdit ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('task.add_follower'), onclick: (e) => openMenu(e.currentTarget,
        p.members.map(m => ({ label: m.name, value: m.user_id, checked: tk.followers.some(f => f.user_id === m.user_id), icon: avatar(m.name, m.user_id) })),
        { search: true, onSelect: async (v) => {
          try {
            if (tk.followers.some(f => f.user_id === v)) await api.del(`/tasks/${tk.id}/followers/${v}`);
            else await api.post(`/tasks/${tk.id}/followers`, { user_id: v });
            this.reload();
          } catch (err) { showError(err); }
        } }) }, icon('plus', 14)) : null));

    row(t('task.created'), h('span', { class: 'muted small' }, `${tk.created_by_name || ''} · ${fmtDateTime(tk.created_at)}`, tk.completed_at ? ` · ${t('task.completed_by', { who: tk.completed_by_name || '', when: fmtDateTime(tk.completed_at) })}` : ''));
    return h('div', { class: 'props' }, rows);
  }

  fieldInput(f, dis) {
    const tk = this.task;
    const v = tk.fields?.[f.id];
    const set = (val) => this.save({ fields: { [f.id]: val } }, { quiet: true });
    if (f.type === 'select') return h('select', { class: 'input sm', disabled: dis, 'aria-label': f.name, onchange: (e) => set(e.target.value || null) },
      h('option', { value: '' }, '—'), (f.options || []).map(o => h('option', { value: o.key, selected: v === o.key }, o.label)));
    if (f.type === 'multiselect') return h('div', { class: 'row wrap gap-4' }, (f.options || []).map(o => h('label', { class: 'checkbox small' },
      h('input', { type: 'checkbox', disabled: dis, checked: Array.isArray(v) && v.includes(o.key), onchange: (e) => { const cur = Array.isArray(v) ? v : []; set(e.target.checked ? [...cur, o.key] : cur.filter(x => x !== o.key)); } }), o.label)));
    if (f.type === 'checkbox') return h('input', { type: 'checkbox', disabled: dis, checked: !!v, 'aria-label': f.name, onchange: (e) => set(e.target.checked) });
    if (f.type === 'user') return h('select', { class: 'input sm', disabled: dis, 'aria-label': f.name, onchange: (e) => set(e.target.value ? Number(e.target.value) : null) },
      h('option', { value: '' }, '—'), (this.project?.members || []).map(m => h('option', { value: m.user_id, selected: v === m.user_id }, m.name)));
    const type = f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'url' ? 'url' : 'text';
    return h('input', { class: 'input sm', type, value: v ?? '', disabled: dis, 'aria-label': f.name, style: { minWidth: '200px' }, onchange: (e) => set(e.target.value === '' ? null : type === 'number' ? Number(e.target.value) : e.target.value) });
  }

  renderDescription() {
    const tk = this.task;
    const box = h('div');
    const view = () => mount(box,
      h('div', { class: 'section-title' }, t('common.description')),
      h('div', { class: 'desc-view md', tabindex: this.fullEdit ? '0' : null, role: this.fullEdit ? 'button' : null, 'aria-label': this.fullEdit ? t('task.edit_description') : null,
        onclick: (e) => { if (this.fullEdit && !e.target.closest('a')) edit(); }, onkeydown: (e) => { if (this.fullEdit && e.key === 'Enter') { e.preventDefault(); edit(); } },
        html: tk.description ? md(tk.description) : `<span class="muted">${this.fullEdit ? escapeText(t('task.add_description')) : '—'}</span>` }));
    const edit = () => {
      const ta = h('textarea', { class: 'input', rows: 8, style: { width: '100%' }, 'aria-label': t('common.description'), oninput: (e) => { e.target.dataset.dirty = '1'; } }, tk.description || '');
      attachMentions(ta, () => this.project?.members || []);
      mount(box, h('div', { class: 'section-title' }, t('common.description'), h('span', { class: 'muted xs' }, t('task.markdown_hint'))), ta,
        h('div', { class: 'row mt-8' },
          h('button', { class: 'btn primary sm', onclick: () => this.save({ description: ta.value }) }, t('common.save')),
          h('button', { class: 'btn sm', onclick: view }, t('common.cancel'))));
      ta.focus();
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) this.save({ description: ta.value }); });
    };
    view();
    return box;
  }

  renderSubtasks() {
    const tk = this.task;
    const list = h('div');
    for (const s of tk.subtasks) {
      list.append(h('div', { class: ['subtask', s.completed_at && 'done'] },
        h('button', { class: ['check-btn', s.completed_at && 'on'], 'aria-label': s.completed_at ? t('task.reopen') : t('task.mark_done'), disabled: !this.canEdit,
          onclick: async () => { try { await api.patch(`/tasks/${s.id}`, { completed: !s.completed_at }, s.updated_at); emit('task:changed', { id: s.id }); this.reload(); } catch (e) { showError(e); } } }, icon('check', 11)),
        h('a', { class: 's-title grow ellipsis', href: `#/tasks/${s.id}` }, s.title),
        s.subtask_count ? h('span', { class: 'muted xs' }, `${s.subtask_done}/${s.subtask_count}`) : null,
        h('span', { class: 'due' }, s.due_date ? fmtDate(s.due_date) : ''),
        avatar(s.assignee_name, s.assignee_id)));
    }
    const add = this.fullEdit ? h('input', { class: 'input sm', style: { width: '100%' }, placeholder: t('task.add_subtask'), 'aria-label': t('task.add_subtask'),
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const title = e.target.value.trim();
        e.target.value = '';
        try { await api.post('/tasks', { title, parent_id: tk.id }); emit('task:changed', { id: tk.id }); await this.reload(); this.body.querySelector('[aria-label="' + t('task.add_subtask') + '"]')?.focus(); } catch (err) { showError(err); }
      } }) : null;
    const done = tk.subtasks.filter(s => s.completed_at).length;
    return h('div', null, h('div', { class: 'section-title' }, icon('subtask', 13), t('task.subtasks'), tk.subtasks.length ? h('span', null, `${done}/${tk.subtasks.length}`) : null), list, add);
  }

  renderChecklist() {
    const tk = this.task;
    const items = tk.checklist || [];
    const done = items.filter(i => i.done).length;
    const list = h('div', null, items.map(it => h('div', { class: ['cl-item', it.done && 'done'] },
      h('input', { type: 'checkbox', checked: !!it.done, disabled: !this.canEdit, 'aria-label': it.text, onchange: async (e) => { try { await api.patch(`/checklist/${it.id}`, { done: e.target.checked }, it.updated_at); this.reload(); emit('task:changed', { id: tk.id }); } catch (err) { showError(err); } } }),
      h('span', { class: 'grow' }, it.text),
      this.canEdit ? h('button', { class: 'btn ghost sm icon-only x', 'aria-label': `${t('common.remove')} ${it.text}`, onclick: async () => { try { await api.del(`/checklist/${it.id}`); this.reload(); } catch (err) { showError(err); } } }, icon('x', 12)) : null)));
    const add = this.canEdit ? h('input', { class: 'input sm', style: { width: '100%' }, placeholder: t('task.add_checklist_item'), 'aria-label': t('task.add_checklist_item'),
      onkeydown: async (e) => {
        if (e.key !== 'Enter' || !e.target.value.trim()) return;
        const text = e.target.value.trim(); e.target.value = '';
        try { await api.post(`/tasks/${tk.id}/checklist`, { text }); await this.reload(); this.body.querySelector('[aria-label="' + t('task.add_checklist_item') + '"]')?.focus(); } catch (err) { showError(err); }
      } }) : null;
    return h('div', null,
      h('div', { class: 'section-title' }, icon('check', 13), t('task.checklist'), items.length ? h('span', null, `${done}/${items.length}`) : null),
      items.length ? h('div', { class: 'progress mb-8' }, h('i', { style: { width: `${Math.round(done / items.length * 100)}%` } })) : null,
      list, add);
  }

  renderDependencies() {
    const tk = this.task;
    const line = (d, kind) => h('div', { class: ['subtask', d.completed_at && 'done'] },
      h('span', { class: ['chip', kind === 'blocker' ? (d.completed_at ? 'ok' : 'warn') : 'outline'] }, kind === 'blocker' ? t('task.blocked_by') : t('task.blocks')),
      h('a', { class: 's-title grow ellipsis', href: `#/tasks/${d.id}` }, d.title),
      h('span', { class: 'due' }, d.due_date ? fmtDate(d.due_date) : ''),
      this.fullEdit && kind === 'blocker' ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': t('common.remove'), onclick: async () => { try { await api.del(`/tasks/${tk.id}/dependencies/${d.id}`); this.reload(); emit('task:changed', { id: tk.id }); } catch (e) { showError(e); } } }, icon('x', 12)) : null);
    const add = this.fullEdit && tk.project_id ? h('button', { class: 'btn ghost sm', onclick: (e) => this.pickBlocker(e.currentTarget) }, icon('plus', 13), t('task.add_blocker')) : null;
    return h('div', null, h('div', { class: 'section-title' }, icon('link', 13), t('task.dependencies')),
      tk.blocked_by.map(d => line(d, 'blocker')), tk.blocking.map(d => line(d, 'blocking')),
      !tk.blocked_by.length && !tk.blocking.length ? h('div', { class: 'muted small' }, t('task.no_dependencies')) : null, add);
  }

  async pickBlocker(anchor) {
    try {
      const r = await api.list('/tasks', { project_id: this.task.project_id, state: 'open', limit: 300, sort: 'title' });
      const existing = new Set(this.task.blocked_by.map(b => b.id));
      openMenu(anchor, r.data.filter(x => x.id !== this.task.id && !existing.has(x.id)).map(x => ({ label: x.title, value: x.id, hint: x.due_date ? fmtDate(x.due_date) : '' })),
        { search: true, placeholder: t('task.search_tasks'), onSelect: async (v) => {
          try { await api.post(`/tasks/${this.task.id}/dependencies`, { blocker_id: v }); this.reload(); emit('task:changed', { id: this.task.id }); } catch (e) { showError(e); }
        } });
    } catch (e) { showError(e); }
  }

  async loadAttachments() {
    const box = this.attachmentsBox;
    const tk = this.task;
    try {
      const r = await api.list('/attachments', { object_type: 'task', object_id: tk.id });
      const input = h('input', { type: 'file', class: 'hidden', multiple: true, onchange: async (e) => {
        for (const f of e.target.files) {
          const form = new FormData();
          form.append('object_type', 'task'); form.append('object_id', String(tk.id)); form.append('file', f);
          try { await api.upload('/attachments', form); } catch (err) { showError(err); }
        }
        this.loadAttachments();
      } });
      mount(box, h('div', { class: 'section-title' }, icon('clip', 13), t('task.files'), r.data.length ? h('span', null, String(r.data.length)) : null,
        this.canEdit ? h('button', { class: 'btn ghost sm right', onclick: () => input.click() }, icon('upload', 13), t('task.upload')) : null), input,
        r.data.map(a => h('div', { class: 'subtask' }, icon('clip', 13),
          h('a', { class: 'grow ellipsis', href: `/api/attachments/${a.id}/download`, download: a.filename }, a.filename),
          h('span', { class: 'muted xs' }, `${fmtSize(a.size_bytes)} · ${a.uploaded_by_name || ''} · ${timeAgo(a.created_at)}`),
          (a.uploaded_by === state.me.id || this.project?.access?.manage) ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.remove')} ${a.filename}`, onclick: async () => {
            try { await api.del(`/attachments/${a.id}`); this.loadAttachments(); } catch (e) { showError(e); }
          } }, icon('trash', 13)) : null)));
    } catch (e) { mount(box); }
  }

  async loadComments() {
    const tk = this.task;
    const box = this.commentsBox;
    try {
      const r = await api.list('/comments', { object_type: 'task', object_id: tk.id });
      const ta = h('textarea', { class: 'input', rows: 3, style: { width: '100%' }, placeholder: t('task.comment_placeholder'), 'aria-label': t('task.add_comment'), oninput: (e) => { e.target.dataset.dirty = '1'; } });
      attachMentions(ta, () => this.project?.members || []);
      const send = async () => {
        if (!ta.value.trim()) return;
        try { await api.post('/comments', { object_type: 'task', object_id: tk.id, body: ta.value }); ta.value = ''; ta.dataset.dirty = ''; this.loadComments(); emit('task:changed', { id: tk.id }); } catch (e) { showError(e); }
      };
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
      mount(box, h('div', { class: 'section-title' }, icon('comment', 13), t('task.comments'), r.data.length ? h('span', null, String(r.data.length)) : null),
        r.data.map(c => this.commentEl(c)),
        tk.access.comment ? h('div', { class: 'mt-8' }, ta, h('div', { class: 'row mt-8' }, h('button', { class: 'btn primary sm', onclick: send }, t('task.send_comment')), h('span', { class: 'muted xs' }, t('task.comment_hint')))) : null);
      this.loadActivity();
    } catch (e) { mount(box); }
  }

  commentEl(c) {
    const mine = c.author_id === state.me.id;
    const bodyEl = h('div', { class: 'md', html: md(c.body) });
    const wrap = h('div', { class: 'comment' }, avatar(c.author_name, c.author_id),
      h('div', { class: 'body' },
        h('div', { class: 'row' }, h('span', { class: 'who' }, c.author_name, c.author_external ? h('span', { class: 'chip outline', style: { marginLeft: '6px' } }, t('common.external')) : null,
          h('span', { class: 'when', title: fmtDateTime(c.created_at) }, timeAgo(c.created_at), c.edited_at ? ` · ${t('task.edited')}` : '')),
          mine || this.project?.access?.manage ? h('button', { class: 'btn ghost sm icon-only right', 'aria-label': t('common.more'), onclick: (e) => openMenu(e.currentTarget, [
            mine ? { label: t('common.edit'), icon: 'log', onSelect: () => edit() } : null,
            { label: t('common.delete'), icon: 'trash', danger: true, onSelect: async () => { if (await confirmDialog(t('task.delete_comment_confirm'))) { try { await api.del(`/comments/${c.id}`); this.loadComments(); } catch (err) { showError(err); } } } },
          ].filter(Boolean)) }, icon('more', 14)) : null),
        bodyEl));
    const edit = () => {
      const ta = h('textarea', { class: 'input', rows: 3, style: { width: '100%' } }, c.body);
      attachMentions(ta, () => this.project?.members || []);
      bodyEl.replaceWith(h('div', null, ta, h('div', { class: 'row mt-8' },
        h('button', { class: 'btn primary sm', onclick: async () => { try { await api.patch(`/comments/${c.id}`, { body: ta.value }, c.updated_at); this.loadComments(); } catch (e) { showError(e); } } }, t('common.save')),
        h('button', { class: 'btn sm', onclick: () => this.loadComments() }, t('common.cancel')))));
      ta.focus();
    };
    return wrap;
  }

  async loadActivity() {
    const box = this.activityBox;
    try {
      const r = await api.list('/activity', { task_id: this.task.id, limit: 30 });
      const items = r.data.filter(a => a.verb !== 'comment.added');
      if (!items.length) { mount(box); return; }
      const list = h('div', { class: 'hidden' }, items.map(a => h('div', { class: 'activity-item' }, `${a.actor_name || t('common.someone')} ${activityVerb(a)} · ${timeAgo(a.at)}`)));
      mount(box, h('div', { class: 'section-title' }, icon('clock', 13),
        h('button', { class: 'btn ghost sm', 'aria-expanded': 'false', onclick: (e) => { list.classList.toggle('hidden'); e.currentTarget.setAttribute('aria-expanded', String(!list.classList.contains('hidden'))); } }, t('task.history'), ` (${items.length})`)), list);
    } catch { mount(box); }
  }

  async toggleFollow() {
    try {
      if (this.task.following) await api.del(`/tasks/${this.task.id}/followers/${state.me.id}`);
      else await api.post(`/tasks/${this.task.id}/followers`, {});
      toast(this.task.following ? t('task.unfollowed') : t('task.followed'), { ms: 1800 });
      this.reload();
    } catch (e) { showError(e); }
  }

  moreMenu(anchor) {
    const tk = this.task;
    openMenu(anchor, [
      this.fullEdit ? { label: t('task.duplicate'), icon: 'copy', onSelect: async () => { try { const n = await api.post(`/tasks/${tk.id}/duplicate`); emit('task:changed', n); location.hash = `#/tasks/${n.id}`; } catch (e) { showError(e); } } } : null,
      this.fullEdit && tk.parent_id ? { label: t('task.detach'), icon: 'subtask', onSelect: () => this.save({ parent_id: null }) } : null,
      this.fullEdit ? { label: t('task.move_to_project'), icon: 'folder', onSelect: () => this.moveDialog() } : null,
      { sep: true },
      this.fullEdit ? { label: t('common.delete'), icon: 'trash', danger: true, onSelect: () => this.remove() } : null,
    ].filter(Boolean));
  }

  async moveDialog() {
    try {
      const r = await api.list('/projects', { member: 'me', limit: 100 });
      openMenu(this.head, [{ label: t('task.personal'), value: null }, ...r.data.filter(p => p.id !== this.task.project_id && ['pm', 'member'].includes(p.my_role)).map(p => ({ label: p.name, value: p.id, hint: p.code }))],
        { search: true, onSelect: (v) => this.save({ project_id: v }).then(() => { if (v) invalidateProject(v); }) });
    } catch (e) { showError(e); }
  }

  async remove() {
    const tk = this.task;
    if (!await confirmDialog(t('common.confirm_delete', { name: tk.title }))) return;
    try {
      await api.del(`/tasks/${tk.id}`);
      emit('task:deleted', { id: tk.id });
      closeTaskDrawer();
      toast(t('task.deleted'), { action: async () => { try { await api.post(`/tasks/${tk.id}/restore`); emit('task:changed', { id: tk.id }); } catch (e) { showError(e); } } });
    } catch (e) { showError(e); }
  }

  recurrenceDialog() {
    const r = this.task.recurrence || { freq: 'weekly', interval_n: 1, mode: 'schedule' };
    const fields = [
      { name: 'freq', label: t('task.rec_freq'), type: 'select', value: r.freq, options: ['daily', 'weekly', 'monthly', 'yearly'].map(v => ({ value: v, label: t('task.rec_' + v) })) },
      { name: 'interval_n', label: t('task.rec_interval'), type: 'number', value: r.interval_n || 1, min: 1, max: 52, required: true },
      { name: 'by_weekday', label: t('task.rec_weekdays'), value: r.by_weekday || '', hint: t('task.rec_weekdays_hint') },
      { name: 'by_monthday', label: t('task.rec_monthday'), type: 'number', value: r.by_monthday ?? '', min: -1, max: 28, hint: t('task.rec_monthday_hint') },
      { name: 'mode', label: t('task.rec_mode'), type: 'select', value: r.mode, options: [{ value: 'schedule', label: t('task.rec_mode_schedule') }, { value: 'completion', label: t('task.rec_mode_completion') }] },
      { name: 'until_date', label: t('task.rec_until'), type: 'date', value: r.until_date || '' },
    ];
    formDialog({
      title: t('task.repeats'), fields, submitLabel: t('common.save'),
      intro: h('p', { class: 'muted small' }, t('task.rec_explain')),
      extraFooter: this.task.recurrence ? (close) => [h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        try { await api.del(`/tasks/${this.task.id}/recurrence`); close(); this.reload(); } catch (e) { showError(e); }
      } }, t('task.rec_stop'))] : null,
      onSubmit: async (v) => {
        const body = { freq: v.freq, interval_n: v.interval_n || 1, mode: v.mode, by_weekday: v.by_weekday || null, by_monthday: v.by_monthday ?? null, until_date: v.until_date || null };
        await api.put(`/tasks/${this.task.id}/recurrence`, body);
        this.reload();
      },
    });
  }
}

function recurrenceText(r) {
  const every = r.interval_n > 1 ? t('task.rec_every_n', { n: r.interval_n, unit: t('task.rec_unit_' + r.freq) }) : t('task.rec_' + r.freq);
  return r.mode === 'completion' ? `${every} · ${t('task.rec_after_completion')}` : every;
}

function activityVerb(a) {
  const p = a.payload || {};
  const key = 'activity.' + a.verb.replace('.', '_');
  return t(key, { title: p.title || a.task_title || '', name: p.name || '', blocker: p.blocker || '', text: p.text || '', filename: p.filename || '' });
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function escapeText(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

// @mention autocomplete for a textarea. Inserts @[Name](user:ID), which the
// server parses into mentions and notifications.
export function attachMentions(ta, getPeople) {
  ta.addEventListener('input', () => {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const m = /(^|\s)@([\p{L}\p{N}._-]{0,30})$/u.exec(before);
    if (!m) { closeMenu(); return; }
    const q = m[2].toLowerCase();
    const people = getPeople().filter(p => p.name.toLowerCase().includes(q)).slice(0, 8);
    if (!people.length) { closeMenu(); return; }
    const menu = openMenu(ta, people.map(p => ({ label: p.name, value: p, icon: avatar(p.name, p.user_id) })), {
      onSelect: (p) => {
        const start = pos - m[2].length - 1;
        const token = `@[${p.name}](user:${p.user_id}) `;
        ta.value = ta.value.slice(0, start) + token + ta.value.slice(pos);
        ta.focus();
        ta.selectionStart = ta.selectionEnd = start + token.length;
      },
    });
    // keep typing in the textarea; arrow keys handled below
    ta.focus();
    ta._mentionMenu = menu;
  });
  ta.addEventListener('keydown', (e) => {
    const menu = document.querySelector('.menu');
    if (!menu || !ta._mentionMenu || menu !== ta._mentionMenu) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(e.key)) {
      e.preventDefault();
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: e.key === 'Enter' ? 'Enter' : e.key, bubbles: true }));
      if (e.key === 'Enter') { const act = menu.querySelector('.mi.active'); act?.click(); }
    }
  });
}

// ---- quick add ------------------------------------------------------------

export async function quickAddDialog(defaults = {}) {
  let projects = [];
  try { projects = (await api.list('/projects', { member: 'me', limit: 100, sort: 'name' })).data.filter(p => ['pm', 'member'].includes(p.my_role)); } catch {}
  formDialog({
    title: t('nav.quick_add'),
    submitLabel: t('common.create'),
    fields: [
      { name: 'title', label: t('common.title'), required: true, value: defaults.title || '' },
      { name: 'project_id', label: t('task.project'), type: 'select', numeric: true, value: defaults.project_id ?? '', options: [{ value: '', label: t('task.personal') }, ...projects.map(p => ({ value: p.id, label: p.code ? `${p.code} — ${p.name}` : p.name }))] },
      { name: 'due_date', label: t('task.due_date'), type: 'date', value: defaults.due_date || '' },
      { name: 'assign_me', label: t('task.assign_to_me'), type: 'checkbox', value: defaults.assign_me !== false },
    ],
    onSubmit: async (v) => {
      const body = { title: v.title, project_id: v.project_id || null, due_date: v.due_date || null };
      if (v.assign_me) body.assignee_id = state.me.id;
      if (defaults.section_id && v.project_id === defaults.project_id) body.section_id = defaults.section_id;
      const task = await api.post('/tasks', body);
      emit('task:changed', task);
      toast(t('task.created_toast'), { action: () => { location.hash = `#/tasks/${task.id}`; }, actionLabel: t('common.open') });
    },
  });
}
