# Go 서버 (server/)

Next.js 서버 코드를 대체하는 API·정적 파일 서버. Go 1.26, 표준 `net/http` ServeMux(벤치마크로 선택: `server/bench/RESULTS.md`), pgx v5 + sqlc, goose 마이그레이션, go-pdfium(wasm, cgo 없음), OpenTelemetry. 웹(`out/`)은 같은 프로세스가 서빙한다(docs/WEB.md). 클라우드 구성은 docs/CLOUD.md, 캐시는 docs/CACHING.md, 관측은 docs/OBSERVABILITY.md.

## 명령

| 명령 | 역할 |
| --- | --- |
| `server serve` | API + 정적 파일 서빙(기본) |
| `server migrate up [version]` | 내장 goose 마이그레이션 적용 (버전 테이블 `ops.goose_db_version`) |
| `server migrate status` | 적용/미적용 목록(JSON) |
| `server migrate baseline <version>` | 기존 DB 를 특정 버전으로 표시 |
| `server seed-demo` | 데모 계정·데이터 시드(`DEMO_MODE=true` 필요, prisma/seed.ts 와 패리티) |
| `server sweep` | 하루 지난 미연결 업로드·주인 없는 객체 정리(JSON 보고) |
| `server verify-provider [--out <file>]` | 실제 프로바이더 검증 6회 호출(유료, 아래 AI 절) |
| `server version` | 빌드 시 `-X main.version` |

로컬 개발: `npm run dev:api`(scripts/dev-api.mjs 가 .env 를 읽고 :8080), 로컬 프로덕션: `npm run start`(scripts/start-local.mjs, :3000).

## 패키지

| 패키지 | 내용 |
| --- | --- |
| `cmd/server` | 명령 진입점, 텔레메트리·풀·블롭·캐시 조립 |
| `internal/app` | 라우팅 조립: `/api/auth/*`(CSRF 밖), `/api/*`(CSRF·시한), 정적 셸(역할 게이트), 개발 전용 `/api/_dev/*` |
| `internal/api` | 모든 엔드포인트(bootstrap, subjects, materials, uploads, cards, study/AI, community, social, parent, admin, account, airuns), 캐시 계층(`cachelayer.go`, `withUser` 버전 증가) |
| `internal/auth` | 세션(쿠키 `memoryz_session`, sha256 토큰, 수명 8 d − U[0,12 h)·4 d 미만에서 미끄럼 갱신·상한 30 d + 세션별 오프셋, 캐시 스냅샷), OAuth(OIDC 인가 코드 + PKCE, Google·Kakao·Naver·Apple), HTML 게이트(3 s 시한) |
| `internal/ai` | OpenRouter 강제 함수 호출, 스킬 레지스트리·런타임(단계·규칙·검증), 생성/채점/플래너/OCR |
| `internal/srs` | FSRS-6(go-fsrs) + 고정 간격, ts-fsrs 5.4.2 와 골든 패리티 330 케이스 |
| `internal/planner`, `internal/textmatch` | 일정 충돌·빈 시간·플랜 제안, 서술형 채점, 인용 검증(골든 410 케이스) |
| `internal/pdfx` | PDF 본문·페이지·이미지 추출(pdfium wasm, webp) |
| `internal/blob` | 객체 저장 인터페이스: Postgres(`ops.blob`, 개발) / GCS(클라우드) |
| `internal/cache` | 캐시 인터페이스: 프로세스 내 맵 / Valkey(IAM + TLS) |
| `internal/sweep` | 정리 잡 로직 |
| `internal/telemetry` | OTel 설정(OTLP gcp / stdout / none), 캐시·풀 지표, 라우트 이름 |
| `internal/httpx` | JSON 응답·오류 계약, 미들웨어(추적·복구·로그·보안 헤더·시한·CSRF·gzip), 정적 서빙(사전 압축·ETag), health |
| `internal/db` | 풀(Cloud SQL 커넥터 지원), 마이그레이션, UTC timestamp 코덱, 오류 매핑, 스팬 이름 |
| `internal/store` | sqlc 생성 코드(`internal/db/queries/*.sql`) |
| `internal/config` | 환경 변수 → 검증된 설정(비밀은 로그에 `<set>`) |
| `internal/demo` | 데모 시드 |
| `internal/ratelimit`, `internal/ids`, `internal/jsonx`, `internal/logx`, `internal/apierr`, `internal/testenv` | 속도 제한, UUIDv7·토큰, JSON 시간/옵션, Cloud Logging 로거, 오류 타입(재시도 힌트 `Retry`), 테스트 DB |
| `internal/jitter` | 지터 원시 `Between`(창)·`Full`(full jitter) — 설계와 129 자리 판정은 [`docs/JITTER.md`](JITTER.md) |

