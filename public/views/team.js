// Team and Access (super admin only).
// Tabs: People and access · Sign-in log · Integrations · Organisation.

import { h, mount, icon } from '../lib/dom.js';
import { api, listAll } from '../lib/api.js';
import { state, t } from '../lib/state.js';
import { modal, formDialog, toast, showError, errorText, fmtDateTime, timeAgo, copyText, avatar } from '../lib/ui.js';
import { listPage } from '../lib/listpage.js';

const TABS = ['people', 'signins', 'integrations', 'organisation'];

export default async function team(root, params, query) {
  const tab = TABS.includes(params.tab) ? params.tab : 'people';
  const body = h('div');
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('page.team'))),
    h('nav', { class: 'tabs', 'aria-label': t('page.team') }, TABS.map(x => h('a', { href: `#/team${x === 'people' ? '' : '/' + x}`, 'aria-current': x === tab ? 'page' : null }, t('team.tab_' + x)))),
    body));
  if (tab === 'people') return peopleTab(body);
  if (tab === 'signins') return signinsTab(body);
  if (tab === 'integrations') return integrationsTab(body, query);
  return organisationTab(body);
}

// ---- people and access -------------------------------------------------------

const roleLabel = (r) => t('role.' + r);

async function peopleTab(el) {
  const r = await api.list('/team');
  const rows = r.data, modules = r.meta.modules.filter(m => m.grantable);
  const top = h('div', { class: 'row mb-8' }, h('p', { class: 'muted small grow' }, t('team.people_lead')),
    h('button', { class: 'btn primary', onclick: () => addPerson(() => peopleTab(el)) }, icon('plus', 14), t('team.add_person')));
  const listEl = h('div');
  mount(el, top, listEl);
  const moduleText = (u) => {
    if (u.role === 'super_admin') return t('team.all_modules');
    if (u.role === 'admin') return t('team.all_but_team');
    const keys = Object.keys(u.grants);
    return keys.length ? keys.map(k => `${t('page.' + k)}${u.grants[k] === 'read' ? ' (' + t('team.read') + ')' : ''}`).join(', ') : t('team.no_modules');
  };
  listPage(listEl, {
    what: t('team.what_people'), rows, state: 'team.people',
    tiles: [
      { key: 'active', label: t('team.tile_active'), sub: t('team.tile_active_sub'), test: u => !!u.active },
      { key: 'admins', label: t('team.tile_admins'), sub: t('team.tile_admins_sub'), test: u => u.active && (u.role === 'super_admin' || u.role === 'admin') },
      { key: 'supervisors', label: t('team.tile_supervisors'), sub: t('team.tile_supervisors_sub'), test: u => u.active && u.role === 'supervisor' },
      { key: 'never', label: t('team.tile_never'), sub: t('team.tile_never_sub'), test: u => u.active && !u.last_login_at },
      { key: 'inactive', label: t('team.tile_inactive'), sub: t('team.tile_inactive_sub'), test: u => !u.active },
    ],
    filters: [
      { key: 'role', label: t('team.role'), options: r.meta.roles.map(x => ({ value: x, label: roleLabel(x) })), test: (u, v) => u.role === v },
      { key: 'module', label: t('team.module'), options: modules.map(m => ({ value: m.key, label: t('page.' + m.key) })), test: (u, v) => u.role === 'super_admin' || u.role === 'admin' || !!u.grants[v] },
    ],
    search: u => `${u.name} ${u.email} ${u.title || ''} ${u.external_org || ''}`,
    columns: [
      { key: 'name', label: t('common.name'), width: '26%', value: u => u.name, sub: u => [u.email, u.title, u.external_org].filter(Boolean).join(' · '),
        render: u => h('span', { class: 'row gap-4' }, avatar(u.name, u.id), u.name) },
      { key: 'role', label: t('team.role'), width: '13%', value: u => roleLabel(u.role) + (u.role_from_config ? ' 🔒' : '') },
      { key: 'modules', label: t('team.modules'), width: '25%', value: moduleText },
      { key: 'projects', label: t('team.projects'), width: '14%', value: u => u.role === 'supervisor' ? (u.projects.map(p => p.code || p.name).join(', ') || t('team.no_projects')) : '—' },
      { key: 'methods', label: t('team.signs_in_with'), width: '10%', value: u => u.sign_in_methods.map(m => t('team.method_' + m)).join(', ') || '—' },
      { key: 'last', label: t('team.last_sign_in'), width: '12%', value: u => u.last_login_at ? timeAgo(u.last_login_at) : t('team.never') },
    ],
    stripe: u => !u.active ? 'muted' : u.role === 'supervisor' ? 'accent' : !u.last_login_at ? 'warn' : null,
    action: { label: () => t('team.edit_access'), onClick: u => editAccess(u, modules, () => peopleTab(el)) },
    onOpen: u => editAccess(u, modules, () => peopleTab(el)),
  });
}

