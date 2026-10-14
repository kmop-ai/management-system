// Builds the KMOP Co-Work seed: the two pilot projects (EDU-WELL, YOUTH-ID)
// as Baseline v1 (YOUTH-ID also v2 after Amendment 1.1), from the brief's
// section 6. Facts the sources do not state are null, never guessed; every
// open question is listed in `unconfirmed` or raised as a conflict.
//
//   node co-work/seed/build-seed.mjs <out-dir>
//
// Writes one JSON file per document: <out-dir>/<collection>/<id>.json
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node build-seed.mjs <out-dir>'); process.exit(1); }
rmSync(out, { recursive: true, force: true });
const SEEDED = '2026-10-14';
const docs = [];
const put = (collection, id, data) => docs.push({ collection, id, data });

const DRIVE = {
  eduFolder: 'https://drive.google.com/drive/folders/1AO9SIK-PEmbflm_IZoCZiqXeF3lXpDkk',
  eduDoaV4: 'https://drive.google.com/file/d/1EsU9bNyQRCnlkPwZF5SUoPMOSNWVvJa1/view',
  eduGantt: 'https://drive.google.com/file/d/1o4gwECPjPf9Rmr7b88wIvzg9AEVrfyGu/view',
  eduKpi: 'https://drive.google.com/file/d/1FRZBDvekgtzHj4ouP20XrZ3DaMtQx0F8/view',
  eduPwp: 'https://drive.google.com/file/d/1ojgR1q77cllx0kVb-Qt-kMwIsoYtAeio/view',
  eduQp: 'https://drive.google.com/file/d/1Wxsz4x7Jiv0GrwxIVkLrF6ZuZ1mIaNGR/view',
  youthFolder: 'https://drive.google.com/drive/folders/1yu64_3VXdTM1hgCJ8TGTFK3hIOuGga6G',
  youthAnnex: 'https://drive.google.com/file/d/1g3cux9VE4K0nrwVA3vYE-orH_M5jEop_/view',
  youthPwp: 'https://drive.google.com/file/d/1gu-zOUVw4TEKimj4mpGa20hLvWtxAde1/view',
};
const SRC = {
  eduSeed: 'Seed brief §6.1 (GA GANTT / deliverable tracker)',
  eduMom: 'Minutes of 30 Sept 2026 (SC meeting)',
  eduHandover: 'PM handover note, 19/05/2026',
  eduTracker: 'Deliverable tracker (Excel)',
  youthSeed: 'Seed brief §6.2 (Annex 1)',
  youthMom: 'Minutes of 17 Sept 2026 (TPM1, Strasbourg)',
};

