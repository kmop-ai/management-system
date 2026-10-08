// My settings: profile, language and theme, email digest, notification
// preferences, my capacity, sessions — and a read-only "what can I see"
// summary, so access is never a mystery to the person who has it.

import { h, mount, icon } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { state, t, entityById, deptById, deptName, roleLabel, moduleLabel } from '../lib/state.js';
import { toast, showError, confirmDialog, spinner, fmtDate } from '../lib/ui.js';
import { applyTheme } from '../app.js';
import { ISO_DAYS, weekdayName } from './people.js';

const KIND_LABELS = () => ({
  assigned: t('settings.kind_assigned'), mentioned: t('settings.kind_mentioned'), commented: t('settings.kind_commented'),
  due_soon: t('settings.kind_due_soon'), overdue: t('settings.kind_overdue'), completed: t('settings.kind_completed'),
  added_to_project: t('settings.kind_added_to_project'), nudge: t('settings.kind_nudge'),
});
const EMAIL_OPTIONS = () => [['immediate', t('settings.email_immediate')], ['digest', t('settings.email_digest')], ['off', t('settings.email_off')]];
const levelLabel = (n) => [t('common.level_0'), t('common.level_1'), t('common.level_2'), t('common.level_3')][n] ?? String(n);

export default async function settings(root) {
  const me = state.me;
  const field = (id, label, input, hint) => h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  const card = (id, title, ...body) => h('section', { class: 'card pad', 'aria-labelledby': id }, h('h2', { id, class: 'mb-8' }, title), ...body);
  const patchMe = async (body) => { const r = await api.patch('/me', body); Object.assign(state.me, r); return r; };

  // profile
  const nameIn = h('input', { class: 'input', id: 'st-name', value: me.name, required: true, minlength: 2, maxlength: 120, autocomplete: 'name' });
  const titleIn = h('input', { class: 'input', id: 'st-title', value: me.title || '', maxlength: 120 });
  const tzIn = h('input', { class: 'input', id: 'st-tz', value: me.timezone || '', placeholder: 'Europe/Athens', maxlength: 60, list: 'st-tz-list' });
  const tzList = h('datalist', { id: 'st-tz-list' }, ['Europe/Athens', 'Europe/Brussels', 'Europe/Rome', 'Europe/Nicosia', 'Europe/London', 'UTC'].map(z => h('option', { value: z })));
  const profile = card('st-profile', t('settings.profile'),
    h('form', { class: 'col gap-12', onsubmit: async (e) => {
      e.preventDefault();
      try { await patchMe({ name: nameIn.value.trim(), title: titleIn.value.trim() || null, timezone: tzIn.value.trim() || null }); toast(t('common.saved')); } catch (err) { showError(err); }
    } },
      h('div', { class: 'form-grid' },
        field('st-name', t('common.name'), nameIn),
        field('st-title', t('people.job_title'), titleIn),
        field('st-tz', t('settings.timezone'), tzIn, t('settings.timezone_hint')), tzList),
      h('div', { class: 'muted small' }, t('settings.email_fixed', { email: me.email })),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, t('common.save')))));

  // language & theme
  const curTheme = document.documentElement.dataset.theme || me.theme || 'system';
  const themeSeg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': t('nav.theme') });
  const renderTheme = (cur) => mount(themeSeg, [['system', t('settings.theme_system_short'), 'gear'], ['light', t('settings.theme_light_short'), 'sun'], ['dark', t('settings.theme_dark_short'), 'moon']].map(([v, l, ic]) =>
    h('button', { class: 'btn sm', type: 'button', role: 'radio', 'aria-checked': String(v === cur), 'aria-pressed': String(v === cur), onclick: async () => {
      applyTheme(v); renderTheme(v);
      try { await patchMe({ theme: v }); } catch (err) { showError(err); }
    } }, icon(ic, 13), l)));
  renderTheme(curTheme);
  const langSel = h('select', { class: 'input', id: 'st-lang', onchange: async (e) => {
    try { await patchMe({ locale: e.target.value }); location.reload(); } catch (err) { showError(err); }
  } }, [['en', 'English'], ['el', 'Ελληνικά']].map(([v, l]) => h('option', { value: v, selected: v === (me.locale || 'en'), lang: v }, l)));
  const looks = card('st-looks', t('settings.language_theme'),
    h('div', { class: 'form-grid' },
      field('st-lang', t('settings.language'), langSel, t('settings.language_hint')),
      h('div', { class: 'field' }, h('span', { class: 'label', id: 'st-theme-l' }, t('nav.theme')), themeSeg)));

  // digest
  const freqSel = h('select', { class: 'input', id: 'st-freq' }, [['daily', t('settings.digest_daily')], ['weekly', t('settings.digest_weekly')], ['off', t('settings.digest_off')]].map(([v, l]) => h('option', { value: v, selected: v === (me.digest_frequency || 'daily') }, l)));
  const hourSel = h('select', { class: 'input', id: 'st-hour' }, Array.from({ length: 24 }, (_, i) => h('option', { value: i, selected: i === (me.digest_hour ?? 8) }, `${String(i).padStart(2, '0')}:00`)));
  const digest = card('st-digest', t('settings.digest'),
    h('p', { class: 'muted small' }, t('settings.digest_hint')),
    h('form', { class: 'col gap-12', onsubmit: async (e) => {
      e.preventDefault();
      try { await patchMe({ digest_frequency: freqSel.value, digest_hour: Number(hourSel.value) }); toast(t('common.saved')); } catch (err) { showError(err); }
    } },
      h('div', { class: 'form-grid' }, field('st-freq', t('settings.digest_frequency'), freqSel), field('st-hour', t('settings.digest_hour'), hourSel, t('settings.digest_hour_hint'))),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, t('common.save')))));

  // notification preferences
  const prefsBox = h('div', null, spinner());
  const prefs = card('st-prefs', t('settings.notifications'), h('p', { class: 'muted small' }, t('settings.notifications_hint')), prefsBox);

  // capacity
  const loaded = { weekly_hours: me.weekly_hours, work_days: me.work_days };
  const hoursIn = h('input', { class: 'input', id: 'st-hours', type: 'number', min: 0, max: 60, step: 0.5, value: me.weekly_hours ?? 40, style: { width: '120px' } });
  const dayBoxes = ISO_DAYS.map(n => h('input', { type: 'checkbox', id: 'st-day-' + n, value: String(n), checked: (me.work_days || '').includes(String(n)) }));
  const capacity = me.is_external ? null : card('st-cap', t('settings.my_capacity'),
    h('p', { class: 'muted small' }, t('person.capacity_hint')),
    h('form', { class: 'col gap-12', onsubmit: async (e) => {
      e.preventDefault();
      try {
        const body = { weekly_hours: Number(hoursIn.value), work_days: dayBoxes.filter(b => b.checked).map(b => b.value).join('') };
        let r;
        try { r = await api.patch(`/users/${me.id}`, body, me.updated_at); }
        catch (err) {
          // A theme or language change elsewhere bumps my version; retry only
          // if nobody else changed my capacity meanwhile.
          if (err.code !== 'conflict') throw err;
          const fresh = await api.get(`/users/${me.id}`);
          if (fresh.weekly_hours !== loaded.weekly_hours || fresh.work_days !== loaded.work_days) throw err;
          r = await api.patch(`/users/${me.id}`, body, fresh.updated_at);
        }
        loaded.weekly_hours = r.weekly_hours; loaded.work_days = r.work_days;
        Object.assign(state.me, r);
        toast(t('common.saved'));
      } catch (err) { showError(err); }
    } },
      field('st-hours', t('people.weekly_hours'), hoursIn),
      h('fieldset', { class: 'plain-fieldset' }, h('legend', { class: 'label' }, t('people.work_days')),
        h('div', { class: 'row wrap gap-12' }, dayBoxes.map((b, i) => h('label', { class: 'checkbox', for: b.id }, b, weekdayName(i + 1))))),
      h('div', null, h('button', { class: 'btn primary', type: 'submit' }, t('common.save')))));

  // my access
  const a = state.access || { roles: [], modules: {} };
  const scopeText = (r) => r.department_id ? deptName(deptById(r.department_id)) || `#${r.department_id}` : r.entity_id ? (entityById(r.entity_id)?.name || `#${r.entity_id}`) : t('access.all_entities');
  const modKeys = state.modules.map(m => m.key);
  const access = card('st-access', t('settings.my_access'),
    h('p', { class: 'muted small' }, t('settings.my_access_hint')),
    h('h3', { class: 'mb-8' }, t('access.roles')),
    a.roles.length ? h('ul', { class: 'plain-list mb-16' }, a.roles.map(r => h('li', { class: 'row wrap' },
      h('strong', null, roleLabel(r.role)), h('span', { class: 'muted small' }, scopeText(r)),
      r.valid_until ? h('span', { class: 'chip warn' }, t('common.until', { date: fmtDate(r.valid_until, { year: true }) })) : null)))
      : h('p', { class: 'muted small' }, t('settings.no_roles')),
    h('h3', { class: 'mb-8' }, t('settings.module_levels')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('access.module')), h('th', { scope: 'col' }, t('access.level')))),
      h('tbody', null, modKeys.map(k => {
        const lv = a.modules?.[k] || 0;
        const m = state.modules.find(x => x.key === k);
        return h('tr', { class: lv ? null : 'muted' },
          h('td', null, moduleLabel(k), m?.sensitive ? h('span', { class: 'warn-text', title: t('access.sensitive') }, ' ', icon('alert', 11), h('span', { class: 'sr-only' }, t('access.sensitive'))) : null),
          h('td', null, h('span', { class: ['chip', lv >= 2 ? 'accent' : lv ? '' : 'outline'] }, levelLabel(lv))));
      })))),
    h('p', { class: 'muted xs mt-8' }, t('settings.access_projects', { n: Object.keys(a.projects || {}).length })),
    h('p', { class: 'muted xs' }, a.people_metrics_self_visible ? t('settings.metrics_self_on') : t('settings.metrics_self_off'),
      ' ', h('a', { href: `#/people/${me.id}` }, t('settings.my_profile'))));

  // sessions
  const sessions = card('st-sessions', t('settings.sessions'),
    h('p', { class: 'muted small' }, t('settings.sessions_hint')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn', onclick: async () => {
        try { await api.post('/auth/logout'); } catch { /* signing out locally anyway */ }
        location.replace(location.pathname + '#/login'); location.reload();
      } }, icon('x', 14), t('nav.sign_out')),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmDialog(t('settings.logout_everywhere_confirm'), { okLabel: t('settings.logout_everywhere') })) return;
        try { await api.post('/auth/logout-everywhere'); location.replace(location.pathname + '#/login'); location.reload(); } catch (err) { showError(err); }
      } }, icon('key', 14), t('settings.logout_everywhere'))));

  mount(root, h('div', { class: 'page' },
    h('div', { class: 'page-head' }, h('h1', null, t('nav.settings')), h('a', { class: 'sub', href: `#/people/${me.id}` }, t('settings.my_profile'))),
    h('div', { class: 'col gap-16 settings-col' }, profile, looks, digest, prefs, capacity, access, sessions)));

  // load notification prefs
  try {
    const rows = await api.get('/me/notification-prefs');
    renderPrefs(prefsBox, rows);
  } catch (e) { mount(prefsBox, h('div', { class: 'banner danger' }, e.message || t('common.error'))); }
}

