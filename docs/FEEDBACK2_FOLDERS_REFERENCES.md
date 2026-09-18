# Feedback 2 — learning folders

2026-09-18. Mobbin iOS screens were retrieved with `search_screens` and all 10 returned images were inspected inline, in batches of 3–4. Eight screens informed the implementation; two were rejected as weak matches. No screen is presented as a live flow test of its source app.

## Inspected references and decisions

| Reference | Observed pattern | MemoryZ decision |
|---|---|---|
| [Shelf — library](https://mobbin.com/screens/8c70e843-09ed-4051-9b34-ee7509728704) | Collections grouped above category rows; collection/category counts are separate from titles | Keep folder title, content total, and review state distinct. No decorative media collage where a subject has no cover. |
| [Crouton — collections](https://mobbin.com/screens/602996df-afb5-4c86-ad68-b923c0d756e5) | Explicit folder icon, content counts, named empty folders, unsorted collection | Subjects become shared folders. Empty subjects remain visible. Existing content with a missing subject is preserved in a clearly named unfiled folder. |
| [Brink — library folders](https://mobbin.com/screens/de8446ae-d6eb-4184-ba41-47c0f0d3e79a) | Broad tappable folder rows with count and chevron | Use compact borderless rows with one destination per row; no nested button inside folder rows. |
| [eBay — collection folders](https://mobbin.com/screens/8f414f5f-820c-4024-86a8-eaa0b52afebb) | Create-folder action separated from folder items; each collection exposes a count | Keep a clear “새 과목 폴더” action. Creation enters the new folder, where the material upload action names that destination. Do not copy the dense sorting/tab stack. |
| [Quizlet — not studied](https://mobbin.com/screens/439e68be-eb63-4fb8-985a-ab27b24e3ff2) | Total content and progress statuses have separate meanings | Count available cards and currently due cards separately. Never use cached subject counts as progress. |
| [Quizlet — still learning](https://mobbin.com/screens/f5c83f4d-eded-4850-ac6a-9675f4b1141f) | Different learning states show their own numeric values | Show text and numeric “지금 복습” / “다시 확인” badges. A color alone cannot carry the meaning. Completed or deleted records are not falsely counted as needing review. |
| [Quizlet — set context](https://mobbin.com/screens/e9276db2-5681-4119-986c-805b5b8d8afd) | Learning actions remain under a named set with total terms | Inside a folder retain the subject name/breadcrumb. Card preview, review, creation and AI creation stay scoped to an intelligible subject context. |
| [Quizlet — empty folder](https://mobbin.com/screens/90140e3e-3bb9-427b-ab56-b687aa7521e2) | Empty named folder invites adding study materials, instead of showing a misleading progress metric | New subject creation enters that folder; its empty material view offers adding a source. Existing folder-first upload onboarding is retained. |
| [stoic. — collections](https://mobbin.com/screens/5b5d208c-3325-4639-96fa-fece5a08939e) | Cover grid with per-collection fractions | Inspected, rejected for this task: repeated large covers and ambiguous fractions add noise to text-heavy subject folders. |
| [Obsidian — properties drawer](https://mobbin.com/screens/c98bbb65-e3c6-4c66-a48e-29bb70e469a5) | Property counts and workspace/file summary | Inspected, rejected as a weak search match: this is a properties drawer, not a primary folder browser. |

## Implemented contract

- Subjects are the canonical folder IDs across material, card, quiz and weak-note libraries. This does not create a second folder schema or migrate user data.
- `learningFolders(data, mode, now)` uses actual live cards, materials, questions, essays and latest attempts. It ignores stale counters stored on Subject. Due cards obey the shared SRS predicate, including FSRS masteries with a scheduled return.
- Folder ordering is deterministic: folders with due cards first for card/material views; folders with weak questions first for notes; then Korean/numeric subject name and ID. Counts do not reorder folders on every numerical change. Unfiled content is last.
- Empty subjects remain navigable. Orphan content is counted under the existing `__unfiled__` identifier. `inLearningFolder` applies the same rule to drill-down filters.
- Folder rows display total content separately from compact muted-red “지금 복습” or “다시 확인” badges. Text and numbers remain sufficient without color.
- Card library defaults to folder browsing. Its summary can start review across all folders; drilling into a folder shows only that folder's cards, a path back to all folders, and direct/image-occlusion/AI creation entry points.
- Material library uses the same folder component. The upload flow already creates or selects a subject before opening the upload editor; that behavior was preserved, with clearer folder naming, semester/item metadata, and an in-folder add action. Empty-folder creation now opens that folder rather than silently dismissing its editor.
- The study 2×2 learning methods and invitation hero are untouched. No full folder library was injected into Home.
- Parent integration owns quiz and weak-note screens and their real-browser verification. This document does not claim their integration based only on a shared component being available.

## Verification and review passes

1. Implementation: reusable folder model/component, card landing/drilldown, material-library integration and folder-first source affordances.
2. Domain reread: card due semantics use `isDue`; weak notes reuse existing latest-attempt/saved-note logic. Same-name subjects from different semesters retain separate IDs. Deleted cards are excluded.
3. Defect hunt: missing subject IDs preserve content; stale selected subjects fall back to the folder browser; count calculation does not mutate input. Found and corrected a stale card test label after changing “오늘 복습” to the more precise “지금 복습”.
4. Polish: full-row actions, chevrons, readable metadata, wrapped long names, 320px spacing rule, label-plus-color status badges, no extra card borders.

Focused model/render tests and TypeScript checks are recorded in `.unlazy/feedback-2/gates/leaf-1.md`. Driver performs the shared build and actual browser journeys; this leaf does not restart ports, mutate DB accounts, or run paid AI generation.
