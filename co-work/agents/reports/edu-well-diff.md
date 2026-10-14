# EDU-WELL: draft vs seed (2026-10-14)

**Baseline used:** the signed Grant Agreement `Grant Agreement - GAP-101259873.pdf` (id 1cT37ykdpcc-bXVb7DjsQsnmzy-o1b5oE). It sits in WP1/01_Admin & Finances/GA, not in AnF. It includes the Data Sheet and Annex 1 Part A, was signed by the coordinator on 17/02/2026 and carries ref. Ares(2026)1743945. `EDU-WELL DoA_V6.docx` (id 1z0fOeOssjZgIC7NaMhuD8xWj0ZWxrFEC) fills the gaps. It is the latest Part B, and its change log ends at v5.0 (16/2/2026), which matches the GA. DoA_V4 (CARDET) is older: it predates v4.0 and v5.0, which split D1.1/D1.3 and set WP2 to M1-M14.

Abbreviations: GA = the GA PDF above; DoA6 = DoA_V6.docx; GANTT = `EDU-WELL - GANTT Chart simple.xlsx` (1o4gwECP…, in WP1/01_Admin & Finances, not AnF).

## 1. Values that differ

| Object.field | Seed value | Source value | Citation |
|---|---|---|---|
| project.title | Advancing Ethical, Comparative and Interoperable Educational Data Systems through an Adapted Welfare Index Framework | EDU-WELL: Advancing Educational Well-being through Ethical Data Innovation | GA Data Sheet: "Project name: EDU-WELL: Advancing Educational Well-being through Ethical Data Innovation". The seed title is the Part B / proposal title (DoA6 cover). |
| WP2.end | 15 | 14 | GA Part A p.4: "WP2 EDU-WELL INDEX & GOVERNANCE FRAMEWORK DESIGN 2 - ETHOS 39.50 1 14"; DoA6 log v5.0: "WP2 duration changed from M1-M15 to M1-M14 as it is officially displayed on SyGMa" |
| D2.3.due | M15 | M14 | GA Part A p.17: "D2.3 EDU-WELL Governance and Implementation Playbook WP2 2 - ETHOS R — Document, report SEN - Sensitive 14". GANTT still shows M15. |
| WP1.title | Management & QA | PROJECT MANAGEMENT & COORDINATION | GA Part A p.4 |
| WP5.title | Dissemination & Platform | DISSEMINATION, COMMUNICATION & STAKEHOLDER ENGAGEMENT | GA Part A p.4 |
| WP2/3/4 titles | short forms | EDU-WELL INDEX & GOVERNANCE FRAMEWORK DESIGN / PILOTS, DATA COLLECTION & LEARNING ANALYTICS / POLICY, IMPACT & ROADMAPPING | GA Part A p.4 (wording only) |
| partners: "DDE East Thess." | DDE East Thessaloniki (GR) | PDE CENTR MAC (PERIFEREIAKI DYETHINSI … KENTRIKIS MAKEDONIAS), PIC 930393931 | GA Preamble; DoA6 log v2.0: "Partner DDE ANAT THESS has been replaced by PDE CENTR MAC throughout, following a merge of their PICs" |
| partners: Headway.role/note | role null; "KMOP's affiliated partner" | BEN (beneficiary no. 3), PIC 887548740 | GA Data Sheet: "3 BEN HEADWAY A.E. …". The handover note's "affiliated partner" is wrong in GA terms. |
| partners: KCETB.country | null ("contact appears to be in Ireland") | IE | GA Preamble: "KILKENNY AND CARLOW EDUCATION AND TRAINING BOARD (KCETB), PIC 898529722, established in ATHY ROAD, CARLOW R93 DN80, Ireland" |
| partners.role (all except KMOP) | null | BEN | GA Data Sheet point 2 |
| D4.3.lead | KMOP PC / DCU | KMOP PC (DCU is co-lead in DoA6) | GA Part A p.18: "D4.3 EDU-WELL EU Policy Roadmap WP4 1 - KMOP PC R — Document, report PU - Public 30"; DoA6: "KMOP PC/ Co-Lead: DCU" |
| D5.2.lead | webLyzard / Headway | WLT (Headway is co-lead in DoA6) | DoA6 WP5 table: "Lead: WLTCo-Lead: Headway \| \[DEM\] \| \[PU\] \| M30" |
| D3.2.title | Dashboard beta | EDU-WELL Dashboard (Beta Version) | GA Part A p.17 (other deliverable titles differ only in wording) |
| Milestone titles (MS1-MS10) | short labels | full DoA titles, e.g. MS4 "EDU-WELL and EDU-VALUE Indicator and Architecture Finalised", MS10 "Final EU Summit Realised" | DoA6 milestone tables |
| baselines[v1].date / label | null / "Grant Agreement (original)" | GA ref. Ares(2026)1743945 of 16/02/2026; coordinator e-signature 17/02/2026 07:56 | GA p.58: "signed in the Participant … Portal on 17/02/2026" |
| sources: PWP | PWP v0.1 (1ojgR1q…, in the "Old" folder) | PWP v1.0 final (1JI4gihi97RVWTfhB_2uL8GrXPYczWHz_), dated 31/03/2026 | WP1/1.1_PWP/Final_Version |
| sources: Annex 1 | DoA_V4 (CARDET) | DoA_V6 (v5.0) and the signed GA | see top |

