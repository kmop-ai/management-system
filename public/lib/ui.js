// Shared UI pieces: toasts, dialogs, menus/pickers, avatars, pills, dates.
// Everything keyboard-reachable: dialogs trap focus and restore it, menus
// take arrow keys / Enter / Escape and type-to-filter.

import { h, icon, todayStr, parseDate, daysBetween, projectMonth } from './dom.js';
import { state, t, statusByKey, statusLabel } from './state.js';
import { ApiError } from './api.js';

// ---- toasts ---------------------------------------------------------------

export function toast(message, { error = false, action, actionLabel, ms = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const el = h('div', { class: ['toast', error && 'error'], role: error ? 'alert' : 'status' }, message,
    action ? h('button', { onclick: () => { action(); el.remove(); } }, actionLabel || t('common.undo')) : null);
  box.appendChild(el);
  setTimeout(() => el.remove(), action ? Math.max(ms, 7000) : ms);
}

export function errorText(e) {
  if (e instanceof ApiError) {
    if (e.code === 'offline') return t('common.offline');
    if (e.code === 'conflict') return t('common.conflict');
    if (e.code === 'forbidden') return e.message || t('common.forbidden');
    if (e.code === 'validation_failed' && e.details?.fields) return Object.entries(e.details.fields).map(([k, v]) => `${k}: ${v}`).join('; ');
    return e.message;
  }
  return t('common.error');
}

export function showError(e) {
  console.error(e);
  toast(errorText(e), { error: true });
}

// ---- dialogs --------------------------------------------------------------

export function modal({ title, body, footer, wide = false, onClose } = {}) {
  const prev = document.activeElement;
  const dlg = h('dialog', { class: ['modal', wide && 'wide'], 'aria-labelledby': 'modal-title' });
  const close = () => { dlg.close(); };
  dlg.append(
    h('div', { class: 'modal-head' }, h('h2', { id: 'modal-title', class: 'grow' }, title),
      h('button', { class: 'btn ghost icon-only', 'aria-label': t('common.close'), onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  dlg.addEventListener('close', () => { dlg.remove(); onClose && onClose(); if (prev && prev.focus) prev.focus(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  const first = dlg.querySelector('input:not([type=hidden]), textarea, select, .modal-body button');
  if (first) first.focus();
  return { el: dlg, close };
}

export function confirmDialog(message, { okLabel, danger = true } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title: t('common.confirm'),
      body: h('p', null, message),
      footer: [
        h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(false); } }, t('common.cancel')),
        h('button', { class: ['btn', danger ? 'danger' : 'primary'], onclick: () => { done = true; m.close(); resolve(true); } }, okLabel || t('common.delete')),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

// A form inside a modal. fields: [{name, label, type, value, options, required, hint}]
export function formDialog({ title, fields, submitLabel, onSubmit, wide, extraFooter, intro }) {
  const inputs = {};
  const errors = {};
  const form = h('form', { class: 'col gap-12', onsubmit: async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      const el = inputs[f.name];
      if (f.type === 'checkbox') values[f.name] = el.checked;
      else if (f.type === 'number') values[f.name] = el.value === '' ? null : Number(el.value);
      else if (f.type === 'select' && f.numeric) values[f.name] = el.value === '' ? null : Number(el.value);
      else values[f.name] = el.value === '' ? (f.emptyAs !== undefined ? f.emptyAs : null) : el.value;
    }
    for (const k in errors) errors[k].textContent = '';
    submit.disabled = true;
    try { await onSubmit(values); m.close(); }
    catch (err) {
      if (err instanceof ApiError && err.details?.fields) {
        for (const [k, v] of Object.entries(err.details.fields)) if (errors[k]) errors[k].textContent = v; else showError(err);
      } else showError(err);
    } finally { submit.disabled = false; }
  } });
  for (const f of fields) {
    const id = 'f-' + f.name + '-' + Math.random().toString(36).slice(2, 7);
    let input;
    if (f.type === 'select') {
      input = h('select', { class: 'input', id, required: f.required }, (f.options || []).map(o => h('option', { value: o.value ?? '', selected: String(o.value ?? '') === String(f.value ?? '') }, o.label)));
    } else if (f.type === 'textarea') {
      input = h('textarea', { class: 'input', id, rows: f.rows || 4, required: f.required, placeholder: f.placeholder }, f.value ?? '');
    } else if (f.type === 'checkbox') {
      input = h('input', { type: 'checkbox', id, checked: !!f.value });
    } else {
      input = h('input', { class: 'input', id, type: f.type || 'text', value: f.value ?? '', required: f.required, placeholder: f.placeholder, min: f.min, max: f.max, step: f.step, autocomplete: 'off' });
    }
    inputs[f.name] = input;
    errors[f.name] = h('div', { class: 'error', 'aria-live': 'polite' });
    form.append(f.type === 'checkbox'
      ? h('div', { class: 'field' }, h('label', { class: 'checkbox', for: id }, input, f.label), f.hint ? h('div', { class: 'hint' }, f.hint) : null, errors[f.name])
      : h('div', { class: 'field' }, h('label', { for: id }, f.label, f.required ? '' : h('span', { class: 'muted' }, ` (${t('common.optional')})`)), input, f.hint ? h('div', { class: 'hint' }, f.hint) : null, errors[f.name]));
  }
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel || t('common.save'));
  form.append(h('button', { type: 'submit', class: 'hidden', tabindex: -1 }));
  if (intro) form.prepend(intro);
  const m = modal({ title, body: form, wide, footer: [...(extraFooter ? extraFooter(() => m.close()) : []), h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('common.cancel')), submit] });
  submit.addEventListener('click', () => form.requestSubmit());
  return m;
}

// ---- menus / pickers ------------------------------------------------------
//
// openMenu(anchor, items) where items are {label, value, icon, checked,
// danger, onSelect, sep, head}. With {search: true} a filter box is shown.

let openMenuEl = null;
export function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }

export function openMenu(anchor, items, { search = false, placeholder, onSelect, width } = {}) {
  closeMenu();
  const prev = document.activeElement;
  const menu = h('div', { class: 'menu', role: 'menu', style: width ? { minWidth: width + 'px' } : null });
  let active = 0;
  let visible = [];
  const input = search ? h('input', { class: 'input sm msearch', placeholder: placeholder || t('common.search'), 'aria-label': t('common.search') }) : null;
  const list = h('div');
  if (input) menu.append(input);
  menu.append(list);
  const render = () => {
    const q = input ? input.value.trim().toLowerCase() : '';
    visible = [];
    list.replaceChildren();
    for (const it of items) {
      if (it.sep) { if (!q) list.append(h('div', { class: 'msep' })); continue; }
      if (it.head) { if (!q) list.append(h('div', { class: 'mhead' }, it.head)); continue; }
      if (q && !String(it.label).toLowerCase().includes(q) && !(it.keywords || '').toLowerCase().includes(q)) continue;
      const idx = visible.length;
      const btn = h('button', { class: ['mi', it.danger && 'danger-text'], role: it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': it.checked !== undefined ? String(!!it.checked) : null,
        onclick: (e) => { e.stopPropagation(); choose(it); }, onmouseenter: () => { active = idx; mark(); } }, it.icon ? (typeof it.icon === 'string' ? icon(it.icon, 14) : it.icon) : null, h('span', { class: 'ellipsis' }, it.label), it.hint ? h('span', { class: 'muted xs right' }, it.hint) : null);
      visible.push({ it, btn });
      list.append(btn);
    }
    if (!visible.length) list.append(h('div', { class: 'muted small', style: { padding: '6px 8px' } }, t('common.empty')));
    active = Math.min(active, Math.max(visible.length - 1, 0));
    mark();
  };
  const mark = () => visible.forEach((v, i) => v.btn.classList.toggle('active', i === active));
  const choose = (it) => {
    if (it.disabled) return;
    if (!it.keepOpen) closeMenu();
    if (it.onSelect) it.onSelect(it.value, it);
    else if (onSelect) onSelect(it.value, it);
    if (!it.keepOpen && prev && prev.focus && document.contains(prev)) prev.focus();
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = (active + 1) % Math.max(visible.length, 1); mark(); visible[active]?.btn.scrollIntoView({ block: 'nearest' }); if (!input) visible[active]?.btn.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = (active - 1 + visible.length) % Math.max(visible.length, 1); mark(); visible[active]?.btn.scrollIntoView({ block: 'nearest' }); if (!input) visible[active]?.btn.focus(); e.preventDefault(); }
    else if (e.key === 'Enter' && input && document.activeElement === input) { if (visible[active]) choose(visible[active].it); e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenu(); if (prev && prev.focus) prev.focus(); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'Tab') closeMenu();
  });
  if (input) input.addEventListener('input', () => { active = 0; render(); });
  render();
  document.body.appendChild(menu);
  openMenuEl = menu;
  // position
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8), top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  (input || visible[0]?.btn)?.focus();
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  function outside(e) { if (!menu.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', outside, true); } }
  return menu;
}

// ---- small renderers ------------------------------------------------------

const AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#059669', '#d97706', '#0891b2', '#4f46e5', '#be123c', '#15803d', '#a16207'];
export function initials(name) {
  if (!name) return '?';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
export function avatar(name, id, { size, title } = {}) {
  if (!name) return h('span', { class: 'avatar empty', title: title || t('common.nobody') }, icon('user', 12));
  return h('span', { class: ['avatar', size === 'lg' && 'lg'], style: { background: AVATAR_COLORS[(id || name.length) % AVATAR_COLORS.length] }, title: title || name, 'aria-hidden': 'true' }, initials(name));
}

export function statusPill(key) {
  const s = statusByKey(key);
  return h('span', { class: 'status-pill', style: { '--c': s?.color || '#9ca3af' } }, statusLabel(key));
}

const PRIO_ICON = { urgent: '!!', high: '↑', medium: '•', low: '↓' };
export function prioIcon(p) {
  if (!p || p === 'none') return h('span', { class: 'prio' });
  return h('span', { class: ['prio', p], title: t('task.priority_' + p) }, PRIO_ICON[p]);
}

export function labelChip(l, onRemove) {
  return h('span', { class: 'chip label', style: { background: l.color || '#6b7280' } }, l.name,
    onRemove ? h('button', { 'aria-label': `${t('common.remove')} ${l.name}`, onclick: (e) => { e.stopPropagation(); onRemove(l); } }, '×') : null);
}

// ---- dates ----------------------------------------------------------------

const intlLocale = () => state.locale === 'el' ? 'el-GR' : 'en-GB';

export function fmtDate(s, { year, weekday } = {}) {
  if (!s) return '';
  const d = parseDate(s.slice(0, 10));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', year: year || !sameYear ? 'numeric' : undefined, weekday: weekday ? 'short' : undefined }).format(d);
}

export function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function relDay(s) {
  if (!s) return '';
  const diff = daysBetween(todayStr(), s.slice(0, 10));
  if (diff === 0) return t('common.today');
  if (diff === 1) return t('common.tomorrow');
  if (diff === -1) return t('common.yesterday');
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(intlLocale(), { weekday: 'long' }).format(parseDate(s));
  return fmtDate(s);
}

export function timeAgo(iso) {
  if (!iso) return '';
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: 'auto' });
  if (sec < 60) return rtf.format(0, 'second');
  if (sec < 3600) return rtf.format(-Math.round(sec / 60), 'minute');
  if (sec < 86400) return rtf.format(-Math.round(sec / 3600), 'hour');
  if (sec < 86400 * 7) return rtf.format(-Math.round(sec / 86400), 'day');
  return fmtDate(iso.slice(0, 10));
}

