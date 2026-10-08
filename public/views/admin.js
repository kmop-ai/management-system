// Administration: people, roles & the access matrix, entities (with public
// holidays), departments, settings. Visible with admin read; edits need admin
// write (roles, entities create/delete and settings need admin level 3 — the
// server decides and its message is shown when it refuses).

import { h, mount, icon } from '../lib/dom.js';
import { api, listAll } from '../lib/api.js';
import { state, t, can, entityById, deptById, deptName, roleLabel, moduleLabel } from '../lib/state.js';
import { formDialog, confirmDialog, showError, toast, avatar, fmtDate, fmtDateTime, timeAgo, emptyState, spinner } from '../lib/ui.js';

const TABS = ['people', 'roles', 'entities', 'departments', 'settings'];
const tabLabel = (x) => ({
  people: t('admin.tab_people'), roles: t('admin.tab_roles'), entities: t('admin.tab_entities'),
  departments: t('admin.tab_departments'), settings: t('admin.tab_settings'),
})[x];
const levelLabels = () => [t('common.level_0'), t('common.level_1'), t('common.level_2'), t('common.level_3')];

export default async function adminView(root, params) {
  if (!can('admin', 1)) {
    mount(root, h('div', { class: 'page' }, h('h1', { class: 'mb-16' }, t('nav.admin')), h('div', { class: 'banner warn' }, t('admin.no_access'))));
    return;
  }
  const tab = TABS.includes(params.tab) ? params.tab : 'people';
  const content = h('div');
  mount(root, h('div', { class: 'page wide' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.admin')),
      !can('admin', 2) ? h('span', { class: 'chip outline', title: t('admin.read_only_hint') }, icon('eye', 12), t('admin.read_only')) : null),
    h('nav', { class: 'tabs', 'aria-label': t('nav.admin') }, TABS.map(x => h('a', { href: `#/admin${x === 'people' ? '' : '/' + x}`, 'aria-current': x === tab ? 'page' : null }, tabLabel(x)))),
    content));
  mount(content, spinner());
  const run = { people: peopleTab, roles: rolesTab, entities: entitiesTab, departments: departmentsTab, settings: settingsTab }[tab];
  try { await run(content); }
  catch (e) { mount(content, h('div', { class: 'banner danger' }, e.message || t('common.error'))); if (!e.status) console.error(e); }
}

// ---- shared bits ----------------------------------------------------------

function entityChip(id) {
  const e = id ? entityById(id) : null;
  if (!e) return h('span', { class: 'chip outline' }, t('admin.all_entities'));
  return h('span', { class: 'chip', title: e.name, style: { background: (e.color || '#888') + '22', color: e.color } }, e.code);
}

const myRank = () => Math.max(0, ...(state.access?.roles || []).map(r => state.roles.find(x => x.key === r.role)?.rank || 0));

async function refreshEntities() { try { state.entities = await api.get('/entities'); } catch {} }
async function refreshDepartments() { try { state.departments = await api.get('/departments'); } catch {} }

// ---- people ---------------------------------------------------------------