// ---------------------------------------------------------------- EDU-WELL
const edu = 'edu-well';
put('projects', edu, {
  acronym: 'EDU-WELL',
  title: 'Advancing Ethical, Comparative and Interoperable Educational Data Systems through an Adapted Welfare Index Framework',
  programme: 'Erasmus+', action: 'Forward-Looking Projects (digital topic)', call: 'ERASMUS-EDU-2025-PI-FORWARD', type_of_action: null,
  funding_model: 'lump_sum', funding_confirmed: false,
  grant_no: '101259873', authority: 'EACEA',
  start_month: '2026-03', duration: 36,
  entity: 'KMOP PC', role: 'COORDINATOR', wp_leads: ['WP1', 'WP4'], task_leads: [],
  pm: 'Sotiria Tsalamani', pm_support: 'Julie Van Elslander', fm: 'Maria Manteli',
  status: 'implementation', drive_url: DRIVE.eduFolder,
  active_baseline: 'v1',
  baselines: [{ v: 'v1', label: 'Grant Agreement (original)', date: null, note: 'Seeded from the GA GANTT chart and deliverable tracker; to be re-derived from the signed GA Annex 1.' }],
  minutes_due_days: 7,
  wps: [
    { code: 'WP1', title: 'Management & QA', lead: 'KMOP PC', start: 1, end: 36, tasks: [] },
    { code: 'WP2', title: 'Index & Governance Framework', lead: 'Ethos Lab', co_lead: 'Headway', start: 1, end: 15, tasks: [
      { code: 'T2.1', title: 'Ecosystem mapping', start: null, end: 3, status: 'done', actual_end: null, note: 'Finalised after the planned M3; the month it finished is not recorded.', source: SRC.eduMom },
      { code: 'T2.2', title: 'Co-creation workshops', start: 4, end: 6, status: 'doing', forecast_end: 8, note: 'Consortium deadline now 30 Oct 2026. Ireland plans 2 workshops; Greece and Cyprus still to confirm; KMOP organises 1 transnational online workshop.', source: SRC.eduMom },
      { code: 'T2.3', title: 'Index methodology & design blueprint', start: 7, end: 10, status: 'not_started', note: 'Not started, yet D2.1 is due M10.', source: SRC.eduMom },
      { code: 'T2.4', title: null, start: null, end: null, status: 'not_started', note: 'Title and months not in the seed: take from the DoA.', source: SRC.eduMom },
      { code: 'T2.5', title: null, start: null, end: null, status: 'not_started', note: 'Title and months not in the seed: take from the DoA.', source: SRC.eduMom },
    ] },
    { code: 'WP3', title: 'Pilots, Data Collection & Learning Analytics', lead: 'Headway', start: 15, end: 25, tasks: [] },
    { code: 'WP4', title: 'Policy, Impact & Roadmapping', lead: 'KMOP PC', start: 25, end: 35, tasks: [] },
    { code: 'WP5', title: 'Dissemination & Platform', lead: 'Emphasys Centre', start: 1, end: 36, tasks: [] },
  ],
  partners: [
    { short: 'KMOP PC', name: 'KMOP Policy Center', country: 'BE', role: 'COO' },
    { short: 'Ethos Lab', name: 'Ethos Lab', country: 'GR', role: null },
    { short: 'Headway', name: 'Headway', country: 'GR', role: null, note: "KMOP's affiliated partner" },
    { short: 'DDE East Thess.', name: 'DDE East Thessaloniki', country: 'GR', role: null },
    { short: 'die Berater', name: 'die Berater', country: 'AT', role: null },
    { short: 'webLyzard', name: 'webLyzard technology', country: 'AT', role: null },
    { short: 'DCU', name: 'Dublin City University', country: 'IE', role: null },
    { short: 'Emphasys', name: 'Emphasys Centre', country: 'CY', role: null },
    { short: 'CARDET', name: 'CARDET', country: 'CY', role: null },
    { short: 'KCETB', name: 'KCETB', country: null, role: null, note: 'Contact appears to be in Ireland.' },
  ],
  partners_source: 'Current minutes; to be confirmed against GA Annex 1',
  kpis: [
    { id: 'k1', label: 'Pilot institutions', target: 17, op: '≥', unit: 'institutions', current: null },
    { id: 'k2', label: 'Countries mapped', target: 4, op: '≥', unit: 'countries', current: null },
    { id: 'k3', label: 'Stakeholders in co-design', target: 60, op: '≥', unit: 'people', current: null },
    { id: 'k4', label: 'Participants in co-creation / validation', target: 150, op: '≥', unit: 'people', current: null },
    { id: 'k5', label: 'Policy briefs', target: 5, op: '≥', unit: 'briefs', current: null },
    { id: 'k6', label: 'Platform visits', target: 300, op: '≥', unit: 'visits', current: null },
    { id: 'k7', label: 'Content languages', target: 5, op: '≥', unit: 'languages', current: null },
  ],
  kpi_source: 'Seed brief (sample of key KPIs); full table in EDU-WELL_KPI_Table_UPGRADED.xlsx',
  status_notes: [
    'Kick-off held in Brussels, 7–8 Apr 2026. PWP finalised.',
    'Consortium Agreement still collecting signatures (CARDET\'s turn); pre-financing to partners waits on it.',
    'WP3: role conflict between webLyzard and die Berater flagged in the handover.',
    'WP5: social media calendar and post KPIs behind; Newsletter 1 late; website not started (domain bought by webLyzard).',
    'Action tracker stale since the kick-off; deliverable tracker only partly filled.',
    'SC meetings are scheduled by Doodle (no fixed monthly slot).',
  ],
  unconfirmed: [
    'Lump sum: confirm in the GA.',
    'M1 = March 2026 is taken from the GANTT chart: confirm the start date in the signed GA.',
    'Consortium list comes from the minutes; DoA v2 lists other partners. A newer "EDU-WELL DoA_V4 (CARDET)" is in Drive.',
    'Leads, type and dissemination level of several deliverables are not in the seed.',
  ],
  sources: [
    { label: 'Project folder (EDU-WELL test)', url: DRIVE.eduFolder },
    { label: 'EDU-WELL DoA_V4 (CARDET).docx', url: DRIVE.eduDoaV4 },
    { label: 'EDU-WELL - GANTT Chart simple.xlsx', url: DRIVE.eduGantt },
    { label: 'EDU-WELL - Project Work Plan - v0.1.docx', url: DRIVE.eduPwp },
    { label: 'EDU-WELL_KPI_Table_UPGRADED.xlsx', url: DRIVE.eduKpi },
  ],
  seeded_at: SEEDED,
});

