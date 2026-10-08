# Front-end conventions (KMOP HQ)

No framework, no build. ES modules under `public/`, served as-is.

* `public/app.js` — shell, hash router (`ROUTES`), sidebar, shortcuts. Views are lazy-imported.
* A view is `public/views/<name>.js` exporting `default async function (root, params, query)`.
  Render into `root` with `h()`/`mount()`; return a cleanup function if you subscribe to events.
  Put the page title in an `<h1>` (the router uses it for `document.title`).
  Wrap content in `h('div', {class: 'page'})` (or `'page wide'` for wide grids).
* `public/lib/dom.js` — `h(tag, props, ...children)`, `mount(el, ...children)`, `icon(name)`, date helpers.
  Strings passed as children are **text**, never HTML. Use the `html` prop only with `md()` output.
* `public/lib/api.js` — `api.get/list/post/put/patch/del/upload`. `api.get` returns `data`;
  `api.list` returns `{data, meta}` (`meta.total`, `meta.next_offset`). `api.patch(path, body, updated_at)`
  sends `If-Match` for optimistic concurrency (409 → `code: 'conflict'`).
* `public/lib/state.js` — `state.me`, `state.entities`, `state.departments`, `state.statuses`, `state.roles`,
  `state.modules`; `t(key, vars)`; `can(module, level)` (0 none, 1 read, 2 write, 3 admin);
  `emit/on` event bus (`task:changed`, `task:deleted`, `projects:changed`, `unread:changed`); `local.get/set`.
* `public/lib/ui.js` — `toast`, `showError`, `modal`, `formDialog`, `confirmDialog`, `openMenu` (keyboard
  menus/pickers with search), `avatar`, `statusPill`, `prioIcon`, `labelChip`, `dueBadge`, `fmtDate`,
  `fmtDateTime`, `timeAgo`, `relDay`, `emptyState`, `spinner`, `hours`.
* `public/lib/collection.js` — `taskCollection()` (filter bar, saved views, view switcher) and the renderer
  contract for `views/task-{list,board,timeline,calendar}.js`.
* `public/lib/task-drawer.js` — the single task editor, opened by navigating to `#/tasks/:id`.
* `public/lib/strings.js` — every UI string, `[English, Greek]`. `node scripts/check-i18n.mjs` must pass.
* `public/app.css` — tokens on `:root` with dark overrides; components use tokens only.

Rules: keyboard reachable (focusable rows, Enter opens, Esc closes), real `<label for>` on inputs,
`aria-label` on icon-only buttons, works at 390px wide, both themes, Greek strings fit.