async function peopleTab(el) {
  const write = can('admin', 2);
  let users = await listAll('/users', { active: 'all', sort: 'name' });
  let q = '';
  let showInactive = true;
  const body = h('div');
  const count = h('span', { class: 'muted small' });

  const render = () => {
    const needle = q.trim().toLowerCase();
    const rows = users.filter(u => (showInactive || u.active) && (!needle || [u.name, u.email, u.title, u.entity_code, u.department_name].some(x => (x || '').toLowerCase().includes(needle))));
    count.textContent = t('admin.people_count', { n: rows.length, total: users.length });
    if (!rows.length) { mount(body, h('div', { class: 'card' }, emptyState(t('common.empty'), 'people'))); return; }
    mount(body, h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, t('common.name')), h('th', { scope: 'col' }, t('admin.roles')), h('th', { scope: 'col' }, t('common.entity')),
        h('th', { scope: 'col', class: 'hide-mobile' }, t('common.department')), h('th', { scope: 'col' }, t('common.status')),
        h('th', { scope: 'col', class: 'hide-mobile' }, t('admin.last_login')), write ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('admin.actions'))) : null)),
      h('tbody', null, rows.map(u => h('tr', { class: !u.active ? 'adm-inactive' : null },
        h('td', null, h('div', { class: 'row' }, avatar(u.name, u.id), h('div', { class: 'col gap-4', style: { minWidth: 0 } },
          h('a', { href: `#/people/${u.id}`, style: { fontWeight: 600 } }, u.name),
          h('span', { class: 'muted xs ellipsis' }, [u.email, u.is_external ? (u.external_org || t('common.external')) : u.title].filter(Boolean).join(' · '))))),
        h('td', null, h('div', { class: 'row wrap gap-4' }, [...new Set(u.roles)].map(r => h('span', { class: ['chip', r === 'super_admin' ? 'warn' : r === 'auditor' ? 'accent' : ''] }, roleLabel(r))),
          !u.roles.length ? h('span', { class: 'muted xs' }, '—') : null)),
        h('td', null, u.entity_id ? entityChip(u.entity_id) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'small hide-mobile' }, deptName(deptById(u.department_id)) || u.department_name || h('span', { class: 'muted' }, '—')),
        h('td', null, u.active ? h('span', { class: 'chip ok' }, t('admin.active')) : h('span', { class: 'chip' }, t('admin.inactive'))),
        h('td', { class: 'small muted nowrap hide-mobile', title: u.last_login_at ? fmtDateTime(u.last_login_at) : null }, u.last_login_at ? timeAgo(u.last_login_at) : t('admin.never')),
        write ? h('td', { class: 'nowrap' }, u.id === state.me.id ? null : h('button', { class: ['btn sm', u.active ? 'danger' : ''], onclick: () => toggleActive(u) },
          u.active ? t('admin.deactivate') : t('admin.reactivate'))) : null))))));
  };

  async function toggleActive(u) {
    if (u.active && !await confirmDialog(t('admin.deactivate_confirm', { name: u.name }), { okLabel: t('admin.deactivate') })) return;
    try {
      await api.patch(`/users/${u.id}`, { active: u.active ? 0 : 1 }, u.updated_at);
      toast(u.active ? t('admin.deactivated', { name: u.name }) : t('admin.reactivated', { name: u.name }));
      users = await listAll('/users', { active: 'all', sort: 'name' });
      render();
    } catch (e) { showError(e); }
  }

  const searchId = 'adm-people-q';
  mount(el,
    h('div', { class: 'filterbar' },
      h('label', { class: 'sr-only', for: searchId }, t('common.search')),
      h('input', { class: 'input sm', id: searchId, type: 'search', placeholder: t('admin.people_search'), oninput: (e) => { q = e.target.value; render(); } }),
      h('label', { class: 'checkbox small' }, h('input', { type: 'checkbox', checked: showInactive, onchange: (e) => { showInactive = e.target.checked; render(); } }), t('admin.show_inactive')),
      count,
      write ? h('button', { class: 'btn primary sm right', onclick: () => addPersonDialog(async () => { users = await listAll('/users', { active: 'all', sort: 'name' }); render(); }) }, icon('plus', 13), t('admin.add_person')) : null),
    body);
  render();
}

function addPersonDialog(done) {
  const rank = myRank();
  formDialog({
    title: t('admin.add_person'),
    submitLabel: t('common.add'),
    intro: h('p', { class: 'muted small' }, t('admin.add_person_hint')),
    fields: [
      { name: 'name', label: t('common.name'), required: true },
      { name: 'email', label: t('common.email'), type: 'email', required: true },
      { name: 'title', label: t('admin.job_title') },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: state.me.entity_id || '', options: [{ value: '', label: '—' }, ...state.entities.map(e => ({ value: e.id, label: e.name }))] },
      { name: 'department_id', label: t('common.department'), type: 'select', numeric: true, options: [{ value: '', label: '—' }, ...state.departments.map(d => ({ value: d.id, label: deptName(d) }))] },
      { name: 'role', label: t('admin.initial_role'), type: 'select', value: 'team_member', hint: t('admin.initial_role_hint'),
        options: state.roles.filter(r => r.rank <= rank && !r.requires_expiry).map(r => ({ value: r.key, label: roleLabel(r.key) })) },
      { name: 'locale', label: t('nav.language'), type: 'select', value: 'en', options: [{ value: 'en', label: 'English' }, { value: 'el', label: 'Ελληνικά' }] },
      { name: 'weekly_hours', label: t('admin.weekly_hours'), type: 'number', min: 0, max: 60, value: 40 },
      { name: 'is_external', label: t('admin.is_external'), type: 'checkbox', hint: t('admin.is_external_hint') },
      { name: 'external_org', label: t('admin.external_org') },
    ],
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== ''));
      if (body.is_external && body.role === 'team_member') body.role = 'external_partner';
      const u = await api.post('/users', body);
      toast(t('admin.person_added', { name: u.name }), { action: () => { location.hash = `#/people/${u.id}`; }, actionLabel: t('common.open') });
      await done();
    },
  });
}