const eduD = [
  ['D1.1', 'External evaluation (mid-term)', 'WP1', null, 18],
  ['D1.2', 'Quality Oversight Model & Plan', 'WP1', null, 2],
  ['D1.3', 'External evaluation (final)', 'WP1', null, 36],
  ['D2.1', 'Index Methodology & Design Blueprint', 'WP2', 'Ethos Lab', 10],
  ['D2.2', 'Data Governance Framework', 'WP2', null, 13],
  ['D2.3', 'Governance & Implementation Playbook', 'WP2', null, 15],
  ['D3.1', 'Onboarding Toolkit & Consent Package', 'WP3', 'DCU', 17],
  ['D3.2', 'Dashboard beta', 'WP3', 'Headway', 19],
  ['D3.3', 'Operational data pipelines', 'WP3', 'webLyzard', 21],
  ['D3.4', 'Index Validation & Refinement Report', 'WP3', 'DCU', 24],
  ['D4.1', 'Comparative Insight & Policy Diagnostics Suite', 'WP4', 'Headway', 26],
  ['D4.2', 'Policy Brief Compendium', 'WP4', 'KMOP PC', 29],
  ['D4.3', 'EU Policy Roadmap', 'WP4', 'KMOP PC / DCU', 30],
  ['D4.4', 'Advocacy & Communications Toolkit', 'WP4', 'KMOP PC', 33],
  ['D5.1', 'Engagement Toolkit', 'WP5', 'Emphasys', 10],
  ['D5.2', 'Beta & Final Platform', 'WP5', 'webLyzard / Headway', 30],
  ['D5.3', 'Event Portfolio & Summit Proceedings', 'WP5', 'die Berater', 36],
];
const eduDStatus = {
  'D1.2': { status: 'accepted', note: 'Handover note: submitted and approved. The deliverable tracker still shows "In progress / Amber".', source: SRC.eduHandover, vf_url: DRIVE.eduQp },
  'D2.1': { status: 'not_started', note: 'T2.3–T2.5 not started (minutes 30 Sept 2026).', source: SRC.eduMom },
  'D5.1': { status: null, note: 'Status not recorded. WP5 is behind (minutes 30 Sept 2026).', source: SRC.eduMom },
};
for (const [code, title, wp, lead, due] of eduD) {
  const s = eduDStatus[code] || {};
  put('deliverables', `${edu}__${code}`, {
    project: edu, code, title, wp, lead, type: null, diss: null, due: { v1: due },
    status: s.status === undefined ? (due > 8 ? 'not_started' : null) : s.status,
    forecast_month: null, submitted_on: null, reviewer: null, internal_deadline: null,
    vf_url: s.vf_url || null, note: s.note || null, source: s.source || SRC.eduSeed,
  });
}
const eduMs = [
  ['MS1', 'Kick-off', 'WP1', 1, { status: 'achieved', achieved_month: 2, note: 'Kick-off held in Brussels 7–8 Apr 2026 (M2).', source: SRC.eduMom }],
  ['MS2', 'Mid-term review', 'WP1', 18],
  ['MS3', 'Ecosystem mapping completed', 'WP2', 3, { status: 'achieved', achieved_month: null, note: 'T2.1 finalised after the planned M3; month not recorded.', source: SRC.eduMom }],
  ['MS4', 'Indicator & architecture finalised', 'WP2', 10, { status: 'at_risk', note: 'Depends on T2.3, not started.', source: SRC.eduMom }],
  ['MS5', 'Pilots onboarded', 'WP3', 17],
  ['MS6', 'System deployed in pilots', 'WP3', 19],
  ['MS7', 'Regional disparity analysis', 'WP4', 26],
  ['MS8', 'Policy briefs & roadmap', 'WP4', 29],
  ['MS9', 'Platform deployed', 'WP5', 30],
  ['MS10', 'Final EU summit', 'WP5', 36],
];
for (const [code, title, wp, due, s = {}] of eduMs) put('milestones', `${edu}__${code}`, {
  project: edu, code, title, wp, lead: null, due: { v1: due }, status: s.status || 'planned',
  achieved_month: s.achieved_month ?? null, forecast_month: null, verification: null, note: s.note || null, source: s.source || SRC.eduSeed,
});

