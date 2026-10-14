# YOUTH-ID: source vs seed diff

Sources: **A5** = `Youth-ID_Annex-1_Amendment_v5.docx` (1g3cux9VE4K0nrwVA3vYE-orH_M5jEop_, baseline v2). **GA** = `Youth-ID_Annex-1_Amendment_Initial.docx` (1ILkKyqjGWZqipHbCUw0TCQSfEAXqekSm, the original signed MGA + Annex 1, v1). **PWP** = `YOUTH_ID_D1.1_..._v0.3_KMOPPC.docx` (1gu-zOUVw4TEKimj4mpGa20hLvWtxAde1). **KoM** = `PPT KoM YouthID.pptx` (1UH-AMOCfwQ9W0bf59ouDLLTNDvtPuAXN). **MoM-x** = minutes files (see youth-id-minutes.json).
The full verbatim citations are in `youth-id-draft.json` and `youth-id-minutes.json`.

## 1. Start date / M1 (the most important correction)
| Field | Seed | Source | Citation |
|---|---|---|---|
| start_month | 2026-01 (inferred) | **2025-12** (M1 = Dec 2025, M24 = Nov 2027) | A5 Part A cover: "Project starting date: … 01 December 2025"; PWP: "\| Project Starting Date \| 01/12/2025 \|"; PWP: "Duration: December 2025 (M1) – November 2027 (M24)"; KoM: "24 Months: 01 Dec 2025 – 30 Nov 2027" |

TPM1 (17 Sept 2026) was planned for M9 (A5 T1.4: "The first physical meeting will be organised by ALDA in M9 in France"). It actually took place in **M10**, so the seed's inference was wrong. As a result, every month number the seed worked out from minutes dates is one month too low:

| Object | Seed value | Corrected (M1 = Dec 2025) | Basis |
|---|---|---|---|
| D2.1 forecast_month | 10 | 11 (revised EN version 26–28 Oct 2026). Due M8 = Jul 2026, so it is **overdue** | MoM-17.09 |
| D2.2 forecast_month | 10 | 11 (inputs "beginning of October"). Due M10 = Sep 2026, so it is **late** | MoM-17.09 |
| D2.3 forecast_month | 12 | 13 (31 Dec 2026), on time against M13 | MoM-17.09 |
| D2.4 forecast_month | 14 | 15 (submit 28 Feb 2027), on time against M15 | MoM-17.09 |
| MS3 achieved_month | 9 | 10 (ToT held Sept 2026), on the due month M10 | MoM-17.09 |
| MS5 forecast_month | 10 | 11 (26 Oct 2026), ahead of M12 | MoM-17.09 |
| T2.4 forecast_end | 14 | 14–15 (end Jan / first week Feb 2027) | MoM-17.09 |
| T3.2 forecast_start / forecast_end | 12 / 16 | 13 / 17 (Dec 2026 – Apr 2027) | MoM-17.09. PWP plans T3.2 for M11–M17 |

## 2. Project-level fields
| Field | Seed | Source | Citation |
|---|---|---|---|
| pm | null | **Suada Ismailaja** (KMOP PC) | A5 staff table: "Suada Ismailaja, Fundraising & Implementation Manager \| KMOP PC \| Project Manager"; KoM: "Suada Ismailaja, Project Manager"; A5 Part B: "Coordinator contact: Suada ISMAILAJA, KMOP PC" |
| fm | null | **Maria Manteli** | KoM slide "Financial Management": "Maria Manteli (Financial Manager)" |
| pm_support | null | Possibly Julie Van Elslander ("Project Officer", KoM). From May 2026 Sotiria Tsalamani (KMOP PC) chairs WP1 in the minutes and the TPM. A PM handover is possible but no document records it | KoM: "Julie Van Elslander, Project Officer"; MoM-28.05/28.07/17.09 |
| eu_contribution | absent | 431,301.64 EUR (v1, original GA). The v2 split was not read | GA Data Sheet: "\| 431 301.64 \| 431 301.64 \|" |
| kmop_share | absent | KMOP PC 94,398.26 EUR (v1). The v2 figure was not read | GA participants table |
| total_budget | absent | not found (lump sum: only the maximum grant amount is stated) | — |
| baselines.v1.date | null | GA document reference date 03/11/2025. The signature date was not found | "Ref. Ares(2025)9433134 - 03/11/2025" |
| funding_model / type / call / grant_no / authority / duration / title | as seed | match | A5 cover, GA Data Sheet ("Grant form: Lump Sum") |