## 2. Facts the seed had as null (or unconfirmed) that are now found

- **type_of_action**: "ERASMUS Lump Sum Grants" (Part A: "ERASMUS-LS"). GA Data Sheet.
- **funding_model lump_sum confirmed** (seed `funding_confirmed: false`). GA Data Sheet: "Grant form: Lump Sum … Budget flexibility: No".
- **start M1 = March 2026 confirmed**. The GA starts the action on the first day of the month after entry into force, and the coordinator signed on 17/02/2026. The KOM minutes say "from 1 March 2026 to 28 February 2029". Note that the PWP cover says 02/03/2026.
- **EU contribution**: 817 067.64 EUR, of which KMOP PC gets 121 512.35. GA Data Sheet points 2 and 3. Total budget is not found (Annex 2 was not readable).
- **PICs** for all 10 beneficiaries, and 2 associated partners not in the seed: AP1 "Plattform für berufsbezogene Erwachsenenbildung (AT)" and AP2 "Evriviadeio Gymnasium (CY)". Sources: GA, DoA6 §2.2.1.
- **Tasks**: the seed had none for WP1, WP3, WP4 and WP5. The draft now has 26 tasks with months (DoA6 timetable) and leaders (GANTT Leader column). Highlights:
  - T2.1 start M1, end M3.
  - T2.4 "Development of an Interoperable Data Governance Framework", M11-M13.
  - T2.5 "Finalising EDUWELL index, EDU-VALUE subindex and governance model", M14-M15. This runs past the WP2 end in the GA (M14), which is a DoA inconsistency.
  - Leader conflicts: GANTT gives T4.1 to P1 KMOP, but the KOM minutes say "T4.1, will be led by HEADWAY". GANTT gives T5.5 to P1 KMOP, but the SC minutes list Die Berater. GANTT gives T5.4 to P3 Headway, but the SC minutes say Headway/WebLyzard.
- **Deliverable lead/type/dissemination** (all 17 were null for type/diss in the seed). Source: GA Part A list p.17-18.
  - D1.1, D1.2, D1.3: KMOP PC, R, SEN.
  - D2.1, D2.2, D2.3: ETHOS, R, SEN.
  - D3.1: DCU, R, PU.
  - D3.2: HEADWAY A.E., DEM, SEN.
  - D3.3: WLT, DEM, SEN.
  - D3.4: DCU, R, SEN.
  - D4.1: HEADWAY A.E., R, SEN.
  - D4.2, D4.3, D4.4: KMOP PC, R, PU.
  - D5.1: EMPHASYS, DEC, PU.
  - D5.2: WLT, DEM, PU.
  - D5.3: DIE BERATER, R, PU.