// ---- roles & access matrix ------------------------------------------------

async function rolesTab(el) {
  const write = can('admin', 2);
  const [data, users] = await Promise.all([api.get('/roles'), listAll('/users', { active: '1' }).catch(() => null)]);
  // Distinct people per role (a person may hold a role in two entities).
  const holders = {};
  if (users) for (const u of users) for (const r of new Set(u.roles)) holders[r] = (holders[r] || 0) + 1;

  const render = (d) => {
    const lv = {};
    for (const m of d.matrix) (lv[m.role] ||= {})[m.module] = m.level;
    const labelOf = (r) => state.locale === 'el' ? r.label_el : r.label_en;
    const modLabel = (m) => (state.locale === 'el' ? m.label_el : m.label_en) || moduleLabel(m.key);
    const LV = levelLabels();

    const rows = d.roles.map(r => {
      const current = Object.fromEntries(d.modules.map(m => [m.key, lv[r.key]?.[m.key] || 0]));
      const draft = { ...current };
      const save = h('button', { class: 'btn sm primary', disabled: true, onclick: async () => {
        save.disabled = true;
        try { const nd = await api.put(`/roles/${r.key}/access`, { levels: draft }); toast(t('admin.role_access_saved', { role: labelOf(r) })); render(nd); }
        catch (e) { showError(e); save.disabled = false; }
      } }, t('common.save'));
      const reset = h('button', { class: 'btn sm ghost hidden', onclick: () => render(d) }, t('common.cancel'));
      const n = users ? (holders[r.key] || 0) : r.holders;
      return h('tr', null,
        h('th', { scope: 'row', class: 'adm-rolecell' },
          h('div', { class: 'col gap-4' },
            h('div', { class: 'row gap-4' }, h('strong', null, labelOf(r)), r.requires_expiry ? h('span', { class: 'chip warn', title: t('admin.requires_expiry_hint') }, icon('clock', 11), t('admin.requires_expiry')) : null),
            h('span', { class: 'muted xs adm-roledesc' }, r.description || ''),
            h('div', { class: 'row gap-4' },
              h('span', { class: 'xs muted' }, t('admin.holders', { n })),
              write ? h('button', { class: 'btn ghost sm', onclick: () => editRoleDialog(r, async () => render(await api.get('/roles'))) }, t('admin.edit_role'))
                : null))),
        d.modules.map(m => {
          if (!write) return h('td', null, h('span', { class: ['chip adm-lvl-chip', 'lvl-' + current[m.key]], title: `${labelOf(r)} — ${modLabel(m)}` }, LV[current[m.key]]));
          const sel = h('select', { class: ['input sm adm-lvl', 'lvl-' + current[m.key]], 'aria-label': `${labelOf(r)} — ${modLabel(m)}`,
            onchange: (e) => {
              draft[m.key] = Number(e.target.value);
              sel.className = 'input sm adm-lvl lvl-' + draft[m.key] + (draft[m.key] !== current[m.key] ? ' changed' : '');
              const dirty = d.modules.some(x => draft[x.key] !== current[x.key]);
              save.disabled = !dirty; reset.classList.toggle('hidden', !dirty);
            } }, LV.map((l, i) => h('option', { value: i, selected: i === current[m.key] }, l)));
          return h('td', null, sel);
        }),
        write ? h('td', { class: 'nowrap' }, h('div', { class: 'row gap-4' }, save, reset)) : null);
    });

    mount(el,
      h('div', { class: 'card pad mb-16 adm-explain' },
        h('p', null, t('admin.roles_explain_1')),
        h('p', null, t('admin.roles_explain_2')),
        h('p', { class: 'muted small' }, t('admin.roles_explain_3'))),
      h('div', { class: 'row wrap mb-8 small' },
        h('span', { class: 'muted' }, t('admin.legend')), LV.map((l, i) => h('span', { class: ['chip adm-lvl-chip', 'lvl-' + i] }, l)),
        h('span', { class: 'row gap-4 muted' }, icon('lock', 13), t('admin.sensitive_hint')),
        !can('admin', 3) && write ? h('span', { class: 'muted xs right' }, t('admin.level3_needed')) : null),
      h('div', { class: 'table-wrap adm-matrix-wrap' }, h('table', { class: 'table adm-matrix' },
        h('thead', null, h('tr', null,
          h('th', { scope: 'col', class: 'adm-rolecell' }, t('common.role')),
          d.modules.map(m => h('th', { scope: 'col', title: m.description || '' }, h('span', { class: 'adm-modhead' }, m.sensitive ? icon('lock', 12, 'warn-text') : null, modLabel(m)),
            m.sensitive ? h('span', { class: 'sr-only' }, ` (${t('admin.sensitive')})`) : null)),
          write ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('admin.actions'))) : null)),
        h('tbody', null, rows))));
  };
  render(data);
}