// ---------------------------------------------------------------- YOUTH-ID
const yid = 'youth-id';
put('projects', yid, {
  acronym: 'YOUTH-ID',
  title: 'Building Youth capacities on Inclusive community Design through participatory and intersectional training',
  programme: 'Erasmus+', action: 'Youth Together', call: 'ERASMUS-YOUTH-2025-YOUTH-TOG', type_of_action: 'ERASMUS-LS',
  funding_model: 'lump_sum', funding_confirmed: true,
  grant_no: '101244943', authority: 'EACEA',
  start_month: '2026-01', duration: 24,
  entity: 'KMOP PC', role: 'COORDINATOR', wp_leads: ['WP1'], task_leads: ['T4.3'], deliverable_leads: ['D4.2'],
  pm: null, pm_support: null, fm: null,
  status: 'implementation', drive_url: DRIVE.youthFolder,
  active_baseline: 'v2',
  baselines: [
    { v: 'v1', label: 'Grant Agreement (original)', date: null, note: 'Includes KMOP Skopje as beneficiary.' },
    { v: 'v2', label: 'Amendment v1.1', date: '2026-05-26', note: 'KMOP Skopje left. Its tasks moved to KMOP PC (coordination, methodology, online delivery, evaluation) and the ALDA Skopje team (local delivery in North Macedonia). Effort per WP unchanged.' },
  ],
  minutes_due_days: 7,
  wps: [
    { code: 'WP1', title: 'Management', lead: 'KMOP PC', start: 1, end: 24, tasks: [] },
    { code: 'WP2', title: 'Building Inclusive Capacities', lead: 'ALDA', start: 1, end: 15, tasks: [
      { code: 'T2.4', title: 'National seminars (25 youth workers per partner)', start: null, end: null, status: 'not_started', forecast_end: 14, note: 'By end Jan / early Feb 2027; D2.4 drafts 10 Feb, submit by 28 Feb 2027.', source: SRC.youthMom },
    ] },
    { code: 'WP3', title: 'Empowering Youth Capacities', lead: 'CSC Danilo Dolci', start: 9, end: 18, tasks: [
      { code: 'T3.2', title: 'Youth trainings', start: null, end: null, status: 'not_started', forecast_start: 12, forecast_end: 16, note: 'Planned Dec 2026 – Apr 2027.', source: SRC.youthMom },
      { code: 'T3.3', title: 'Simulations', start: null, end: 17, status: 'not_started', note: 'Must finish by M17 together with D3.2; the schedule is tight.', source: SRC.youthMom },
    ] },
    { code: 'WP4', title: 'Transformative Youth-led Initiatives', lead: 'PROM', start: 17, end: 24, tasks: [
      { code: 'T4.3', title: 'Youth dialogue with policy makers / EU Youth Advocacy Marathon (Brussels)', lead: 'KMOP PC', start: null, end: null, status: 'not_started', note: 'Policy dialogues Jul–Nov 2027.', source: SRC.youthMom },
    ] },
    { code: 'WP5', title: 'Digital Platform & Dissemination', lead: 'Headway', start: 1, end: 24, tasks: [] },
  ],
  partners: [
    { short: 'KMOP PC', name: 'KMOP Policy Center', country: 'BE', role: 'COO' },
    { short: 'ALDA', name: 'ALDA (incl. Skopje team)', country: 'FR', role: 'BEN' },
    { short: 'CSC', name: 'CSC Danilo Dolci', country: 'IT', role: 'BEN' },
    { short: 'PROM', name: 'PROM', country: 'PL', role: 'BEN' },
    { short: 'Headway', name: 'Headway', country: 'GR', role: 'BEN' },
    { short: 'KOKEN', name: 'KOKEN', country: 'CY', role: 'BEN' },
    { short: 'KMOP Skopje', name: 'KMOP Skopje', country: 'MK', role: 'BEN', baselines: ['v1'], note: 'Left with Amendment v1.1 (26 May 2026).' },
    { short: 'JE Strasbourg', name: 'Jeunes Européens Strasbourg', country: 'FR', role: 'AP' },
    { short: 'ADL Zavidovici', name: 'ADL Zavidovici', country: 'IT', role: 'AP' },
    { short: 'Edremit', name: 'Edremit Municipality', country: 'TR', role: 'AP' },
    { short: 'YS West Pomerania', name: 'Youth Secretariat West Pomerania', country: 'PL', role: 'AP' },
    { short: 'YC Akrounta', name: 'Youth Club of Akrounta', country: 'CY', role: 'AP' },
    { short: 'Opstina Vinica', name: 'Opstina Vinica', country: 'MK', role: 'AP' },
  ],
  partners_source: SRC.youthSeed,
  kpis: [
    { id: 'k1', label: 'Youth workers trained (3/partner in ToT + 25/partner nationally)', target: 190, op: '≥', unit: 'people', current: null },
    { id: 'k2', label: 'Young people trained', target: 60, target_max: 90, op: '', unit: 'people', current: null },
    { id: 'k3', label: 'Participants with fewer opportunities', target: 30, op: '≥', unit: '%', current: null },
    { id: 'k4', label: 'Participants reporting increased knowledge', target: 80, op: '≥', unit: '%', current: null },
    { id: 'k5', label: 'Policy dialogues (18 national + 1 transnational)', target: 19, op: '', unit: 'dialogues', current: null },
    { id: 'k6', label: 'Policy papers (6 briefs + White Paper)', target: 7, op: '', unit: 'papers', current: null },
    { id: 'k7', label: 'Online Fair + final conference participants', target: 200, op: '', unit: 'people', current: null, conflict: true },
  ],
  kpi_source: SRC.youthSeed,
  status_notes: [
    'Done: D1.1, D1.4, D5.1, D5.2 (platform and website); amendment finalised; ToT held in Strasbourg.',
    'WP4 calendar: Design Labs Apr–Jul 2027; Youth Exchange in Poland Jul 2027; policy dialogues Jul–Nov 2027; Online Fair Nov 2027.',
    'Lessons from ToT to watch as risks: uneven engagement, English-fluency barriers, agenda too long and top-down, need for more inclusive facilitation. Build in accessibility for participants with disabilities.',
    'Conventions: project name in every email subject; deliverable files "Youth-ID_D[no]_…"; working docs "Youth-ID_WP[no]-working document".',
  ],
  unconfirmed: [
    'M1 = January 2026 is inferred from TPM1 (17 Sept 2026) being the planned M9 meeting: confirm the GA start date.',
    'PM and Financial Manager are not named in the seed.',
    'Check whether D2.1 (due M8) was already submitted to the EC.',
  ],
  sources: [
    { label: 'Project folder (YOUTH-ID test)', url: DRIVE.youthFolder },
    { label: 'Youth-ID_Annex-1_Amendment_v5.docx', url: DRIVE.youthAnnex },
    { label: 'YOUTH_ID_D1.1 PWP & Ethics Protocol v0.3', url: DRIVE.youthPwp },
  ],
  seeded_at: SEEDED,
});

