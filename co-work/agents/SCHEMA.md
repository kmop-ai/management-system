# Agent output formats (KMOP Co-Work, Phase 2)

Every extracted fact carries a citation: `cite = {file_id, file_title, loc, quote}`
(`loc` = page / section / table / slide; `quote` = at most 200 characters copied from the source).
Facts not found in the sources are `null` with the field listed in `not_found`. Never guess.

## Onboarding draft — `<project>-draft.json`
{
  "project": "edu-well",
  "baseline_label": "GA Annex 1 (DoA V4)",          // which document version this draft represents
  "sources": [{"file_id","title","url","role": "GA|Annex1|DoA|PWP|Gantt|Amendment|other","note"}],
  "fields": {"acronym","title","grant_no","call","type_of_action","funding_model": "lump_sum|actual_costs",
             "authority","start_month": "YYYY-MM","duration": 36,"total_budget","eu_contribution","kmop_share"}
            // each value: {"value": ..., "cite": {...}} or null
  "wps": [{"code","title","lead","start","end","cite","tasks": [{"code","title","lead","start","end","cite"}]}],
  "deliverables": [{"code","title","wp","lead","type","diss","due_month","cite"}],
  "milestones": [{"code","title","wp","lead","due_month","verification","cite"}],
  "partners": [{"name","short","country","role": "COO|BEN|AE|AP","pic","cite"}],
  "kpis": [{"label","target","unit","so","cite"}],
  "risks": [{"description","likelihood","impact","mitigation","cite"}],
  "events": [{"type","title","month","location","format","expected_participants","cite"}],
  "not_found": ["..."],
  "notes": ["anything uncertain, one sentence each"]
}

## Minutes suggestions — `<project>-minutes.json`
{
  "project": "edu-well",
  "meetings": [{"file_id","title","url","date": "YYYY-MM-DD","type": "kick-off|SC|TPM|other"}],
  "suggestions": [{
    "kind": "action|status_change|risk|decision",
    "meeting_file_id": "...",
    "title": "short imperative sentence",
    "description": "one or two sentences",
    "owner": "partner short name or KMOP person, as written", "owner_kind": "kmop|partner|unknown",
    "due": "YYYY-MM-DD or null", "wp": "WP2 or null", "deliverable": "D2.1 or null",
    "new_status": "for status_change: not_started|drafting|internal_review|validated|submitted|accepted|revision|done|doing",
    "target": "for status_change: the deliverable/milestone/task code",
    "cite": {"file_id","file_title","loc","quote"}
  }]
}