function editRoleDialog(r, done) {
  formDialog({
    title: t('admin.edit_role_title', { role: state.locale === 'el' ? r.label_el : r.label_en }),
    fields: [
      { name: 'label_en', label: t('admin.label_en'), required: true, value: r.label_en },
      { name: 'label_el', label: t('admin.label_el'), required: true, value: r.label_el },
      { name: 'description', label: t('common.description'), type: 'textarea', rows: 3, value: r.description || '' },
      { name: 'requires_expiry', label: t('admin.requires_expiry_field'), type: 'checkbox', value: !!r.requires_expiry, hint: t('admin.requires_expiry_hint') },
    ],
    onSubmit: async (v) => {
      const out = await api.patch(`/roles/${r.key}`, v);
      const s = state.roles.find(x => x.key === r.key);
      if (s) Object.assign(s, { label_en: out.label_en, label_el: out.label_el, requires_expiry: out.requires_expiry });
      toast(t('common.saved'));
      await done();
    },
  });
}

// ---- entities & holidays --------------------------------------------------

const ENTITY_FIELDS = () => [
  ['code', t('admin.ent_code')], ['name', t('common.name')], ['legal_name', t('admin.ent_legal_name')], ['country', t('admin.ent_country')],
  ['city', t('admin.ent_city')], ['vat_number', t('admin.ent_vat')], ['pic', t('admin.ent_pic')], ['oid', t('admin.ent_oid')],
  ['currency', t('admin.ent_currency')], ['timezone', t('admin.ent_timezone')], ['color', t('project.color')],
];