async function editAccess(u, modules, done) {
  let projects = [];
  try { projects = await listAll('/projects', { archived: 'all' }); } catch {}
  const roleSel = h('select', { class: 'input', id: 'ea-role', disabled: u.role_from_config || u.id === state.me.id }, ['super_admin', 'admin', 'member', 'supervisor'].map(x => h('option', { value: x, selected: x === u.role }, roleLabel(x))));
  const grid = h('table', { class: 'access-grid' });
  const projBox = h('div', { class: 'col gap-4' });
  const grants = { ...u.grants };
  const draw = () => {
    const role = roleSel.value;
    const full = role === 'super_admin' || role === 'admin';
    mount(grid, h('thead', null, h('tr', null, h('th', null, t('team.module')), ['none', 'read', 'write'].map(x => h('th', { class: 'opt' }, t('team.access_' + x))))),
      h('tbody', null, modules.map(m => {
        const supOk = m.supervisor;
        const cur = full ? 'write' : grants[m.key] || 'none';
        return h('tr', null, h('td', null, t('page.' + m.key), !m.built ? h('span', { class: 'muted xs' }, ` — ${t('team.not_built')}`) : null, role === 'supervisor' && !supOk ? h('span', { class: 'muted xs' }, ` — ${t('team.not_for_supervisors')}`) : null),
          ['none', 'read', 'write'].map(x => h('td', { class: 'opt' }, h('input', { type: 'radio', name: 'g-' + m.key, value: x, 'aria-label': `${t('page.' + m.key)}: ${t('team.access_' + x)}`, checked: cur === x,
            disabled: full || (role === 'supervisor' && (x === 'write' || (!supOk && x !== 'none'))),
            onchange: () => { grants[m.key] = x === 'none' ? null : x; } }))));
      })));
  };
  roleSel.addEventListener('change', () => {
    if (roleSel.value === 'supervisor') for (const k of Object.keys(grants)) if (grants[k] === 'write') grants[k] = 'read';
    draw();
  });
  const selected = new Set(u.projects.map(p => p.id));
  mount(projBox, projects.map(p => h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: selected.has(p.id), onchange: (e) => { if (e.target.checked) selected.add(p.id); else selected.delete(p.id); } }), p.code ? `${p.code} — ${p.name}` : p.name)));
  const projSection = h('div', { class: 'mt-16' }, h('h3', { class: 'mb-8' }, t('team.supervised_projects')), h('p', { class: 'muted xs mb-8' }, t('team.supervised_hint')), projBox);
  const inviteMsg = h('div', { 'aria-live': 'polite' });
  const m = modal({
    title: t('team.access_for', { name: u.name }), wide: true,
    body: h('div', null,
      h('p', { class: 'muted small mb-8' }, u.email),
      h('div', { class: 'field mb-16' }, h('label', { for: 'ea-role' }, t('team.role')), roleSel,
        u.role_from_config ? h('div', { class: 'hint' }, t('team.role_from_config')) : u.id === state.me.id ? h('div', { class: 'hint' }, t('team.own_role')) : h('div', { class: 'hint' }, t('team.role_hint'))),
      h('h3', { class: 'mb-8' }, t('team.modules')), grid, projSection,
      h('div', { class: 'mt-16 row wrap' }, u.active ? h('button', { class: 'btn', type: 'button', onclick: async () => {
        try {
          const r = await api.post(`/team/${u.id}/invite`);
          mount(inviteMsg, h('div', { class: ['banner', r.sent ? 'info' : 'danger'] }, r.sent ? t('team.invite_sent', { email: u.email }) : t('team.invite_failed', { error: r.error || '' }),
            r.dev_link ? h('div', null, h('a', { href: r.dev_link.replace(/^https?:\/\/[^/]+/, '') }, 'dev link')) : null));
        } catch (e) { showError(e); }
      } }, icon('link', 14), t('team.email_link')) : null, h('a', { class: 'btn ghost', href: `#/people/${u.id}` }, t('team.profile'))),
      inviteMsg),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, t('common.cancel')),
      h('button', { class: 'btn primary', onclick: async () => {
        try {
          const g = {};
          for (const mod of modules) g[mod.key] = grants[mod.key] || null;
          await api.put(`/team/${u.id}/access`, { role: roleSel.value, grants: g, project_ids: roleSel.value === 'supervisor' ? [...selected] : [] });
          toast(t('common.saved')); m.close(); done();
        } catch (e) { showError(e); }
      } }, t('common.save'))],
  });
  draw();
  projSection.hidden = roleSel.value !== 'supervisor';
  roleSel.addEventListener('change', () => { projSection.hidden = roleSel.value !== 'supervisor'; });
}

