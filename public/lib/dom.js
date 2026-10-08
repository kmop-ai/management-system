// A tiny DOM helper. h('div', {class: 'x', onclick}, child, 'text') builds
// elements; strings are always text nodes, never HTML, so nothing a user
// typed can inject markup. The only HTML path is md() in markdown.js, which
// escapes first.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'html') el.innerHTML = v; // only for trusted, pre-escaped markup (md(), icons)
      else if (k === 'ref') v(el);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---- icons: a handful of inline SVGs, stroked with currentColor --------------
const P = {
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6H3v-6z',
  check: 'M5 12l4 4 10-10',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  folder: 'M3 7h6l2 2h10v10H3z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  calendar: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  people: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M17 11a3 3 0 100-6M22 21v-1a5 5 0 00-4-5',
  template: 'M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  shield: 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z',
  log: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 01-4 0v-.1A1.6 1.6 0 007.4 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 13.9H3a2 2 0 010-4h.1A1.6 1.6 0 004.6 7.4l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010.1 3V3a2 2 0 014 0v.1a1.6 1.6 0 002.7 1.1l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 001.1 2.7H21a2 2 0 010 4h-.1a1.6 1.6 0 00-1.5 1.3z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 6l-6 6 6 6',
  comment: 'M4 5h16v11H8l-4 4z',
  clip: 'M21 11l-9 9a5 5 0 01-7-7l9-9a3 3 0 015 5l-9 9a1.5 1.5 0 01-2-2l8-8',
  subtask: 'M6 4v10a3 3 0 003 3h9M14 13l4 4-4 4',
  link: 'M10 14a4 4 0 006 0l3-3a4 4 0 00-6-6l-1 1M14 10a4 4 0 00-6 0l-3 3a4 4 0 006 6l1-1',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 018 0v4',
  repeat: 'M17 2l4 4-4 4M3 11V9a3 3 0 013-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 01-3 3H3',
  flag: 'M5 21V4h11l-1 4 4 0-1 6H5',
  diamond: 'M12 3l9 9-9 9-9-9z',
  bell: 'M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 004 0',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z',
  board: 'M4 4h5v16H4zM10 4h5v10h-5zM16 4h4v13h-4z',
  timeline: 'M4 6h9M7 12h11M5 18h7',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2',
  filter: 'M3 5h18l-7 9v6l-4-1v-5z',
  star: 'M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.2L12 17l-5.5 3.1 1-6.2L3 9.5l6.3-.9z',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  home: 'M3 11l9-8 9 8M5 9v12h14V9',
  key: 'M15 7a4 4 0 11-3.9 5H7v3H4v-3H2V9h9.1A4 4 0 0115 7z',
};

export function icon(name, size = 16, extra = '') {
  const d = P[name] || P.more;
  const span = document.createElement('span');
  span.className = 'icon ' + extra;
  span.setAttribute('aria-hidden', 'true');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  return span;
}

// ---- dates ------------------------------------------------------------------

export const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const fmtISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtISO(d); };
export const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 86400000);
export const mondayOf = (s) => { const d = parseDate(s); const w = (d.getDay() + 6) % 7; d.setDate(d.getDate() - w); return fmtISO(d); };

// Project month for a date: M1 is the month containing the project start.
export function projectMonth(start, date) {
  if (!start || !date) return null;
  const a = parseDate(start), b = parseDate(date);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1;
}
