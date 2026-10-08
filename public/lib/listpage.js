// The one list component every list page uses.
//
//   * clickable tiles — each tile IS a filter, and its number is computed by
//     the same predicate that filters the table, so tile and list can never
//     disagree; every tile has a sub-line saying in words what it counts;
//   * a filter bar whose filters INTERSECT, one removable chip per active
//     filter, and "Clear filters";
//   * "Showing: <what> · <n> of <total>";
//   * a table with fixed column widths (at most seven columns), one-line
//     clipping with the full text on hover, secondary facts as one quiet grey
//     line inside the name cell, a left colour stripe for state, and a pinned
//     action column holding exactly ONE button.
//
// listPage(el, {
//   what,                      // noun for the Showing line: 'people'
//   rows,                      // all rows (client-side mode)
//   tiles:   [{ key, label, sub, test: row => bool }],
//   filters: [{ key, label, options: [{value, label}], test: (row, value) => bool }],
//   search:  row => 'text to match',
//   columns: [{ key, label, width, value: row => text, render?: row => node, sub?: row => text }],   // ≤ 7
//   stripe:  row => 'ok' | 'warn' | 'danger' | 'accent' | null,
//   action:  { label: row => text, onClick: row => void },
//   onOpen:  row => void,      // row click / Enter
//   state:   saved filter state key (per viewer, localStorage)
// })

import { h, mount, icon, debounce } from './dom.js';
import { t, local } from './state.js';