function renderPrefs(el, rows) {
  const labels = KIND_LABELS();
  const state2 = rows.map(r => ({ ...r }));
  const save = h('button', { class: 'btn primary', type: 'submit' }, t('common.save'));
  mount(el, h('form', { onsubmit: async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const out = await api.put('/me/notification-prefs', { prefs: state2.map(r => ({ kind: r.kind, in_app: r.in_app ? 1 : 0, email: r.email })) });
      toast(t('common.saved'));
      renderPrefs(el, out);
    } catch (err) { showError(err); } finally { save.disabled = false; }
  } },
    h('div', { class: 'table-wrap' }, h('table', { class: 'table prefs-table' },
      h('caption', { class: 'sr-only' }, t('settings.notifications')),
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('settings.kind')), h('th', { scope: 'col' }, t('settings.in_app')), h('th', { scope: 'col' }, t('common.email')))),
      h('tbody', null, state2.map(r => {
        const cb = h('input', { type: 'checkbox', id: 'np-app-' + r.kind, checked: !!r.in_app, onchange: (e) => { r.in_app = e.target.checked ? 1 : 0; } });
        return h('tr', null,
          h('th', { scope: 'row' }, labels[r.kind] || r.kind),
          h('td', null, h('label', { class: 'checkbox', for: cb.id }, cb, h('span', { class: 'sr-only' }, `${t('settings.in_app')}: ${labels[r.kind] || r.kind}`), h('span', { 'aria-hidden': 'true', class: 'small' }, r.in_app ? t('settings.on') : t('settings.off')))),
          h('td', null, h('select', { class: 'input sm', 'aria-label': `${t('common.email')}: ${labels[r.kind] || r.kind}`, onchange: (e) => { r.email = e.target.value; } },
            EMAIL_OPTIONS().map(([v, l]) => h('option', { value: v, selected: v === r.email }, l + (v === r.default_email ? ` (${t('settings.default')})` : ''))))));
      })))),
    h('p', { class: 'muted xs mt-8' }, t('settings.in_app_hint')),
    h('div', { class: 'mt-8' }, save)));
  // keep the on/off word in sync with the checkbox
  for (const cb of el.querySelectorAll('input[type=checkbox]')) cb.addEventListener('change', () => { cb.parentElement.querySelector('[aria-hidden]').textContent = cb.checked ? t('settings.on') : t('settings.off'); });
}
