# KMOP Co-Work

KMOP's EU project hub (brief "KMOP Project Hub", Phase 1), published as a claude.ai page:
https://claude.ai/artifact/7onhZmAq7Nz4exE8mk8aMK

- `index.html` — the whole app (no build step). Data lives in the page's shared database
  (collections: projects, deliverables, milestones, tasks (+ comments), conflicts, handled,
  overrides, kpi_values, members, activity). People sign in with their KMOP Claude account;
  who can view or edit is set with Share (Viewer / Contributor / Editor).
- `seed/build-seed.mjs` — the two pilots (EDU-WELL, YOUTH-ID) from brief §6, one JSON file per
  document. Facts the sources do not state are null; open questions are in `unconfirmed` or
  raised as conflicts. `node co-work/seed/build-seed.mjs co-work/seed/out`

Months follow the GA: M1 = the project's start month; every date is shown as M-number + month.
RAG rules (brief §7) and the urgent list are computed in the page; a PM override needs a reason
and is shown next to what the rules say.