const yD = [
  ['D1.1', 'PWP & Ethics Protocol', 'WP1', 'KMOP PC', 5, { status: 'submitted', vf_url: DRIVE.youthPwp }],
  ['D1.2', 'QAEP + internal evaluation reports', 'WP1', 'Headway', 24, { status: 'drafting', note: 'QAEP to be submitted and reopened; first evaluation Jan 2027.' }],
  ['D1.3', 'Project meetings report', 'WP1', 'KMOP PC', 24],
  ['D1.4', 'Progress Report', 'WP1', 'KMOP PC', 6, { status: 'submitted' }],
  ['D2.1', 'Digital Handbook & ToT materials', 'WP2', 'ALDA', 8, { status: 'drafting', forecast_month: 10, note: 'Content complete but being revised after ToT feedback (new facilitation section); revised EN version 26–28 Oct. Check whether it was already submitted to the EC.' }],
  ['D2.2', 'ToT Evaluation Report', 'WP2', 'Headway', 10, { status: 'drafting', forecast_month: 10, note: 'Partner inputs asked for "beginning of October".' }],
  ['D2.3', 'Translated & Published Training Materials', 'WP2', 'ALDA', 13, { status: 'drafting', forecast_month: 12, note: 'Translations into the Canva template by 16 Nov; layout by Headway by 18 Dec; deliverable by 31 Dec 2026.' }],
  ['D2.4', '6 National Training Reports', 'WP2', 'ALDA', 15, { forecast_month: 14, note: 'Drafts 10 Feb, submit by 28 Feb 2027.' }],
  ['D3.1', 'Training Materials & Simulations for Youth', 'WP3', 'CSC', 15, { status: 'drafting', note: 'Module structure first half of Oct; drafts 16 Nov; final end Nov.' }],
  ['D3.2', 'Trainings & simulations reports', 'WP3', 'KOKEN', 17, { note: 'Trainings Dec 2026–Apr 2027; simulations must also finish by M17.' }],
  ['D3.3', 'Impact Assessment Report', 'WP3', 'Headway', 18],
  ['D4.1', 'Youth-led Activities Report', 'WP4', 'PROM', 24],
  ['D4.2', 'Policy Briefs & White Paper', 'WP4', 'KMOP PC', 24],
  ['D5.1', 'Dissemination & Exploitation Plan', 'WP5', 'Headway', 3, { status: 'submitted' }],
  ['D5.2', 'Digital Platform & Website', 'WP5', 'Headway', 8, { status: 'submitted' }],
  ['D5.3', 'Dissemination Activities Report', 'WP5', 'Headway', 24],
];
for (const [code, title, wp, lead, due, s = {}] of yD) put('deliverables', `${yid}__${code}`, {
  project: yid, code, title, wp, lead, type: null, diss: null, due: { v1: due, v2: due },
  status: s.status || 'not_started', forecast_month: s.forecast_month ?? null, submitted_on: null, reviewer: null,
  internal_deadline: null, vf_url: s.vf_url || null, note: s.note || null, source: s.note || s.status ? SRC.youthMom : SRC.youthSeed,
});
const yMs = [
  ['MS1', 'Kick-off', 'WP1', 1, { status: null, note: 'Status not recorded in the seed.' }],
  ['MS2', 'Mid-term QA review', 'WP1', 13],
  ['MS3', 'ToT completed', 'WP2', 10, { status: 'achieved', achieved_month: 9, note: 'ToT held in Strasbourg alongside TPM1 (Sept 2026).' }],
  ['MS4', 'Materials finalised & translated', 'WP2', 13],
  ['MS5', 'Local youth groups established', 'WP3', 12, { forecast_month: 10, note: 'Local youth groups by 26 Oct 2026, ahead of plan.' }],
  ['MS6', 'Youth trainings & simulations completed', 'WP3', 17],
  ['MS7', 'Evaluation of youth empowerment', 'WP3', 18],
  ['MS8', 'Design labs completed', 'WP4', 20],
  ['MS9', 'Advocacy events completed', 'WP4', 24],
  ['MS10', 'Platform launched', 'WP5', 8, { status: 'achieved', achieved_month: null, note: 'D5.2 platform and website done; month not recorded.' }],
  ['MS11', 'Community showcases completed', 'WP4', 23],
  ['MS12', 'Consortium Agreement', 'WP1', 1, { status: null, note: 'Signature status not in the seed.' }],
];
for (const [code, title, wp, due, s = {}] of yMs) put('milestones', `${yid}__${code}`, {
  project: yid, code, title, wp, lead: null, due: { v1: due, v2: due }, status: 'status' in s ? s.status : 'planned',
  achieved_month: s.achieved_month ?? null, forecast_month: s.forecast_month ?? null, verification: null,
  note: s.note || null, source: s.note ? SRC.youthMom : SRC.youthSeed,
});

