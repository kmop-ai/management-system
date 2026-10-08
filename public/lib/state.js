// Session state and small shared lookups. Loaded once from /api/me at boot;
// views read from here instead of refetching configuration.

import { t as translate, STRINGS } from './strings.js';

export const state = {
  me: null,          // the signed-in user
  access: null,      // { roles, modules, projects: {id: role}, people_metrics_self_visible }
  entities: [],
  departments: [],
  statuses: [],
  roles: [],
  modules: [],
  unread: 0,
  devMode: false,
  locale: 'en',
};

export function setBootstrap(d) {
  state.me = d.user;
  state.access = d.access;
  state.entities = d.entities;
  state.departments = d.departments;
  state.statuses = d.statuses;
  state.roles = d.roles;
  state.modules = d.modules;
  state.unread = d.unread;
  state.devMode = d.dev_mode;
  state.locale = d.user.locale || 'en';
  document.documentElement.lang = state.locale;
}

export const t = (key, vars) => translate(state.locale, key, vars);
export const hasString = (key) => !!STRINGS[key];

// Module level anywhere (0–3). Fine-grained checks happen server-side; this
// only decides what to show.
export const can = (module, level = 1) => (state.access?.modules?.[module] || 0) >= level;
export const projectRole = (id) => state.access?.projects?.[id] || null;

export const statusByKey = (k) => state.statuses.find(s => s.key === k);
export const statusLabel = (k) => { const s = statusByKey(k); return s ? (state.locale === 'el' ? s.label_el : s.label_en) : k; };
export const entityById = (id) => state.entities.find(e => e.id === id);
export const deptById = (id) => state.departments.find(d => d.id === id);
export const deptName = (d) => d ? (state.locale === 'el' && d.name_el ? d.name_el : d.name) : '';
export const roleLabel = (key) => { const r = state.roles.find(x => x.key === key); return r ? (state.locale === 'el' ? r.label_el : r.label_en) : key; };
export const moduleLabel = (key) => { const m = state.modules.find(x => x.key === key); return m ? (state.locale === 'el' ? m.label_el : m.label_en) : key; };

// A tiny event bus: views emit 'task:changed' so open lists can refresh
// the one row instead of reloading.
const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= new Set()).add(fn); return () => listeners[evt].delete(fn); }
export function emit(evt, data) { for (const fn of listeners[evt] || []) { try { fn(data); } catch (e) { console.error(e); } } }

// Per-viewer conveniences (last tab, collapsed groups). Never the only copy
// of anything that matters.
export const local = {
  get(k, fallback = null) { try { const v = localStorage.getItem('kmop.' + k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem('kmop.' + k, JSON.stringify(v)); } catch {} },
};