## 설정 (환경 변수)

| 변수 | 기본 | 뜻 |
| --- | --- | --- |
| `ENV` | development | development \| production (프로덕션은 https APP_URL·AUTH_SECRET 필수) |
| `HOST`, `PORT` | 개발 127.0.0.1 / 8080 | 수신 주소 |
| `APP_URL` | 개발 http://127.0.0.1:PORT | 공개 출처(Secure 쿠키·OAuth 콜백·CSRF) |
| `LOG_FORMAT`, `LOG_LEVEL` | text(개발)/json(프로덕션), info | 로그 |
| `DATABASE_URL` | — | postgres:// URL(로컬) |
| `DB_INSTANCE`, `DB_USER`, `DB_NAME`, `DB_PASSWORD`, `DB_IAM_AUTH`, `DB_IP_TYPE`, `DB_POOL_MAX` | —, —, memoryz, —, false, private, 6 | Cloud SQL 커넥터 |
| `BLOB_STORE`, `GCS_BUCKET` | pg | pg \| gcs |
| `VALKEY_ADDR`, `VALKEY_IAM_AUTH`, `VALKEY_CA_PEM`, `VALKEY_TLS_SERVER_NAME`, `VALKEY_USERNAME`, `VALKEY_PASSWORD` | 비움(프로세스 내 캐시, 개발만) | Memorystore(프로덕션은 주소·CA 필수 — 없으면 인스턴스마다 한도·버전·채우기가 따로 논다, IAM 기본) |
| `STATIC_DIR` | — | 웹 빌드 디렉터리 |
| `DEMO_MODE`, `DEMO_ADMIN` | false | 데모 로그인 |
| `AUTH_SECRET` | 개발 전용 값 | 로그인 상태 쿠키 서명(32자 이상) |
| `GOOGLE_CLIENT_ID/SECRET`, `KAKAO_*`, `NAVER_*`, `APPLE_*` | — | 소셜 로그인 |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_REASONING_EFFORT`, `OPENROUTER_PROVIDER_ORDER`, `OPENROUTER_BASE_URL` | —, —, high, openai/fast→amazon-bedrock/us-east-1, openrouter.ai | AI |
| `AI_RATE_PER_MINUTE`, `AI_RATE_PER_DAY`, `AI_CONCURRENCY` | 10, 200, 16 | AI 사용 한도(새 요청에만 청구; 일 한도 거절은 `AI_DAILY_LIMIT`), 인스턴스당 유료 모델 호출 동시 슬롯(FIFO, 대기 30 s 뒤 429 [10 s, 20 s)) |
| `PDF_WORKERS` | 2 | 인스턴스당 동시 PDF 추출(대기 30 s 뒤 429 [30 s, 60 s)) |
| `UPLOAD_LEGACY_DIRS` | — | 옛 디스크 업로드 디렉터리 |
| `MIGRATE_ON_START` | false | 시작 시 마이그레이션(클라우드는 잡이 담당) |
| `GOOGLE_CLOUD_PROJECT` | DB_INSTANCE 의 프로젝트 | 로그·트레이스 상관 |
| `TRUST_PROXY` | 프로덕션 true | X-Forwarded-For 로 클라이언트를 정한다 |
| `TRUSTED_PROXIES` | — | 클라이언트 뒤에 X-Forwarded-For 를 덧붙이는 주소·CIDR(쉼표 구분). 클라이언트는 이 목록에 없는 가장 오른쪽 항목이다. 도메인 LB 뒤에서는 배포가 LB 고정 IP 를 넣는다(없으면 모든 사용자가 LB 주소 하나의 속도 제한 버킷을 쓴다) |
| `OTEL_EXPORTER`, `OTEL_SAMPLE_RATIO` | none(개발)/gcp(프로덕션), 1 | 텔레메트리 |
| `PPROF_ADDR` | — | 루프백 pprof |

## AI

| 항목 | 내용 |
| --- | --- |
| 프로바이더 | `internal/ai/provider.go` — Next.js 프로바이더(server/testdata/reference/provider.ts)와 요청 필드 단위로 같다: system/user 메시지, `reasoning {effort: high, exclude: true}`, `max_tokens 16384`, 강제 함수 호출(`tools` strict + `tool_choice`), `provider {order, allow_fallbacks: false, require_parameters: true}`. 사용량(promptTokens/completionTokens/reasoningTokens/cost/durationMs)은 로그와 `CaptureUsage` 수집기에 남는다. 호출 시한 175초 — AI 핸들러와 이미지 업로드(OCR)의 시한 180초 안. |
| 공급자 순서 | 기본 `openai/fast` → `amazon-bedrock/us-east-1` (`OPENROUTER_PROVIDER_ORDER` 로 변경). 2026-09-15 측정: Bedrock 우선일 때 카드 3장 56.7초(클라우드 실행 01a0a534), 카드 1장 93.4초에 완성 토큰 0(verify-provider), 같은 시각 OpenAI 로 넘어간 호출은 68~89초; OpenAI 우선으로 바꾼 직후 6개 호출 1.5~6.2초. |
| 모드별 프롬프트 | `generationPrompt(mode)` 는 요청한 모드의 필드 규칙만 담는다. 이전에는 quiz·essay·cards 규칙을 한 프롬프트에 모두 넣어 카드 뒷면에 quiz/answer/keywords/distractors 본문이 섞여 저장됐다(클라우드 실행 01a0a534; 픽스처 `internal/ai/testdata/leaked-cards.json`). |
| 검증 규칙 | 스키마·인용(원문 그대로)·중복 선택지·키워드 겹침(기존)에 더해: 다른 형식의 라벨이나 정답 머리말(형식 누출) 거부, 산문 필드 안의 번호 목록 거부, 선택지 앞 번호(①·1.·A)·가.) 제거 후 중복 판정, 같은 질문 중복 거부, 앞면=뒷면 거부, 모범 답안에 없는 키워드 거부. |
| 자가 교정 | 첫 응답이 검증에서 거부되면 거부 사유를 `<previous_attempt_problem>` 로 붙여 한 번만 다시 생성한다. 빈 인자·잘린 응답 같은 공급자 결함도 한 번 다시 시도한다. 한 실행의 모델 호출은 최대 2회이고, 두 번째 호출은 핸들러 시한이 60초 이상 남았을 때만 시작한다(`retryBudget`). 중복 판정은 공백과 끝 문장부호만 무시하고 대소문자·안쪽 문장부호는 구분한다(유전자형 AA/aa, CO/Co, pH 1.0/10). |
| 실행 기록 | `AiRun` 에 단계(LOAD_CONTEXT/GENERATE/VALIDATE/COMMIT)와 결과·오류를 남기고 같은 요청 번호는 재생한다. 클라이언트는 단계·경과 시간을 보여 준다. |
| verify-provider | `server verify-provider [--out 파일]` — quiz·essay·cards·grade·planner·ocr 를 각 1회 실제로 호출해 API 와 같은 검증기로 판정하고 `.data/openrouter-verification.json` 에 모델·공급자·토큰·비용·시간·재시도를 남긴다(유료; Next.js 의 `backend-check --provider-only` 와 같은 역할). 래퍼 `node server/scripts/provider-verify.mjs` 는 결과를 정하는 입력(internal/ai·internal/planner·internal/textmatch 코드, 기본 공급자 순서가 든 internal/config/config.go, 모델·순서·추론 환경 변수)이 같고 24시간이 안 된 기록만 재사용하며 `--fresh` 로 강제한다. 옵트인 단발 검사: `MEMORYZ_LIVE_AI=1 go test ./internal/ai -run TestLiveOCR`. |
| 로그인 힌트 | 세션 쿠키와 함께(같은 Max-Age: 세션의 남은 수명) 읽을 수 있는 `memoryz_signed_in=1` 을 내리고 로그아웃에 지운다. 세션이 미끄럼 갱신되면 둘 다 다시 내린다. 웹은 힌트나 저장된 세션이 없으면 bootstrap 을 묻지 않아 로그인 화면에서 401 이 생기지 않는다. 힌트 없이 온 인증 요청에는 다시 내려 준다. |

## 검사

한 명령: `node server/scripts/regression.mjs` (docs/VERIFICATION.md 의 표). 리프별 원장은 `.unlazy/memoryz-cloud/gates/`. 부하: `node server/scripts/load-peak.mjs`. 인프라: `node server/scripts/gcp-check.mjs`. 배포: `scripts/deploy.mjs`, 스모크 `scripts/cloud-smoke.mjs`.