// ---------------------------------------------------------------- tasks
let n = 0;
const task = (project, t) => put('tasks', `seed-${project}-${String(++n).padStart(2, '0')}`, {
  project, status: 'todo', owner_kind: 'partner', owner_user: null, owner_partner: null, due: null, wp: null, deliverable: null,
  coordinator_blocker: false, since: null, note: null, watchers: [], subtasks: [], links: [], comments: [],
  created_by: 'seed', created_at: `${SEEDED}T08:00:00Z`, updated_at: `${SEEDED}T08:00:00Z`, ...t,
});
task(edu, { title: 'Collect the remaining Consortium Agreement signatures (CARDET\'s turn)', status: 'blocked', owner_partner: 'CARDET', wp: 'WP1', coordinator_blocker: true, since: '2026-05-19', note: 'Pre-financing to partners waits on it. Open since at least the handover (19/05/2026).', source: SRC.eduMom });
task(edu, { title: 'Distribute pre-financing to partners', status: 'blocked', owner_kind: 'kmop', wp: 'WP1', coordinator_blocker: true, since: '2026-05-19', note: 'Waits on the Consortium Agreement. Handover: 1st instalment pending.', source: SRC.eduHandover });
task(edu, { title: 'Confirm the status of the revised Partnership Agreement', owner_kind: 'kmop', wp: 'WP1', coordinator_blocker: true, since: '2026-05-19', note: 'Pending at handover (19/05/2026); current status not recorded.', source: SRC.eduHandover });
task(edu, { title: 'Organise the transnational online co-creation workshop (T2.2)', status: 'doing', owner_kind: 'kmop', due: '2026-10-30', wp: 'WP2', source: SRC.eduMom });
task(edu, { title: 'Confirm the co-creation workshops in Greece and Cyprus (T2.2)', owner_partner: 'Greek and Cypriot partners', due: '2026-10-30', wp: 'WP2', source: SRC.eduMom });
task(edu, { title: 'Start T2.3–T2.5 so D2.1 can be delivered by M10 (Dec 2026)', owner_partner: 'Ethos Lab', wp: 'WP2', deliverable: 'D2.1', source: SRC.eduMom });
task(edu, { title: 'Organise the WP3 coordination meeting with Headway and webLyzard', owner_kind: 'kmop', wp: 'WP3', source: SRC.eduMom });
task(edu, { title: 'Send partner logos', owner_partner: 'All partners', due: '2026-10-09', wp: 'WP5', source: SRC.eduMom });
task(edu, { title: 'Publish Newsletter 1 (was expected in July)', owner_partner: 'Emphasys Centre', wp: 'WP5', note: 'Late; no new date set.', source: SRC.eduMom });
task(edu, { title: 'Start the project website (domain bought by webLyzard)', owner_partner: 'webLyzard', wp: 'WP5', source: SRC.eduMom });
task(edu, { title: 'Update the action tracker with the ~20 actions from the 30 Sept 2026 minutes', owner_kind: 'kmop', wp: 'WP1', source: SRC.eduMom });
n = 0;
task(yid, { title: 'Collect partner inputs for D2.2 ToT Evaluation Report', status: 'doing', owner_partner: 'Headway', due: '2026-10-31', wp: 'WP2', deliverable: 'D2.2', note: 'Inputs asked for "beginning of October"; due M10.', source: SRC.youthMom });
task(yid, { title: 'Check whether D2.1 was already submitted to the EC', owner_kind: 'kmop', wp: 'WP2', deliverable: 'D2.1', source: SRC.youthMom });
task(yid, { title: 'Revised EN version of the D2.1 Handbook (new facilitation section)', status: 'doing', owner_partner: 'ALDA', due: '2026-10-28', wp: 'WP2', deliverable: 'D2.1', source: SRC.youthMom });
task(yid, { title: 'Associated-partner MoU spreadsheet', owner_partner: 'All partners', due: '2026-09-30', wp: 'WP3', source: SRC.youthMom });
task(yid, { title: 'WP3 module structure', status: 'doing', owner_partner: 'CSC Danilo Dolci', due: '2026-10-15', wp: 'WP3', deliverable: 'D3.1', source: SRC.youthMom });
task(yid, { title: 'Establish local youth groups (MS5)', owner_partner: 'All partners', due: '2026-10-26', wp: 'WP3', source: SRC.youthMom });
task(yid, { title: 'Translate training materials into the Canva template (D2.3)', owner_partner: 'All partners', due: '2026-11-16', wp: 'WP2', deliverable: 'D2.3', source: SRC.youthMom });
task(yid, { title: 'WP3 module drafts', owner_partner: 'CSC Danilo Dolci', due: '2026-11-16', wp: 'WP3', deliverable: 'D3.1', source: SRC.youthMom });
task(yid, { title: 'D2.3 layout', owner_partner: 'Headway', due: '2026-12-18', wp: 'WP2', deliverable: 'D2.3', source: SRC.youthMom });
task(yid, { title: 'Submit the QAEP (D1.2) and reopen it for the first evaluation', owner_partner: 'Headway', wp: 'WP1', deliverable: 'D1.2', source: SRC.youthMom });

