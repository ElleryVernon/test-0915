# Gates: Memoryz product integration
Scope: Actual mobile product preserving supplied HTML design and orange flowing gradient, with persistent PostgreSQL study and role flows.
- [x] G1: Production build and strict TypeScript compilation succeed
  CHECK: npm run build
  EXPECT: Route (app)
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/seongminhan/test; path=5a1a51e3c8dd/32 entries; output=Loaded Prisma config from prisma.config.ts. | Prisma schema loaded from prisma/schema.prisma.
- [x] G2: Core learning algorithms, validation, and isolation tests pass
  CHECK: npm test
  EXPECT: fail 0
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/seongminhan/test; path=5a1a51e3c8dd/32 entries; output=ℹ todo 0 | ℹ duration_ms 4428.814459
- [x] G3: PostgreSQL persistence and HTTP authorization work across core flows
  CHECK: npx tsx scripts/integration-check.ts
  EXPECT: MEMORYZ_INTEGRATION_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/seongminhan/test; path=5a1a51e3c8dd/32 entries; output=MEMORYZ_INTEGRATION_OK (45 HTTP checks; durable DB, cross-user and role negatives, retry deduplication, SRS, essay, scheduler, privacy, points, anonymous posts, CSRF, logout)
- [x] G4: Actual mobile browser flows, navigation, dialogs, learning results, and design fidelity reviewed
  EVIDENCE: Actual 390px browser: student home/search/notifications, material/PDF canvas, quiz4of5 and wrong-card creation, 4-stage essay plus real AI100 feedback, FSRS settings/review, image highlight fix1region, planner conflict and AI recovery/application4blocks, community comments/like/follow, privacy/parent link, separate parent dashboard/cheer/community. Controlled3001 outage reload/review queue1/restart sync verified in DB; 360/430px no horizontal overflow. Native switch retained all rows; current UI writes succeed. docs/VERIFICATION.md states external OAuth, admin browser and native-device boundaries.
- [x] G5: Setup, real service requirements, and verification scope are documented
  CHECK: node scripts/delivery-check.mjs
  EXPECT: MEMORYZ_DELIVERY_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/Users/seongminhan/test; path=5a1a51e3c8dd/32 entries; output=MEMORYZ_DELIVERY_OK

- [x] G6: OpenRouter GPT 5.6 Luna high produces valid source-grounded study content and semantic feedback through the real service
  EVIDENCE: Real OpenRouter provider verification 2026-09-14T15:57:45.639Z: quiz/essay/cards/semantic grade/plans/OCR all validated in .data/openrouter-verification.json; actual browser quiz generation increased material questions 4 to 7, image OCR uploaded successfully. Model openai/gpt-5.6-luna, reasoning high, no fake provider success.
- [x] G7: Function-level browser screenshots and reference-led review fixes are recorded
  EVIDENCE: 43 actual browser PNG captures indexed in docs/screenshots/index.html; supplied HTML/PDF and orange/cream gradient followed. docs/VISUAL_REVIEW.md records inspected Toss/Quizlet/Speak/Tiimo/Amie/Karrot references and concrete refinements. Before captures retained; latest home/card/realAIessay/planner/PDF and corrected highlight screenshots reviewed.

- [x] G8: Reference-informed typed AI tools and skills preserve source grounding, isolate ownership, and prevent duplicate execution or lost results
  EVIDENCE: Parent-reverified backend B5, study G5/G7 and HTTP45 validate typed stages, ownership404, concurrent409, changed-input409, persisted replay, explicit terminal retry and user-scoped recovery. Actual browser reloaded in-flight quiz, recovered original count3, and produced exactly one COMPLETED AiRun with 3 questions; docs/AI_ARCHITECTURE.md states synchronous execution and OCR/upload limits.