function addPerson(done) {
  formDialog({
    title: t('team.add_person'),
    intro: h('p', { class: 'muted small' }, t('team.add_person_hint')),
    fields: [
      { name: 'name', label: t('common.name'), required: true },
      { name: 'email', label: t('common.email'), type: 'email', required: true },
      { name: 'role', label: t('team.role'), type: 'select', value: 'member', options: ['member', 'admin', 'supervisor', 'super_admin'].map(x => ({ value: x, label: roleLabel(x) })) },
      { name: 'external_org', label: t('team.external_org'), hint: t('team.external_org_hint') },
      { name: 'locale', label: t('nav.language'), type: 'select', value: 'el', options: [{ value: 'el', label: 'Ελληνικά' }, { value: 'en', label: 'English' }] },
      { name: 'send_invite', label: t('team.send_invite'), type: 'checkbox', value: true, hint: t('team.send_invite_hint') },
    ],
    submitLabel: t('common.add'),
    onSubmit: async (v) => {
      const body = { name: v.name, email: v.email, role: v.role, locale: v.locale, send_invite: v.send_invite };
      if (v.external_org) { body.external_org = v.external_org; body.is_external = v.role === 'supervisor'; }
      const u = await api.post('/users', body);
      if (u.invite) toast(u.invite.sent ? t('team.invite_sent', { email: u.email }) : t('team.invite_failed', { error: u.invite.error || '' }), { error: !u.invite.sent, ms: 8000 });
      else toast(t('common.saved'));
      done();
    },
  });
}

// ---- sign-in log ---------------------------------------------------------------

async function signinsTab(el) {
  const r = await api.list('/team/auth-events', { limit: 500 });
  const lead = h('p', { class: 'muted small mb-8' }, t('team.signins_lead'));
  const listEl = h('div');
  mount(el, lead, listEl);
  const problem = (e) => !['sent', 'signed_in'].includes(e.outcome);
  listPage(listEl, {
    what: t('team.what_events'), rows: r.data, state: 'team.signins',
    tiles: [
      { key: 'problems', label: t('team.tile_problems'), sub: t('team.tile_problems_sub'), test: problem },
      { key: 'sent', label: t('team.tile_sent'), sub: t('team.tile_sent_sub'), test: e => e.outcome === 'sent' },
      { key: 'signed', label: t('team.tile_signed'), sub: t('team.tile_signed_sub'), test: e => e.outcome === 'signed_in' },
    ],
    filters: [
      { key: 'method', label: t('team.method'), options: [{ value: 'link', label: t('team.method_email') }, { value: 'google', label: t('team.method_google') }], test: (e, v) => e.method === v },
    ],
    search: e => `${e.email || ''} ${e.user_name || ''} ${e.detail || ''}`,
    columns: [
      { key: 'at', label: t('team.when'), width: '16%', value: e => fmtDateTime(e.at) },
      { key: 'who', label: t('team.who'), width: '24%', value: e => e.user_name || e.email || '—', sub: e => e.user_name ? e.email : null },
      { key: 'method', label: t('team.method'), width: '10%', value: e => t('team.method_' + (e.method === 'link' ? 'email' : e.method)) },
      { key: 'outcome', label: t('team.outcome'), width: '15%', value: e => t('team.outcome_' + e.outcome) },
      { key: 'detail', label: t('team.detail'), width: '35%', value: e => e.detail || '' },
    ],
    stripe: e => problem(e) ? 'danger' : 'ok',
  });
}

// ---- integrations ----------------------------------------------------------------