## 3. Work packages and tasks
| Field | Seed | Source (A5) |
|---|---|---|
| WP1 title | "Management" | "Project management and coordination" |
| WP2 title | "Building Inclusive Capacities" | "Preparation phase: Building Inclusive Capacities" |
| WP4 title | "Transformative Youth-led Initiatives" | "Transformative Youth led Initiatives" (cosmetic) |
| WP leads / start / end | KMOP PC 1–24, ALDA 1–15, CSC 9–18, PROM 17–24, Headway 1–24 | match |
| tasks | 4 partial tasks (T2.4, T3.2, T3.3, T4.3) | 24 tasks with leads (A5) and start/end months (PWP); see the draft |
| T3.2 title | "Youth trainings" | "Training for Local Youth Groups" (PWP: "Trainings & Simulation activities material + Training for Local Youth Groups Training"), M11–M17 |
| T3.3 | end 17, lead not set | lead KOKEN, M14–M17 (PWP) |
| task_leads (KMOP PC) | [T4.3] | **T1.1, T1.2, T1.4, T1.5, T1.6, T4.3** (A5 "Lead: KMOP PC") |

## 4. Deliverables
- **type and diss are null in the seed for all 16 deliverables.** Per A5: type is R for all except D5.2 = DEC. Dissemination level is SEN for D1.1, D1.2, D1.3, D1.4, D2.1, D2.2, D2.4 and D5.1, and PU for D2.3, D3.1, D3.2, D3.3, D4.1, D4.2, D5.2 and D5.3.
- The codes, WPs, leads and due months all match A5: D1.1 M5, D1.2 M24 (Headway), D1.3 M24, D1.4 M6, D2.1 M8, D2.2 M10 (Headway), D2.3 M13, D2.4 M15, D3.1 M15, D3.2 M17 (KOKEN), D3.3 M18 (Headway), D4.1 M24, D4.2 M24, D5.1 M3, D5.2 M8 and D5.3 M24. The seed titles are shortened.
- **deliverable_leads** for KMOP PC: the seed has [D4.2]. A5 gives **D1.1, D1.3, D1.4 and D4.2**.
- The TPM slides count "15 Deliverables", but A5 lists **16**.
- Status changes from the minutes:
  - D1.1: seed "submitted" → **accepted**. MoM-28.05: "The deliverable was approved by the PO." The PWP records its delivery date as 24/03/2026.
  - D1.4: seed "submitted" → **accepted**. MoM-28.07: "officially approved by the Project Officer". It was submitted on 29 May 2026 (MoM-28.05).
  - D1.3: seed "not_started" → **drafting** (MoM-17.09: "ongoing").
  - D2.1: seed "drafting" → **revision**. **Nothing in any source says D2.1 was submitted to the EC.** MoM-17.09 says it "is complete, but still to be refined", and the TPM slides say "– to be refined".
  - D5.1 and D5.2: seed "submitted". The minutes say only "completed" and "Finalised". The Drive file title "YOUTH-ID_5.1_Dissemination & Exploitation Plan_final submission.pdf" suggests D5.1 was submitted. No minutes state a submission date for D5.2.

## 5. Milestones
- **The leads are null in the seed.** Per A5: MS1 KMOP PC, MS2 Headway, MS3 ALDA, MS4 ALDA, MS5 CSC, MS6 CSC, MS7 Headway, MS8 PROM, MS9 KMOP PC, MS10 Headway, MS11 CSC, MS12 KMOP PC.
- **MS11 wp**: the seed has WP4. A5 has **WP5** ("\| 11 \| Community Project Showcases Completed \| WP5 \| 3 - CSC").
- verification is null in the seed and is now filled from A5, which gives a means of verification for every MS.
- The due months match A5.
- Status: MS1 is null in the seed. The kick-off was held on 12 Dec 2025 (M1, KoM slides), so MS1 can be marked achieved. MS12 (Consortium Agreement) stays unknown, because its evidence sits in AnF, which was not read. MS10 is achieved (MoM-17.09).