// ---------------------------------------------------------------- conflicts
const conflict = (id, c) => put('conflicts', id, { status: 'open', resolved_by: null, resolved_at: null, raised_at: `${SEEDED}T08:00:00Z`, ...c });
conflict('edu-well__D1.2-due', { project: edu, object: 'D1.2', field: 'Due month', reason: 'The GA GANTT/DoA and the deliverable tracker give different due months.', entries: [
  { source: 'GA GANTT / DoA', rank: 1, value: 'M2', url: DRIVE.eduGantt },
  { source: SRC.eduTracker, rank: 5, value: 'M4', url: null },
] });
conflict('edu-well__D1.2-status', { project: edu, object: 'D1.2', field: 'Status', reason: 'The deliverable tracker was not updated after the Quality Plan was approved.', entries: [
  { source: SRC.eduHandover, rank: 5, value: 'Submitted and approved', url: null },
  { source: SRC.eduTracker, rank: 5, value: 'In progress / Amber', url: null },
] });
conflict('edu-well__consortium', { project: edu, object: 'Consortium', field: 'Partners', reason: 'The DoA in /Application and the current minutes list different partners. The GA Annex 1 prevails.', entries: [
  { source: 'DoA v2 (/Application)', rank: 1, value: 'Includes Üsküdar (TR) and TESEK Avgorou (CY)', url: null },
  { source: SRC.eduMom, rank: 3, value: 'Includes CARDET (CY) and KCETB (contact in Ireland)', url: null },
  { source: 'EDU-WELL DoA_V4 (CARDET).docx', rank: 1, value: 'Newer version found in Drive; not yet read', url: DRIVE.eduDoaV4 },
] });
conflict('edu-well__action-tracker', { project: edu, object: 'Action tracker', field: 'Open actions', reason: 'The action tracker has not been updated since the kick-off, while the 30 Sept 2026 minutes contain about 20 new actions.', entries: [
  { source: 'Action tracker (Excel)', rank: 5, value: 'Last updated at the kick-off', url: null },
  { source: SRC.eduMom, rank: 3, value: '~20 new actions', url: null },
] });
conflict('youth-id__kpi-conference', { project: yid, object: 'KPI', field: 'Online Fair + final conference participants', reason: 'Annex 1 and the TPM1 minutes give different targets. Annex 1 prevails unless amended.', entries: [
  { source: 'GA Annex 1', rank: 1, value: '200', url: DRIVE.youthAnnex },
  { source: SRC.youthMom, rank: 3, value: '300', url: null },
] });

for (const d of docs) {
  const dir = join(out, d.collection);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${d.id}.json`), JSON.stringify(d.data, null, 1));
}
writeFileSync(join(out, 'index.json'), JSON.stringify(docs.map(d => ({ collection: d.collection, id: d.id }))));
const by = docs.reduce((a, d) => (a[d.collection] = (a[d.collection] || 0) + 1, a), {});
console.log(`${docs.length} documents`, by);