async function integrationsTab(el, query) {
  const d = await api.get('/integrations');
  const banner = query.connected ? h('div', { class: 'banner info mb-16' }, t('team.mailbox_connected')) : query.error ? h('div', { class: 'banner danger mb-16' }, t('team.connect_failed', { error: query.error })) : null;
  const cid = h('input', { class: 'input', id: 'g-cid', value: d.google_oauth.client_id || '', style: { width: '100%' }, placeholder: '…apps.googleusercontent.com' });
  const sec = h('input', { class: 'input', id: 'g-sec', type: 'password', style: { width: '100%' }, placeholder: d.google_oauth.configured ? t('team.secret_kept') : '' });
  const testMsg = h('div', { 'aria-live': 'polite' });
  const step = (n, title, ...body) => h('section', { class: 'card pad' }, h('h2', { class: 'mb-8' }, `${n}. ${title}`), ...body);
  mount(el, banner, h('div', { class: 'col gap-16', style: { maxWidth: '860px' } },
    step(1, t('team.google_client'),
      h('p', { class: 'small' }, t('team.google_client_lead')),
      h('ol', { class: 'small' }, h('li', null, t('team.gc_step1')), h('li', null, t('team.gc_step2')), h('li', null, t('team.gc_step3'))),
      h('div', { class: 'field mb-8' }, h('label', null, t('team.redirect_uris')),
        d.redirect_uris.map(u => h('div', { class: 'row' }, h('code', { class: 'mono grow' }, u), h('button', { class: 'btn ghost sm', onclick: () => copyText(u) }, t('common.copy_link'))))),
      !d.origin.startsWith('https:') && !/localhost|127\.0\.0\.1/.test(d.origin) ? h('div', { class: 'banner warn mb-8' }, t('team.needs_https')) : null,
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 'g-cid' }, t('team.client_id')), cid),
        h('div', { class: 'field' }, h('label', { for: 'g-sec' }, t('team.client_secret')), sec)),
      h('div', { class: 'row mt-8' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await api.put('/integrations/google', { client_id: cid.value.trim(), client_secret: sec.value.trim() || undefined }); toast(t('common.saved')); integrationsTab(el, {}); } catch (e) { showError(e); }
      } }, t('common.save')), h('span', { class: ['chip', d.google_oauth.configured ? 'ok' : 'warn'] }, d.google_oauth.configured ? t('team.configured') : t('team.not_configured')))),
    step(2, t('team.mailbox'),
      h('p', { class: 'small' }, t('team.mailbox_lead')),
      h('p', { class: 'small' }, h('strong', null, t('team.status') + ': '), t('team.mailbox_' + d.gmail.status), d.gmail.account_email ? ` — ${d.gmail.account_email}` : ''),
      d.gmail.last_error ? h('div', { class: 'banner danger mb-8' }, d.gmail.last_error) : null,
      h('div', { class: 'row wrap' },
        d.google_oauth.configured ? h('a', { class: 'btn primary', href: '/api/integrations/gmail/start' }, d.gmail.status === 'connected' ? t('team.reconnect') : t('team.connect_mailbox')) : h('span', { class: 'muted small' }, t('team.client_first')),
        d.gmail.status === 'connected' ? h('button', { class: 'btn', onclick: async () => {
          const r = await api.post('/integrations/gmail/test');
          mount(testMsg, h('div', { class: ['banner', r.ok ? 'info' : 'danger'] }, r.ok ? t('team.test_ok', { email: state.me.email }) : t('team.test_failed', { error: r.error || '' })));
        } }, t('team.send_test')) : null,
        d.gmail.status === 'connected' ? h('button', { class: 'btn danger', onclick: async () => { try { await api.del('/integrations/gmail'); integrationsTab(el, {}); } catch (e) { showError(e); } } }, t('team.disconnect')) : null),
      testMsg),
    step(3, t('team.config'),
      h('p', { class: 'small' }, t('team.config_lead')),
      h('p', { class: 'small' }, h('strong', null, t('team.allowed_domains') + ': '), d.allowed_domains.join(', ') || '—'),
      h('p', { class: 'small' }, h('strong', null, t('team.config_super_admins') + ': '), d.super_admins_in_config.join(', ') || '—'))));
}

// ---- organisation ------------------------------------------------------------------

function organisationTab(el) {
  const link = (href, label, sub) => h('a', { class: 'card pad', href, style: { display: 'block', textDecoration: 'none', color: 'inherit' } }, h('strong', null, label), h('div', { class: 'muted small' }, sub));
  mount(el, h('div', { class: 'grid-cards' },
    link('#/admin/entities', t('team.org_entities'), t('team.org_entities_sub')),
    link('#/admin/departments', t('team.org_departments'), t('team.org_departments_sub')),
    link('#/admin/settings', t('team.org_settings'), t('team.org_settings_sub')),
    link('#/audit', t('nav.audit'), t('team.org_audit_sub')),
    link('#/people', t('team.org_directory'), t('team.org_directory_sub')),
    link('#/workload', t('nav.workload'), t('team.org_workload_sub'))));
}