## 6. KPIs
- **k7 Online Fair + final conference: Annex 1 says 200.** A5 Part B indicators: "No. of participants in the Online Fair & Final Project Conference \| 0 \| At least 200 attendees (WP4, WP5)". T4.4 and T5.6 also say "(200 participants)", and the events table E1.9 gives "200". The figure is the same in vf(5) and in the original GA.
  - MoM-17.09 says "a high KPI of 300 participants for the final conference" in WP5. The same minutes, in WP4, say "Target of 200 participants" for the Online Fair. The 300 has no basis in Annex 1. Keep 200 and resolve the conflict as "Annex 1 prevails".
- k1 (190), k2 (60–90), k3 (≥30%), k4 (≥80%), k5 (18+1), k6 (7): all match A5.
- The seed is missing 20+ other indicators that are in A5. They are in the draft and include: ≥75% confident advocating, 6 youth groups, 6 design labs, 6 simulations, 6 social-media takeovers, 50,000 social reach, ≥20 online resources, ≥180 showcase attendees, ≥150 platform users, ≥1,500 website visitors, 2 e-newsletters, 7 languages, 6 Marathon youth, ≥12 virtual PSC meetings and 2 physical meetings (M9, M20).

## 7. Partners (per the amendment, baseline v2)
| # | Role | Short (A5) | Legal name (A5) | Ctry | PIC | Seed difference |
|---|---|---|---|---|---|---|
| 1 | COO | KMOP PC | KMOP - POLICY CENTER ASBL | BE | 892256732 | seed has no PIC (applies to every row) |
| 2 | BEN | ALDA (+ Skopje team for North Macedonia, no separate PIC) | ALDA - Association Européenne pour la Démocratie Locale | FR | 963194384 | none |
| 3 | BEN | CSC | Centro per lo Sviluppo Creativo Danilo Dolci - ETS | IT | 944654774 | none |
| 4 | BEN | PROM | Polska Rada Organizacji Młodzieżowych | PL | 942247040 | none |
| 5 | BEN | HEADWAY A.E. | Headway - Symvouloi - Oikonomologoi A.E. | **EL** | 887548740 | seed country "GR" |
| 6 | BEN | KOKEN | Kipriakos Organismos Kentron Neotitas KOKEN Ltd | CY | 945054123 | none |
| (7) | BEN, v1 only | KMOP MK | Family and Childcare Center – branch in Skopje | MK | 909212623 | seed short "KMOP Skopje". Withdrawn in v1.1 (26/05/2026) |
| 8 | AP | JE | Jeunes Européens - Strasbourg | FR | 936949482 | seed short "JE Strasbourg" |
| 9 | AP | ADL ZAVIDOVICI | ADL a Zavidovici Società Cooperativa Sociale | IT | 905168984 | none |
| 10 | AP | EDREMIT | Edremit Belediyesi | TR | 927849815 | none |
| 11 | AP | YSWVP | Sekretariat ds. Młodzieży Województwa Zachodniopomorskiego | PL | 944427018 | seed short "YS West Pomerania" |
| 12 | AP | YC AKROUNTA | Kentro Neotitos Akrountas - Youth Club of Akrounta | CY | 878571390 | none |
| 13 | AP | Opstina VINICA | Opstina Vinica | MK | 937817244 | none |

The source for the amendment is the A5 history of changes v1.1: "Family and Childcare Center – branch in Skopje (BEN 7) left the partnership and their tasks we redistributed between KMOP PC (COO) and ALDA (Skopje team – BEN 2)".

Caveat: A5 Part A (portal tables: participants, effort, task participants) still lists KMOP MK. The later clean file `Youth-ID_Annex-1_Amendment_vf (5).docx` (Application/11.Amendment-KMOP-Skopje) removes it. Two copies inside AnF were not opened: "ΑΝΝΕΧ1_AMENDMENT FINAL.docx" and "Youth-ID_Annex-1_Amendment_vf (1).docx".

## 8. Other
- Risks: A5 has 10 critical risks; the seed has none, and they are in the draft. Likelihood and impact are not rated in A5. The PWP rates only risk 1 ("low-likelihood but high-impact").
- No kick-off minutes exist in Drive. Only slides exist, and MoM-17.02 is the earliest set of minutes.
- The seed's naming convention "Youth-ID_D[no]_…" differs from the TPM slides, which give "Youth-ID_Deliverable number-vX".