async function entitiesTab(el) {
  const write = can('admin', 2), full = can('admin', 3);
  let year = new Date().getFullYear();
  const entities = await api.get('/entities');
  const grid = h('div', { class: 'grid-cards adm-entities' });
  const yearLabel = h('strong', { class: 'nowrap' }, String(year));

  const renderAll = () => { yearLabel.textContent = String(year); mount(grid, entities.map(e => entityCard(e))); };

  function entityCard(e) {
    const holidays = h('div', { class: 'col gap-4' }, h('span', { class: 'spinner' }));
    const card = h('section', { class: 'card adm-entity', style: { '--ec': e.color || 'var(--text-3)' }, 'aria-labelledby': `ent-${e.id}` },
      h('div', { class: 'card-head' },
        h('span', { class: 'chip', style: { background: (e.color || '#888') + '22', color: e.color } }, e.code),
        h('h2', { id: `ent-${e.id}`, class: 'grow ellipsis' }, e.name),
        write ? h('button', { class: 'btn ghost sm', onclick: () => entityDialog(e, async () => { Object.assign(e, await api.get(`/entities/${e.id}`)); await refreshEntities(); renderAll(); }) }, t('common.edit')) : null,
        full ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.delete')} ${e.name}`, onclick: async () => {
          if (!await confirmDialog(t('admin.ent_delete_confirm', { name: e.name }))) return;
          try { await api.del(`/entities/${e.id}`); toast(t('common.deleted')); entities.splice(entities.indexOf(e), 1); await refreshEntities(); renderAll(); } catch (err) { showError(err); }
        } }, icon('trash', 13)) : null),
      h('div', { class: 'card-body' },
        h('dl', { class: 'adm-kv' }, ENTITY_FIELDS().filter(([k]) => !['code', 'name'].includes(k)).map(([k, label]) => [
          h('dt', null, label),
          h('dd', null, k === 'color' && e.color ? h('span', { class: 'row gap-4' }, h('span', { class: 'adm-swatch', style: { background: e.color } }), h('span', { class: 'mono' }, e.color))
            : e[k] ? (['vat_number', 'pic', 'oid'].includes(k) ? h('span', { class: 'mono' }, e[k]) : e[k]) : h('span', { class: 'muted' }, '—')),
        ])),
        h('div', { class: 'section-title' }, icon('calendar', 13), t('admin.holidays_title', { year })),
        holidays));
    loadHolidays(e, holidays);
    return card;
  }

  async function loadHolidays(e, box) {
    try {
      const list = await api.get(`/entities/${e.id}/holidays`, { from: `${year}-01-01`, to: `${year}-12-31` });
      const dateId = `hol-d-${e.id}`, nameId = `hol-n-${e.id}`;
      const addForm = write ? h('form', { class: 'row wrap gap-4 mt-8', onsubmit: async (ev) => {
        ev.preventDefault();
        const date = ev.target.elements.date.value, name = ev.target.elements.name.value.trim();
        if (!date || !name) return;
        try { await api.post(`/entities/${e.id}/holidays`, { date, name }); toast(t('admin.holiday_added')); loadHolidays(e, box); } catch (err) { showError(err); }
      } },
        h('label', { class: 'sr-only', for: dateId }, t('common.date')),
        h('input', { class: 'input sm', type: 'date', id: dateId, name: 'date', required: true, min: `${year}-01-01`, max: `${year}-12-31` }),
        h('label', { class: 'sr-only', for: nameId }, t('common.name')),
        h('input', { class: 'input sm grow', id: nameId, name: 'name', required: true, placeholder: t('admin.holiday_name'), style: { minWidth: '120px' } }),
        h('button', { class: 'btn sm', type: 'submit' }, icon('plus', 12), t('common.add'))) : null;
      mount(box,
        list.length ? h('ul', { class: 'adm-holidays' }, list.map(x => h('li', null,
          h('span', { class: 'nowrap small adm-hdate' }, fmtDate(x.date, { weekday: true, year: true })),
          h('span', { class: 'grow small' }, x.name),
          write ? h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.remove')} ${x.name}`, onclick: async () => {
            try { await api.del(`/holidays/${x.id}`); toast(t('admin.holiday_removed')); loadHolidays(e, box); } catch (err) { showError(err); }
          } }, icon('x', 12)) : null))) : h('p', { class: 'muted small' }, t('admin.no_holidays', { year })),
        addForm);
    } catch (err) { mount(box, h('div', { class: 'banner danger' }, err.message)); }
  }

  mount(el,
    h('div', { class: 'banner info mb-16 row' }, icon('shield', 15), h('span', null, t('admin.entities_separate'))),
    h('div', { class: 'row wrap mb-8' },
      h('div', { class: 'row gap-4' },
        h('button', { class: 'btn sm icon-only', 'aria-label': t('admin.prev_year'), onclick: () => { year--; renderAll(); } }, icon('chevronLeft', 14)),
        h('span', { class: 'small' }, t('admin.holidays_year'), ' ', yearLabel),
        h('button', { class: 'btn sm icon-only', 'aria-label': t('admin.next_year'), onclick: () => { year++; renderAll(); } }, icon('chevronRight', 14))),
      full ? h('button', { class: 'btn primary sm right', onclick: () => entityDialog(null, async (created) => { entities.push(created); await refreshEntities(); renderAll(); }) }, icon('plus', 13), t('admin.add_entity')) : null),
    grid);
  renderAll();
}