- **D1.2 due-month conflict resolved**: the GA says M2 ("D1.2 Quality Oversight Model and Plan WP1 1 - KMOP PC R — Document, report SEN - Sensitive 2"). The tracker's M4 is wrong.
- **Milestone leads and means of verification** (all null in the seed). Source: DoA6.
  - MS1 and MS2: KMOP PC.
  - MS3: WLT.
  - MS4: ETHOS.
  - MS5: Headway.
  - MS6: WLT.
  - MS7 and MS8: KMOP PC.
  - MS9: WLT.
  - MS10: dB (die Berater).
  - Due months match the seed: 1, 18, 3, 10, 17, 19, 26, 29, 30, 36.
  - Caveat: the DoA tables reuse labels (two "MS2", two "MS8"), and the GA Part A milestone list (p.26) was not extracted. MS1-MS10 follows GANTT.
- **Risks**: 10 critical risks with likelihood and impact (DoA6 §2.1.5).
- **Events**: 7 events from the DoA6 events table.
  - With months: E1.1 Brussels M1, E3.4 Athens M18 (GA T1.2), E1.2 Vienna M36.
  - Without months: E2.2, E3.3, E4.5 and E5.5. GANTT and the PWP give conflicting months for these.
- **KPIs**: the seed's 7 KPIs all match the KPI Monitoring Table v1.0 (OP5/SO5_8 = 17, SO1_4 = 4, SO1_10 = 60, SO5_4 = 150, SO4_4 = 5, SO5_13 = 300, SO5_16 = 5). The draft adds 26 cited KPIs. These come from an internal PM workbook and are not contractual GA targets.

## 3. Partner-list question (Üsküdar/TESEK vs CARDET/KCETB)

**Resolved.** The signed GA (Data Sheet point 2 and Annex 1 Part A) lists exactly 10 beneficiaries:

1. KMOP PC (COO, BE)
2. ETHOS (EL)
3. HEADWAY A.E. (EL)
4. PDE CENTR MAC (EL)
5. DIE BERATER (AT)
6. WLT (AT)
7. **KCETB (IE)**
8. DCU (IE)
9. EMPHASYS (CY)
10. **CARDET (CY)**

There is **no Üsküdar MEM and no TESEK Avgorou**. The changes were made during grant preparation:

- DoA6 change log v1.0: "the KCETB role and profile have been added, as P7 replacing ÜSKÜDAR MEM".
- DoA6 change log v3.0: "Partner TESEK Avgorou has been changed to CARDET throughout".
- `Official Letter_partner changes_signed.pdf` (16.02.2026) notifies EACEA of all three changes:
  - Üsküdar → KCETB
  - DDE East Thessaloniki → PDE Central Macedonia
  - TESEK Avgorou → CARDET (because TESEK "does not constitute an autonomous legal entity").

The DoA v2 files in /Application (and the KPIs.pdf draft, which still lists Türkiye) are pre-grant-preparation versions. The seed list from the minutes is right on CARDET and KCETB. The seed still needs two fixes: "DDE East Thess." should become PDE CENTR MAC, and Headway should be a BEN rather than an affiliated partner.

## 4. Other observations

- The KOM folder is named "SC_Meeting_01_KOM_BE - 7&8-03-2026", but the KOM was held on 7-8 **April** 2026 (M2). The KOM minutes are an unvalidated draft.
- The 30 Sept minutes say Greece plans 2 workshops; the seed note says Greece is "still to confirm". Both hold: Greece plans 2 and still owes its decision on survey organisation.
- A second "EDU-WELL - GANTT Chart simple.xlsx" (1Mo2ai…) exists inside AnF. It was not opened. The seed links the copy in 01_Admin & Finances.