export function listPage(el, cfg) {
  if (cfg.columns.length > 7) throw new Error('listPage: at most seven columns');
  const saved = cfg.state ? local.get('list.' + cfg.state, {}) : {};
  const st = { tile: saved.tile || null, q: saved.q || '', f: saved.f || {} };
  const persist = () => cfg.state && local.set('list.' + cfg.state, st);
  const tilesEl = h('div', { class: 'lp-tiles', role: 'group', 'aria-label': t('list.summary') });
  const barEl = h('div', { class: 'filterbar lp-bar', role: 'search' });
  const chipsEl = h('div', { class: 'lp-chips' });
  const showEl = h('div', { class: 'lp-showing', 'aria-live': 'polite' });
  const tableEl = h('div', { class: 'table-wrap lp-table' });
  mount(el, tilesEl, barEl, chipsEl, showEl, tableEl);

  const tileTest = (k) => cfg.tiles?.find(x => x.key === k)?.test || (() => true);
  const matchesFilters = (r, except) => {
    for (const f of cfg.filters || []) if (f.key !== except && st.f[f.key] != null && st.f[f.key] !== '' && !f.test(r, st.f[f.key])) return false;
    if (st.q && cfg.search && !cfg.search(r).toLowerCase().includes(st.q.toLowerCase())) return false;
    return true;
  };
  const visible = () => cfg.rows.filter(r => matchesFilters(r) && (!st.tile || tileTest(st.tile)(r)));

  function renderTiles() {
    if (!cfg.tiles?.length) { tilesEl.hidden = true; return; }
    // A tile counts what the list would show if you clicked it (with the
    // other filters applied) — the same function, so they cannot disagree.
    const base = cfg.rows.filter(r => matchesFilters(r));
    mount(tilesEl, cfg.tiles.map(tile => {
      const n = base.filter(tile.test).length;
      const on = st.tile === tile.key;
      return h('button', { class: ['lp-tile', on && 'on'], 'aria-pressed': String(on), onclick: () => { st.tile = on ? null : tile.key; persist(); render(); } },
        h('span', { class: 'lp-n' }, String(n)), h('span', { class: 'lp-label' }, tile.label), h('span', { class: 'lp-sub' }, tile.sub));
    }));
  }

  function renderBar() {
    const q = h('input', { class: 'input', type: 'search', value: st.q, placeholder: t('list.search'), 'aria-label': t('list.search'), style: { width: '200px' },
      oninput: debounce((e) => { st.q = e.target.value; persist(); render(false); }, 200) });
    mount(barEl, cfg.search ? q : null, (cfg.filters || []).map(f => {
      const id = 'lpf-' + f.key;
      return h('label', { class: 'lp-filter', for: id }, h('span', { class: 'sr-only' }, f.label),
        h('select', { class: 'input sm', id, onchange: (e) => { st.f[f.key] = e.target.value || null; persist(); render(); } },
          h('option', { value: '' }, `${f.label}: ${t('common.all')}`),
          f.options.map(o => h('option', { value: o.value, selected: String(st.f[f.key] ?? '') === String(o.value) }, o.label))));
    }));
  }

  function renderChips() {
    const chips = [];
    if (st.tile) { const tl = cfg.tiles.find(x => x.key === st.tile); if (tl) chips.push([tl.label, () => { st.tile = null; }]); }
    if (st.q) chips.push([`“${st.q}”`, () => { st.q = ''; }]);
    for (const f of cfg.filters || []) {
      const v = st.f[f.key];
      if (v == null || v === '') continue;
      chips.push([`${f.label}: ${f.options.find(o => String(o.value) === String(v))?.label ?? v}`, () => { st.f[f.key] = null; }]);
    }
    mount(chipsEl, chips.map(([label, clear]) => h('span', { class: 'chip accent' }, label,
      h('button', { 'aria-label': `${t('common.remove')} ${label}`, onclick: () => { clear(); persist(); render(); } }, '×'))),
      chips.length ? h('button', { class: 'btn ghost sm', onclick: () => { st.tile = null; st.q = ''; st.f = {}; persist(); render(); } }, t('list.clear')) : null);
    chipsEl.hidden = !chips.length;
  }

  function renderTable() {
    const rows = visible();
    const what = st.tile ? cfg.tiles.find(x => x.key === st.tile)?.label.toLowerCase() : cfg.what;
    showEl.textContent = `${t('list.showing')}: ${what} · ${rows.length} ${t('list.of')} ${cfg.rows.length}`;
    if (!rows.length) { mount(tableEl, h('div', { class: 'empty' }, t('list.none'))); return; }
    const colgroup = h('colgroup', null, h('col', { style: { width: '4px' } }), cfg.columns.map(c => h('col', { style: { width: c.width || 'auto' } })), cfg.action ? h('col', { style: { width: '120px' } }) : null);
    mount(tableEl, h('table', { class: 'table lp' }, colgroup,
      h('thead', null, h('tr', null, h('th', { 'aria-hidden': 'true' }), cfg.columns.map(c => h('th', { scope: 'col' }, c.label)), cfg.action ? h('th', { class: 'lp-act' }, h('span', { class: 'sr-only' }, t('list.action'))) : null)),
      h('tbody', null, rows.map(r => {
        const tr = h('tr', { tabindex: cfg.onOpen ? '0' : null, onkeydown: (e) => { if (e.key === 'Enter' && e.target === tr && cfg.onOpen) cfg.onOpen(r); } },
          h('td', { class: ['lp-stripe', cfg.stripe && cfg.stripe(r) ? 'st-' + cfg.stripe(r) : ''] }),
          cfg.columns.map((c, i) => {
            const text = c.value ? String(c.value(r) ?? '') : '';
            const sub = c.sub ? c.sub(r) : null;
            return h('td', { title: [text, sub].filter(Boolean).join(' — ') || null },
              h('div', { class: 'lp-clip' }, c.render ? c.render(r) : text),
              sub ? h('div', { class: 'lp-clip lp-subline' }, sub) : null);
          }),
          cfg.action ? h('td', { class: 'lp-act' }, h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); cfg.action.onClick(r); } }, cfg.action.label(r))) : null);
        if (cfg.onOpen) tr.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, select')) cfg.onOpen(r); });
        return tr;
      }))));
  }

  function render(full = true) { if (full) renderBar(); renderTiles(); renderChips(); renderTable(); }
  render();
  return { update(rows) { cfg.rows = rows; render(); }, state: st };
}