export function dueBadge(task, { projectStart, range = false } = {}) {
  if (!task.due_date) return h('span', { class: 'due muted' });
  const today = todayStr();
  const done = !!task.completed_at;
  const cls = done ? 'done' : task.due_date < today ? 'overdue' : task.due_date === today ? 'today' : '';
  const m = projectStart ? projectMonth(projectStart, task.due_date) : null;
  const from = range && task.start_date && task.start_date !== task.due_date ? `${fmtDate(task.start_date)} – ` : '';
  return h('span', { class: ['due', cls], title: `${task.start_date ? fmtDate(task.start_date, { year: true }) + ' → ' : ''}${fmtDate(task.due_date, { year: true })}${m ? ` · M${m}` : ''}` },
    from + relDay(task.due_date), m && m > 0 ? h('span', { class: 'pm-tag' }, ` M${m}`) : null);
}

export function emptyState(message, iconName = 'check', action) {
  return h('div', { class: 'empty' }, icon(iconName, 28), h('div', null, message), action ? h('div', { class: 'mt-8' }, action) : null);
}

export function spinner() { return h('div', { class: 'loading-page' }, h('span', { class: 'spinner', role: 'progressbar', 'aria-label': t('common.loading') })); }

export function hours(n) {
  if (n == null) return '';
  const v = Math.round(n * 10) / 10;
  return `${v}${t('common.hours_short')}`;
}

// Copies text, with a toast.
export async function copyText(s) {
  try { await navigator.clipboard.writeText(s); toast(t('common.copied')); } catch { toast(s); }
}