function entityDialog(e, done) {
  const req = ['code', 'name', 'country'];
  formDialog({
    title: e ? t('admin.edit_entity', { name: e.name }) : t('admin.add_entity'),
    submitLabel: e ? t('common.save') : t('common.create'),
    wide: true,
    intro: e ? null : h('p', { class: 'muted small' }, t('admin.entities_separate')),
    fields: ENTITY_FIELDS().map(([k, label]) => ({
      name: k, label, required: req.includes(k), value: e ? (e[k] ?? '') : (k === 'currency' ? 'EUR' : k === 'timezone' ? 'Europe/Athens' : k === 'country' ? 'GR' : k === 'color' ? '#0891b2' : ''),
      type: k === 'color' ? 'color' : 'text',
      hint: k === 'country' ? t('admin.ent_country_hint') : k === 'pic' ? t('admin.ent_pic_hint') : null,
    })),
    onSubmit: async (v) => {
      const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x === '' ? null : x]));
      if (e) { await api.patch(`/entities/${e.id}`, body, e.updated_at); toast(t('common.saved')); await done(); }
      else { const c = await api.post('/entities', body); toast(t('admin.entity_created', { name: c.name })); await done(c); }
    },
  });
}

// ---- departments -----------------------------------------------------------

async function departmentsTab(el) {
  const write = can('admin', 2);
  const [depts, users] = await Promise.all([api.get('/departments'), listAll('/users', { active: '1' }).catch(() => [])]);
  state.departments = depts;
  const reload = async () => { await refreshDepartments(); departmentsTab(el); };

  mount(el,
    h('div', { class: 'row wrap mb-8' },
      h('p', { class: 'muted small grow', style: { margin: 0 } }, t('admin.departments_hint')),
      write ? h('button', { class: 'btn primary sm', onclick: () => deptDialog(null, users, depts, reload) }, icon('plus', 13), t('admin.add_department')) : null),
    depts.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', { scope: 'col' }, t('common.name')), h('th', { scope: 'col', class: 'hide-mobile' }, t('admin.name_el')), h('th', { scope: 'col' }, t('common.entity')),
        h('th', { scope: 'col', class: 'hide-mobile' }, t('admin.head')), h('th', { scope: 'col', class: 'num' }, t('admin.people_n')),
        write ? h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, t('admin.actions'))) : null)),
      h('tbody', null, depts.map(d => h('tr', null,
        h('td', null, h('strong', null, d.name), d.parent_id ? h('div', { class: 'muted xs' }, '↳ ', deptName(depts.find(x => x.id === d.parent_id))) : null),
        h('td', { class: 'small hide-mobile' }, d.name_el || h('span', { class: 'muted' }, '—')),
        h('td', null, entityChip(d.entity_id)),
        h('td', { class: 'small hide-mobile' }, d.head_user_id ? h('span', { class: 'row gap-4' }, avatar(d.head_name, d.head_user_id), h('a', { href: `#/people/${d.head_user_id}` }, d.head_name)) : h('span', { class: 'muted' }, '—')),
        h('td', { class: 'num' }, String(d.people)),
        write ? h('td', { class: 'nowrap' },
          h('button', { class: 'btn ghost sm', onclick: () => deptDialog(d, users, depts, reload) }, t('common.edit')),
          h('button', { class: 'btn ghost sm icon-only', 'aria-label': `${t('common.delete')} ${d.name}`, onclick: async () => {
            if (!await confirmDialog(t('admin.dept_delete_confirm', { name: d.name, n: d.people }))) return;
            try { await api.del(`/departments/${d.id}`); toast(t('common.deleted')); reload(); } catch (e) { showError(e); }
          } }, icon('trash', 13))) : null))))) : h('div', { class: 'card' }, emptyState(t('common.empty'), 'people')));
}

function deptDialog(d, users, depts, done) {
  formDialog({
    title: d ? t('admin.edit_department', { name: d.name }) : t('admin.add_department'),
    submitLabel: d ? t('common.save') : t('common.create'),
    fields: [
      { name: 'name', label: t('admin.name_en'), required: true, value: d?.name || '' },
      { name: 'name_el', label: t('admin.name_el'), value: d?.name_el || '' },
      { name: 'entity_id', label: t('common.entity'), type: 'select', numeric: true, value: d?.entity_id ?? '', hint: t('admin.dept_entity_hint'),
        options: [{ value: '', label: t('admin.all_entities') }, ...state.entities.map(e => ({ value: e.id, label: e.name }))] },
      { name: 'parent_id', label: t('admin.parent_department'), type: 'select', numeric: true, value: d?.parent_id ?? '',
        options: [{ value: '', label: '—' }, ...depts.filter(x => !d || x.id !== d.id).map(x => ({ value: x.id, label: deptName(x) }))] },
      { name: 'head_user_id', label: t('admin.head'), type: 'select', numeric: true, value: d?.head_user_id ?? '',
        options: [{ value: '', label: '—' }, ...users.filter(u => !u.is_external).map(u => ({ value: u.id, label: u.name }))] },
    ],
    onSubmit: async (v) => {
      if (d) await api.patch(`/departments/${d.id}`, v, d.updated_at);
      else await api.post('/departments', Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null)));
      toast(t('common.saved'));
      await done();
    },
  });
}

// ---- settings --------------------------------------------------------------

const settingInfo = (key) => ({
  people_metrics_self_visible: [t('admin.set_metrics_self'), t('admin.set_metrics_self_desc')],
  retention_soft_deleted_days: [t('admin.set_retention'), t('admin.set_retention_desc')],
  magic_link_minutes: [t('admin.set_magic_link'), t('admin.set_magic_link_desc')],
  session_days: [t('admin.set_session_days'), t('admin.set_session_days_desc')],
  due_soon_days: [t('admin.set_due_soon'), t('admin.set_due_soon_desc')],
  default_locale: [t('admin.set_default_locale'), t('admin.set_default_locale_desc')],
})[key];

async function settingsTab(el) {
  const full = can('admin', 3);
  const settings = await api.get('/settings');
  const isBool = (s) => s.value === '0' || s.value === '1';

  const control = (s, id) => {
    const commit = async (value, input) => {
      try {
        const out = await api.patch(`/settings/${s.key}`, { value: String(value) });
        Object.assign(s, out, { updated_by_name: state.me.name });
        if (s.key === 'people_metrics_self_visible' && state.access) state.access.people_metrics_self_visible = out.value === '1';
        toast(t('admin.setting_saved'));
        settingsTab(el);
      } catch (e) { showError(e); if (input) { if (input.type === 'checkbox') input.checked = s.value === '1'; else input.value = s.value; } }
    };
    if (isBool(s)) {
      return h('label', { class: 'checkbox', for: id }, h('input', { type: 'checkbox', id, checked: s.value === '1', disabled: !full, onchange: (e) => commit(e.target.checked ? '1' : '0', e.target) }),
        s.value === '1' ? t('admin.on') : t('admin.off'));
    }
    let input;
    if (s.key === 'default_locale') input = h('select', { class: 'input sm', id, disabled: !full }, [['en', 'English'], ['el', 'Ελληνικά']].map(([v, l]) => h('option', { value: v, selected: v === s.value }, l)));
    else input = h('input', { class: 'input sm', id, disabled: !full, type: /^\d+$/.test(s.value) ? 'number' : 'text', min: /^\d+$/.test(s.value) ? 0 : null, value: s.value, style: { width: '110px' } });
    const btn = h('button', { class: 'btn sm primary', type: 'submit', disabled: true }, t('common.save'));
    input.addEventListener('input', () => { btn.disabled = input.value === s.value || input.value === ''; });
    input.addEventListener('change', () => { btn.disabled = input.value === s.value || input.value === ''; });
    return h('form', { class: 'row gap-4', onsubmit: (e) => { e.preventDefault(); if (input.value !== s.value && input.value !== '') commit(input.value, input); } }, input, full ? btn : null);
  };

  const row = (s, featured = false) => {
    const id = 'set-' + s.key;
    const [label, desc] = settingInfo(s.key) || [s.key, s.description];
    return h('div', { class: ['adm-setting', featured && 'featured'] },
      h('div', { class: 'grow col gap-4' },
        h('label', { for: id, class: 'adm-setting-label' }, label, ' ', h('code', { class: 'mono muted' }, s.key)),
        h('div', { class: 'small muted' }, desc || s.description),
        featured ? h('div', { class: 'small' }, t('admin.set_metrics_self_note')) : null,
        h('div', { class: 'xs muted' }, s.updated_by_name ? t('admin.changed_by', { name: s.updated_by_name, when: timeAgo(s.updated_at) }) : t('admin.default_value'))),
      h('div', { class: 'adm-setting-ctl' }, control(s, id)));
  };

  const featured = settings.find(s => s.key === 'people_metrics_self_visible');
  mount(el,
    !full ? h('div', { class: 'banner mb-16' }, t('admin.settings_readonly')) : null,
    featured ? h('div', { class: 'mb-16' }, row(featured, true)) : null,
    h('div', { class: 'card' }, settings.filter(s => s !== featured).map(s => row(s))));
}
