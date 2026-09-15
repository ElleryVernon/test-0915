# 지터(jitter) 설계

한 번의 공유 사건이 여러 기기를 한 줄로 세우는 곳을 찾아 퍼뜨린 기록이다. 2026-09-16 감사(워크플로 wf_f151c3cb-59a: 네 영역 스윕 + 비평가 → 타이밍 자리 129곳, 설계 3안 → 심사 → 합성 명세)를 코드에 옮겼고, 자리마다 판정이 코드 주석으로 남아 있으며 정적 감사·변이 검사가 그 판정을 지킨다.

## 원칙

- **범위.** 수업 종, 교실 와이파이 복귀, 배포·재시작, 속도 제한 창 경계, 함께 만들어진 수명처럼 **하나의 사건이 여러 행위자를 줄 세우고**, 그 뒤 **코드가 사람 없이 다시 보내거나 여러 사람이 동시에 "다시 시도"를 듣는** 곳에만 지터를 넣는다. 사람의 첫 시도는 늦추지 않는다. 나머지 자리는 지터가 없는 이유를 적는다.
- **형태는 셋.** 창 `between(lo, hi)`(균등 `[lo, hi)`), 백오프 AWS full jitter `U[0, min(cap, base·2^k))`, 서버 힌트 `Retry-After = RetryMin + U[0, RetrySpread)`. 두 모듈(`src/lib/jitter.ts`, `server/internal/jitter`)에만 있다.
- **무작위는 주입한다.** Go 소유자는 시계 옆에 `rand jitter.Rand` 를 두고(`api.Server`, `auth.Auth`, Valkey IAM 콜백) 기본값은 `math/rand/v2`(프로세스마다 다른 시드). TypeScript 함수는 `rand: Rand = Math.random` 을 받는다. 테스트는 0, 0.5, 1−2⁻⁵³, 층화·시드 난수로 고정한다.
- **정확성은 지터에 기대지 않는다.** 자동 재시도는 멱등 작업(상태 GET, GET /bootstrap, reviewId 로 중복 제거되는 복습 POST, 버전 올리기, `DoesNotExist` 조건의 GCS 쓰기)만 한다. 유료 AI POST 는 코드가 다시 보내지 않는다. 서버가 기록하지 않은 요청(청구 전에 거절)만 같은 requestId 로 다시 보낸다.
- **서버가 언제 오라고 말한다.** 모든 429 와 일시적 504 는 `Retry-After`(올림 초)와 본문 `retryAfterMs` 를 갖고 클라이언트는 본문 값을 우선한다. 영구 503 은 코드(`AI_UNAVAILABLE`, `PROVIDER_OFF`)만 갖고 힌트는 없다. 자동 재시도는 `max(자기 백오프, 힌트 + U[0,1 s))` 를 기다린다.
- **동시성 문제는 줄 세우기·합치기로 푼다.** 유료 모델 호출 앞의 FIFO 세마포어(`AI_CONCURRENCY`), PDF 추출 슬롯, 버전 키 캐시 채우기의 singleflight.
- **캐시 TTL 에는 지터를 넣지 않는다.** 모든 키가 사용자별이거나 버전 키라 만료가 요청을 보내지 않는다. 사람이 끝을 보는 수명(세션)만 사용 주기보다 길게 시작해 퍼뜨린다.
- **라이브러리가 이미 지터를 하면 켜거나 묶는다.** pgx `MaxConnLifetimeJitter`, valkey-go 재시도(연산마다 250 ms 시한), GCS 의 gax full jitter(쓰기를 멱등으로 만들어 켬), cloudsqlconn·OTLP(이미 무작위).

## 세 가지 형태

| 형태 | 수식 | 쓰는 곳 |
| --- | --- | --- |
| 창 | `between(lo, hi) = lo + r·(hi − lo)`, r∈[0,1) (부동소수 반올림으로 hi 가 나오면 hi 바로 아래로) | 와이파이 복귀 동기화 U[0,10 s), AI 폴링 주기 U[1875, 3125) ms, 실패한 POST 뒤 깨우기 U[0, 2.5 s), 세션 수명 8 d − U[0,12 h), 429 힌트 없는 수동 재시도 U[10 s, 20 s) |
| 백오프(full jitter) | `fullJitter(k, base, cap) = U[0, min(cap, base·2^k))` | 복습 동기화 base 2 s·cap 60 s(시도 무제한, 대기 중·온라인일 때만), bootstrap 재시도 base 2 s·cap 16 s(최대 3회), AI 폴링 실패 읽기 2.5 s + U[0, min(7.5 s, 2.5 s·2^(k−1))), 버전 올리기 25 ms·cap 100 ms(3회) |
| 서버 힌트 | `d = max(1 s, RetryMin + U[0, RetrySpread))`, 밀리초로 올림 → `Retry-After: ⌈d⌉`, `retryAfterMs: d` (공식은 `httpx.RetryAfter` 하나 — 오류 응답은 `httpx.Fail`, 저장된 실행 조회는 `readAiRun` 이 쓴다) | 아래 표 |
| 클라이언트 재시도 바닥 | `retryDelay(backoff, hint) = max(backoff, hint + U[0,1 s))` | 모든 자동 재시도 |
| 수동 재시도 쿨다운 | `cooldown = hint + U[0,1 s)` · 영구 코드면 0 · 힌트 없는 429 는 U[10 s, 20 s) · 그 밖 0 (실패마다 한 번 뽑아 저장) | 생성·업로드·채점·플래너·로그인 버튼 |

서버 힌트의 (RetryMin, RetrySpread):

| 거절 | RetryMin | RetrySpread | 결과 범위 |
| --- | --- | --- | --- |
| 속도 제한(세션 발급 120/분/주소, AI 분 한도) | 창의 남은 시간 | 15 s | 남은 시간 + U[0,15 s) |
| AI 일 한도(`AI_DAILY_LIMIT`) | 정확한 남은 시간 | 0 | 정확 |
| AI 입장 대기 초과(30 s) | 10 s | 10 s | [10 s, 20 s) |
| 상류 429 | clamp(상류 Retry-After, 10 s, 10 min) | 10 s | [상류, 상류 + 10 s) |
| AI 공급자 지연·응답 끊김 504 | 10 s | 10 s | [10 s, 20 s) (호출자 자신의 시한이면 요청 시한 504 로) |
| PDF 대기 초과(30 s) | 30 s | 30 s | [30 s, 60 s) |
| 요청 시한 504(`ErrTimeout`) | 2 s | 4 s | [2 s, 6 s) |
| 종료로 중단된 AI 실행(503) | 10 s | 10 s | [10 s, 20 s) |
| 기록된 실패(INTERRUPTED·FAILED 429·504)의 조회·재생 | max(0, finishedAt + 10 s − now) | 10 s | 읽을 때마다 뽑음, 최소 1 s |
| 학부모 연결 코드 잠금 | 정확한 남은 시간(최대 30 min) | 0 | 정확 |

OAuth 시작은 최상위 이동이라 JSON 을 읽을 수 없으므로, 거절하면 `303 /?loginError=busy&retryAfter=<초>` 로 보내고 로그인 화면이 같은 카운트다운을 돌린다.

## 합치기·줄 세우기

- **singleflight** (`server/internal/api/cachelayer.go` `fill`): bootstrap·게시글·학교 검색의 버전 키 채우기. 같은 키의 동시 미스는 로더를 한 번 부르고 나머지는 `X-Cache: shared` 로 받는다(세 경로 모두 `X-Cache` 를 보낸다). 채우기는 분리된 12 s 문맥에서 끝나므로 먼저 떠난 호출자가 취소하지 못한다. DEMO_MODE 에서는 반 전체가 demo-student 의 한 키를 쓰므로 수업 종의 bootstrap 50건이 채우기 1회가 된다.
- **AI 입장** (`server/internal/ai/provider.go` `admit`): 인스턴스마다 `AI_CONCURRENCY`(기본 16) 슬롯의 FIFO 세마포어, 대기 최대 30 s. 대기가 끝나면 429 [10 s, 20 s), 호출자의 시한이 먼저면 그 문맥 오류(504·중단). 지표 `memoryz.ai.queue_wait`, `memoryz.ai.upstream_429`.
- **PDF 슬롯** (`uploads.go` `pdfSlot`): `PDF_WORKERS` 개, 대기 30 s 뒤 429 [30 s, 60 s). 클라이언트가 떠나면(`httpx.ClientGone`) 즉시 자리를 내놓는다. 스캔 PDF 의 OCR 이 입장에서 거절되면 422 가 아니라 그 429 와 힌트를 그대로 돌려준다.
- **버전 올리기**: Lua `max(cur+1, now_ms)` 한 번(단조, 동시 200회 → 200개 서로 다른 값), 요청 취소와 무관한 분리 문맥, id 마다 따로 500 ms 예산으로 나란히(한 id 의 시간 초과가 다른 id 의 시도를 먹지 않음) full jitter 로 최대 3회.
- **AI 예산은 새 요청에만** 청구한다. 재생·진행 중 확인·실패 재조회는 무료이고, 거절은 AiRun 행을 남기지 않아 같은 requestId 를 다시 보낼 수 있다. 청구와 청구권(AiRun 행)은 그 requestId 의 advisory lock 아래 한 트랜잭션에서 일어나므로, 같은 새 id 를 동시에 여러 번 보내도(두 번 탭, 재전송) 한 번만 청구한다.

## 수명·연결

| 대상 | 설정 |
| --- | --- |
| 세션 | 유휴 수명 8 d − U[0,12 h) (7일 시간표보다 항상 김), 남은 시간이 4 d 미만이면 인증 API 요청에서 미끄럼 갱신(`GREATEST` 로 뒤로 가지 않음, 쿠키 둘이 같은 Max-Age), 절대 상한 생성 + 30 d + 세션별 오프셋 U[0,28 d)(토큰 해시에서 고정, 초 단위라 상한에서 반복 갱신 없음) |
| 로그인 힌트 쿠키 | 세션의 남은 시간을 그대로 따른다(자기 추첨 없음) |
| pgx 연결 | `MaxConnLifetime` 30 min + `MaxConnLifetimeJitter` 5 min(초 단위), `MinIdleConns` 2, `PingTimeout` 2 s, 취소된 문장은 `DeadlineContextWatcherHandler` 로 2 s 동안 끝낼 기회를 얻고 `db.Tx` 롤백은 분리된 2 s 문맥에서 — 교실 와이파이가 끊겨도 풀이 모든 연결을 다시 걸지 않는다 |
| Valkey | 연산마다 250 ms 시한(valkey-go 의 재시도는 그 안에서만), IAM 재인증은 만료 5 min + U[0,60 s) 전, 만료가 가까우면 U[30 s, 90 s)(남은 시간의 절반 이하), 토큰은 10 min 조기 갱신 |
| GCS 쓰기 | `DoesNotExist` 조건으로 멱등 → 라이브러리의 full jitter 재시도가 켜진다, 412 는 이미 들어간 것이므로 성공, 쓰기마다 20 s 예산(단일 요청 업로드에는 라이브러리의 시도 횟수 제한이 적용되지 않아 시간으로 묶는다 — 명세의 "4회"를 코드 동작에 맞춰 바꿈) |

## 종료·생존 확인·클라이언트 주소

- **종료 예산**: Cloud Run 은 SIGTERM 10 s 뒤 강제 종료한다. HTTP 종료 7.5 s(`ShutdownGrace`) + 저장소 닫기 0.5 s(`CloseGrace`, 풀의 Close 는 빌려 간 연결이 돌아올 때까지 기다리므로 시간으로 묶는다) + 텔레메트리 플러시 1.5 s(`FlushGrace`) = 9.5 s. SIGTERM + 5.5 s(`DrainAfter`)에 이 인스턴스가 실행 중인 AI 실행을 취소 원인 `errDraining` 으로 끊고, 각 실행은 2 s 안에 `INTERRUPTED`(503 + [10 s, 20 s) 힌트)로 기록한다. 25개 실행이 5분 리스 만료에 한꺼번에 뒤집히는 대신 다음 폴링(≤ 3.1 s)에 알려진다. 명세는 +7 s 였으나 기존 10 s + 5 s 예산이 유예를 넘었으므로 예산 전체를 다시 나눴다.
- **`/api/live`**: I/O 없이 200. Cloud Run liveness 가 이 경로를 보고, startup 프로브·업타임 검사는 DB 를 확인하는 `/api/health` 를 계속 본다. 공유 DB 가 흔들려도 모든 인스턴스가 함께 재시작하지 않는다.
- **추적에 개인 정보 없음**: otelhttp 는 기본으로 클라이언트 주소(`X-Forwarded-For` 첫 항목)·소켓 상대·User-Agent 를 서버 스팬에 넣는다. 스팬 익스포터가 이 속성을 떼고(`telemetry.Redact`) 개수 속성만 남긴다. 속도 제한 캐시 오류 경고도 키 전체(주소·계정) 대신 한도 이름만 남긴다.
- **클라이언트 주소**: 속도 제한 키는 `X-Forwarded-For` 의 **신뢰하지 않는 가장 오른쪽 항목**이다. 전역 외부 LB 는 `<클라이언트가 보낸 값>,<클라이언트>,<LB 주소>` 를 붙이므로 배포 스크립트가 LB 고정 IP(`memoryz-ip`)를 `TRUSTED_PROXIES` 로 넘긴다. 이 설정이 없으면 모든 사용자가 LB 주소 하나의 버킷(120/분)을 나눠 쓴다. 서버 스팬에 개수만 남기고(`memoryz.client.hop`, `memoryz.client.entries`, 주소는 남기지 않음) `scripts/cloud-smoke.mjs` 가 실제 LB 를 거쳐 hop 1/entries 3 을 확인한다.
- 클라이언트가 떠난 요청(`context.Canceled`)은 499 로 답해 5xx 알림에 섞이지 않는다. 힌트가 있는 5xx(중단된 실행 등)는 오류 로그와 요청 로그 모두 ERROR 대신 WARN 으로 남긴다. 생존·시작 프로브(`/api/live`, `/api/health`)는 추적하지 않고 DEBUG 로만 남긴다.

## 최악 시간

| 상황 | 최악 |
| --- | --- |
| 와이파이 복귀 뒤 첫 복습 동기화 | ≤ 10 s |
| 복습 동기화 백오프 | ≤ 60 s (서버 힌트가 더 길면 힌트 + 1 s) |
| AI 상태 폴링 | 1.875 s 보다 빠르지 않음, 실패 뒤 ≤ 10 s, 완료는 ≤ 10 s 늦게 보임, 190 s 에 보류 |
| bootstrap 자동 재시도 | 최대 3회, 백오프 합 ≤ 28 s(서버 힌트가 있으면 그 대기는 힌트 + U[0,1 s) 로 길어짐; 클라이언트 시한 초과는 재시도하지 않음) |
| 힌트 폭 | ≤ 30 s (개인의 정확한 기한은 폭 없음: 연결 잠금 ≤ 30 min, 일 한도 ≤ 24 h) |
| DB 연결 수명 | 30–35 min |
| 세션 | 유휴 7.5–8 d, 절대 30–58 d |
| 종료 | 요청 ≤ 7.5 s, AI 실행 중단 +5.5 s, 저장소 닫기 ≤ 0.5 s, 전체 ≤ 9.5 s |

## 표시 규약과 증명

- 복습 동기화 스케줄러는 기기(사용자)마다 상태 하나: 진행 중인 시도에 합류한 호출은 그 결과를 함께 받아 실패를 한 번만 세고, `cancelSync` 뒤에 끝난 시도는 재시도를 걸지 않는다.
- 자리마다 주석 한 줄: `jitter: <policy> <매개변수> [site <id>]` 또는 `jitter: none — <이유> [site <id>]`. policy ∈ window, period, backoff, retry-after, cooldown, lifetime, library, admission, coalesce. id 는 감사 당시의 `경로:줄` 로 고정된 식별자다(지금 줄 번호가 아니다). 목록은 `scripts/jitter-sites.json`.
- `node scripts/jitter-audit.mjs` — 129 자리가 정확히 한 번씩, 토큰이 목록과 같게 표시되고, 운영 코드의 모든 타이밍 원시(setTimeout·setInterval·sleep(·time.After·time.Sleep·NewTicker·NewTimer·AfterFunc·TTL/Lifetime/Lease 상수·`.Retry(`·retryTransient(·online/offline/focus/visibilitychange 리스너) 위 3줄 안에 표시가 있는지 본다. 표시 하나 지우기·자리 겹치기·토큰 바꾸기·원시의 표시 떼기를 음성 대조로 돌려 모두 거절되어야 통과(`controls=refused`).
- `node scripts/jitter-mutation.mjs` — 규칙 37개(웹 12·서버 25)를 복사본에서 하나씩 깨고 이름 붙은 테스트가 이름으로 실패하는지 본다(변이하지 않은 대조가 먼저 통과해야 하고, 빌드가 깨지는 변이는 무효로 친다).
- `node server/scripts/jitter-http.mjs` — 실제 서버·가짜 모델로 모든 429 의 힌트와 영구 503 의 코드를 확인한다. `node server/scripts/bell-check.mjs` — Valkey 컨테이너 + 풀 6 + 데모 모드로 수업 종을 재현한다.
- 테스트: `tests/jitter.test.ts`(OAuth 대기 상한 포함), `tests/api-error.test.ts`, `tests/sync-scheduler.test.ts`(50명 방 시뮬레이션, 취소·합류), `tests/ai-task-poll.test.ts`(25명 재시작 시뮬레이션), 브라우저 `scripts/home-capture.ts`(F·G: 한 번짜리 의도가 화면 재마운트로 사라지지 않음), Go `TestBudgetOnceForConcurrentSameID`·`TestBumpBudgetPerID`·`TestGateTimeout`·`TestRedact`·`TestCloseWithin`·`TestBetween`·`TestFull`·`TestRetryAfterHeader`·`TestRatelimitHint`·`TestIncrWindow`·`TestBump`·`TestValkey`·`TestOpDeadline`·`TestIAMSchedule`·`TestFillCoalesces`·`TestBumpDetached`·`TestAdmission`·`TestRetryHints`(ai·api)·`TestBudgetOnlyForNewRuns`·`TestDrainInterruptsRuns`·`TestStoredFailureHints`·`TestPDFQueue`·`TestScannedPDFRefusedByAdmission`·`TestSessionLifetime`·`TestSessionRenewal`·`TestHintFollowsSession`·`TestTune*`·`TestGCSIdempotent`·`TestDrain`·`TestLive`·`TestClientGone`·`TestClientIP`.
- 기준선 대조: 변경 뒤 `npm test` 와 `go test ./...` 의 실패 테스트 이름 집합이 비어 있다(새로 실패하는 이름 없음). 의도한 테스트 수정은 세션 Max-Age 범위(auth_test.go, auth-http.mjs)와 캐시 Incr 반환값 개수뿐이다.

## 롤아웃 순서

1. 서버 먼저: 힌트·코드, 원자적 창 스크립트·단조 버전, singleflight, 입장 세마포어, 종료 drain, 풀 설정, 세션 갱신, `TRUSTED_PROXIES`, `/api/live`. 250 ms Valkey 시한은 singleflight 와 같은 릴리스로만 나간다(빠르게 실패하는 캐시가 모든 요청을 DB 미스 경로로 보내지 않도록).
2. 웹은 두 번째. 섞인 리비전도 안전하다: 버전 값은 계속 십진수, `createdAt` 없는 옛 세션 스냅샷은 ≤ 60 s 동안 갱신만 건너뛰고, 옛 클라이언트는 새 필드를 무시한다.
3. 배포 뒤: `node scripts/cloud-smoke.mjs`(LB 를 거친 클라이언트 주소 확인 포함), `deploy.mjs verify-service`(liveness `/api/live`, `TRUSTED_PROXIES`), `deploy.mjs verify-alerts`(5xx 60 s 조건: 1분 정렬, 재확인 창 0 — 나쁜 1분 하나로 연다).

## 남은 위험

- **세션 갱신·상한은 보안·제품 결정이다.** 예전 고정 7일 대신 활동 중이면 최대 30–58 d 까지 이어진다. 공용 기기에서는 로그아웃이 여전히 즉시 끝낸다.
- **`AI_CONCURRENCY` 16 과 30 s 대기**는 빠른 경로(1.5–6.2 s) 측정에서 나왔다. 느린 경로(68–93 s)에서는 25명 폭주 중 약 9명이 거절된다. 인스턴스별이라 3대면 최대 48. `memoryz.ai.queue_wait`·`memoryz.ai.upstream_429` 를 보고 조정한다.
- **DEMO_MODE** 에서는 모든 체험 학생이 demo-student 라 사용자별 한도(ai:m 10/분)가 반 전체를 묶는다. 지터는 거절 15건의 복귀를 퍼뜨릴 뿐 막지 않는다. 기기마다 데모 계정을 주는 것은 별도 변경이다.
- **영구 거절된 복습**(400/404/409)이 큐 앞에 있으면 뒤의 복습을 막는다(기존 문제). 스케줄러는 이제 반복하지 않고 멈춘다. 항목을 치우는 것은 큐 의미를 바꾸므로 이번 범위 밖이다.
- `Retry-After` 는 초 단위라 OAuth 303 같은 이동은 초만 본다. fetch 호출은 밀리초 본문을 쓰고 자동 재시도는 U[0,1 s) 를 더한다.
- pgx 는 수명 지터를 초 단위로 자르고 자기 전역 난수로 뽑는다. 설정 단언과 통계 테스트만 가능하고, 1 s 미만 값은 조용히 지터 없음이 된다.
- 창·버전 Lua 스크립트는 EVALSHA 로 가며 valkey-go 가 재시도하지 않는다. Valkey 8 컨테이너(TestValkey)로 검증했고, 서버 시계를 버전 하한으로 쓴다(TIME 호출 없음).
- singleflight 리더는 모든 호출자가 떠나도 12 s 안에 채우기를 끝낸다. 공유된 `[]byte` 는 읽기 전용으로 다룬다.
- `DeadlineDelay` 2 s 동안 끊긴 클라이언트의 질의가 조금 더 연결을 잡을 수 있다.
- 종료 +5.5–9.5 s 사이에 도착했을 결과는 버린다(`errRunClosed`).
- 복습마다 `ver:<user>` 가 올라가 bootstrap 채우기가 반복된다(반이 복습하는 동안 초당 2.5–5회). 동기화가 아니라 부하이며, 30 s 뒤쪽 합치기는 후속 과제다.

## 129 자리

판정 열은 표시 토큰이다(`none` 은 지터 없음). 설명은 감사 당시의 기록이다(원문 영어).

| 자리 | 판정 | 무엇 | 정책 또는 이유 |
| --- | --- | --- | --- |
| docs/CACHING.md:22 | none | The documented table of keys, TTLs and invalidation: sess/user 60 s, ver 7 d, boot 60 s, posts 15 s, schools 1 h, rl = window length, lock = lease. | none — Documentation |
| public/sw.js:2 | none | Service worker install: caches.addAll of '/', '/aurora.svg', '/icon.svg' and '/manifest.webmanifest', then skipWaiting(). | none — Install caches 4 small files once per service-worker version, on each device's own next page load. |
| public/sw.js:3 | none | Service worker activate: deletes the other memoryz-shell-* caches, then clients.claim() | none — Activate only deletes local caches: no network and no reload. |
| public/sw.js:4 | none | Service-worker navigation handler: network first, falling back to the cached '/' only when fetch rejects. | none — There is no retry loop to jitter |
| scripts/deploy.mjs:130 | none | The deploy step runs migrations against the live database with no lock_timeout and no class-hours guard | none — A single migrator (now deploy.mjs:161). |
| scripts/deploy.mjs:152 | none | Cloud Run service deploy: min 1, max 3, concurrency 80, timeout 300 s, cpu-boost, gen2 (lines 151-156) | none — Clients hold no persistent connections to re-establish |
| scripts/deploy.mjs:154 | none | Startup probe: /api/health with initialDelay 2 s, period 3 s, failureThreshold 20, timeout 3 s (about a 62 s budget). | none — A startup probe per instance, at its own pace (now deploy.mjs:185) |
| scripts/deploy.mjs:155 | none | Cloud Run liveness probe: GET /api/health every 30 s, failureThreshold 3, timeout 3 s | none — A liveness check that depends on the shared database restarts every instance together; the fix is structural, not jitter |
| scripts/deploy.mjs:208 | none | Cloud Scheduler memoryz-sweep: '0 4 * * *' Asia/Seoul triggers the memoryz-sweep Cloud Run job (task timeout 900 s, --max-retries=0, line 84) | none — One scheduler job at 04:00 KST (now deploy.mjs:239). |
| scripts/deploy.mjs:228 | none | Cloud Monitoring uptime check memoryz-health: GET https://<host>/api/health with period 60 s and timeout 10 s, from ASIA_PACIFIC, USA_OREGON and EUROPE (lines 2 | none — About 3 external checks per minute (now deploy.mjs:259-260), unrelated to class timing. |
| scripts/deploy.mjs:249 | none | The 5xx-ratio, p95-latency and pool-saturation alert policies use 300 s windows | none — An alerting window |
| server/bench/internal/app/app.go:115 | none | The benchmark harness maps ErrNoDB to 503. | none — Not deployed. |
| server/bench/internal/pgbench/pgbench.go:285 | none | Benchmark Postgres readiness poll | none — Development tooling. |
| server/bench/orchestrate.go:135 | none | Benchmark pauses after the go test microbench so the compile burst settles | none — Development tooling. |
| server/bench/orchestrate.go:473 | none | Benchmark harness stops child processes by escalating from stdin close to SIGTERM to SIGKILL | none — Development tooling. |
| server/bench/orchestrate.go:519 | none | Benchmark harness waitReady: polls the child server every 100 ms | none — Development tooling with a single actor. |
| server/cmd/server/main.go:107 | none | verify-provider CLI with a 5-minute context | none — An operator CLI command, not on the serving path. |
| server/cmd/server/main.go:150 | none | Telemetry flush on shutdown with a 5s timeout | none — Runs once per instance |
| server/cmd/server/main.go:212 | none | Daily sweep job (Cloud Scheduler) connecting through db.Connect | none — One scheduled job at 04:00 KST. |
| server/internal/ai/provider.go:31 | none | AI 503s: ErrUnavailable (no key or model configured), errModelConfig (bad model or effort, line 32), errQuota (upstream 402, line 34). | none — Configuration or billing states, not load, so a hint would only invite useless retries |
| server/internal/ai/provider.go:123 | none | OpenRouter http.Client: Timeout 175s, DefaultTransport, no retries | none — There is no retry loop, paid calls are never retried, and HTTP/2 shares one connection |
| server/internal/ai/provider.go:248 | retry-after | OpenRouter call: an upstream 429 becomes errBusy (429 'AI 요청이 많아요'); a 402 becomes errQuota (503) | retry-after |
| server/internal/ai/tasks.go:168 | none | The server repeats the paid generation immediately when the answer is empty, cut off, unreadable or refused by the validator | none — The regeneration fires when the first answer arrives, and those arrival times already differ by seconds |
| server/internal/api/airuns.go:238 | none | The write that marks an AI run FAILED runs with no deadline | none — An unbounded wait, not a herd |
| server/internal/api/api.go:114 | none | invalidate() bumps the shared ver:posts after any successful write under /api/posts* or /api/blocks*, and on /api/admin/users/{id} | none — A version change cannot be spread over time |
| server/internal/api/auth_handlers.go:37 | retry-after | Sign-in limiter: ratelimit.Check("session:"+clientIP, 30, 1m) on POST /api/session (demoLogin, line 37, mounted at api/api.go:124) and on GET /api/auth/{provide | retry-after (from ratelimit), plus a limit sized so that an ordinary bell never trips it. |
| server/internal/api/bootstrap.go:163 | none | The bootstrap cache key includes the Seoul date (dateKey, bootstrap.go:36), so every boot key rolls over at 00:00 KST. | none — The rollover at midnight KST is needed for correctness (the date is in the key) |
| server/internal/api/cachelayer.go:18 | coalesce | bootstrapTTL = 60s for key boot:<user>:<learner>:<SeoulDate>:<ver(user)>:<ver(learner)> (the ETag plus the bootstrap JSON) | coalesce: singleflight on the bootstrap fill |
| server/internal/api/cachelayer.go:19 | coalesce | postsTTL = 15s for key posts:<user>:<role>:<commented>:<ver(user)>:<ver(posts)> | coalesce: singleflight on the posts fill |
| server/internal/api/cachelayer.go:20 | coalesce | schoolsTTL = 1h for key schools:<ver(schools)>:<q> | coalesce: singleflight on the shared schools key |
| server/internal/api/cachelayer.go:21 | none | versionTTL = 7 days for ver:<userId>, ver:posts and ver:schools | none — When a version key expires it costs zero queries, because the entries it versioned live ≤ 1 h |
| server/internal/api/cachelayer.go:40 | backoff | bump(): a GET of the version, then a SET of n+1 with a 7-day TTL, using r.Context() | backoff: a bounded full-jitter retry of a write that is idempotent in effect, on a detached context, with values that only increase. |
| server/internal/api/cards.go:195 | none | The server only accepts review timestamps inside a fixed window, and one rejected review blocks the rest of the offline queue | none — Affects one device |
| server/internal/api/parent.go:80 | none | Creating an invite code also deletes every user's expired invites | none — The table is tiny at PoC scale. |
| server/internal/api/parent.go:138 | retry-after | Parent invite-code lockout: 5 wrong codes set LinkLockedUntil = now + 30 min, answered with errLinkLocked 429 (lines 35-46, 138-164). | retry-after, exact (spread 0). |
| server/internal/api/study.go:49 | retry-after | Per-student AI budget per minute: ratelimit.Check('ai:m:'+userID, AI_RATE_PER_MINUTE=10, 1m), checked before /api/generate, /api/essay/submit and /api/planner/s | retry-after (from ratelimit) |
| server/internal/api/study.go:52 | retry-after | Per-student AI budget per day: ratelimit.Check('ai:d:'+userID, AI_RATE_PER_DAY=200, 24h). | retry-after, exact (spread 0), with its own code. |
| server/internal/api/uploads.go:36 | none | Upload handler deadline: httpx.Deadline(90s), detached from client cancellation | none — A per-request deadline, now aiTimeout 180 s (uploads.go:36-38), causes no synchronized retry |
| server/internal/api/uploads.go:183 | admission | Upload-time OCR (image files, plus scanned-PDF pages through opts.OCR at line 150) makes paid model calls that are outside the per-student AI budget and have no | admission: the same AI semaphore, through Provider.JSON. |
| server/internal/api/uploads.go:199 | none | Each upload first deletes the same user's unattached uploads older than 24 h | none — Per user, on demand. |
| server/internal/api/uploads.go:262 | admission | pdfSlot: a per-instance semaphore for PDF extraction, sized by PDF_WORKERS=2 (api/api.go:45, scripts/deploy.mjs:69) | admission: keep the fixed 30 s queue wait |
| server/internal/api/uploads.go:322 | none | Uploads and upload images are served as HTTP-cacheable for a year | none — The content under an id never changes, so long private caching is correct. |
| server/internal/app/app.go:29 | retry-after | Server-side request deadlines: 15 s for ordinary API routes, 30 s for auth | retry-after on the 504 that the request deadline produces. |
| server/internal/auth/gate.go:31 | none | The HTML role gate looks up the session with no deadline | none — A missing time bound, not an alignment problem |
| server/internal/auth/oauth.go:74 | none | The OAuth state cookie and signed state live for 10 minutes | none — Each sign-in has its own lifetime, so nothing expires together. |
| server/internal/auth/oauth.go:79 | none | ErrProviderOff: 503 for an unknown or unconfigured provider (lines 140-148). | none — A configuration state |
| server/internal/auth/oauth.go:257 | none | The social-login token exchange and userinfo calls have 15 s timeouts and no retry | none — One attempt per user action. |
| server/internal/auth/oauth.go:305 | none | OIDC issuer discovery runs under a global mutex; success is cached forever, failure is not cached | none — On success the mutex already makes callers share one discovery, which is then cached for the life of the process. |
| server/internal/auth/session.go:32 | lifetime | Session lifetime is exactly 7 x 24 h from creation (Create, lines 105-115) | lifetime: sliding renewal |
| server/internal/auth/session.go:95 | lifetime | The memoryz_signed_in hint cookie's Max-Age, and its silent re-issue | lifetime |
| server/internal/auth/session.go:111 | none | Signing in deletes that user's expired sessions | none — Deletes only the signing-in user's rows. |
| server/internal/auth/session.go:210 | none | sess:<sha256(token)> snapshot holding {userId, expiresAt} | none — A per-device snapshot, refilled on that device's next request by one primary-key join: at most about 50 point queries, spread by people |
| server/internal/auth/session.go:233 | none | user:<id> snapshot with a 60 s TTL | none — A per-user snapshot, refilled on the owner's next request by one primary-key query. |
| server/internal/blob/gcs.go:22 | none | Cloud Storage client created with storage.NewClient defaults (retry policy and backoff) | none — gax already applies full jitter to idempotent operations, and 25 writers are far below the bucket's limits |
| server/internal/blob/gcs.go:35 | library | GCS.Put writes without a precondition, so the write counts as non-idempotent and is never retried | library: make the write idempotent so the storage client's full-jitter retry applies. |
| server/internal/cache/memory.go:44 | none | The in-process cache sweeps expired entries on a 1-minute ticker, scanning the whole map under the global mutex (memory.go:43-61) | none — A process-local ticker that shares nothing |
| server/internal/cache/memory.go:109 | none | In-process fixed-window Incr, used as the rate-limit fallback when VALKEY_ADDR is empty | none — The fallback for development and tests |
| server/internal/cache/valkey.go:40 | library | valkey-go client options: default RetryDelay, lazy reconnect, no ConnLifetime, ConnWriteTimeout 3s | library: keep valkey-go's equal-jitter retry, but put a deadline on every operation. |
| server/internal/cache/valkey.go:76 | none | Startup PING: 5s timeout, no retry; a failure stops serve (server/cmd/server/main.go:184-190) | none — Runs once per instance start, and Cloud Run already spaces out restarts. |
| server/internal/cache/valkey.go:93 | lifetime | IAM re-AUTH timer per connection: RefreshAfter = token expiry - 5m, falling back to now + 30m | lifetime: fix the re-AUTH schedule so it always lands before the token expires, with a small spread per connection. |
| server/internal/cache/valkey.go:117 | none | Valkey.Set stores values with PX ttl exactly as given | none — The driver writes the TTL it is given |
| server/internal/cache/valkey.go:129 | retry-after | cache.Valkey.Incr runs INCR, then a separate PEXPIRE only when the result is 1 (lines 129-140) | retry-after enabler: one atomic counter step that returns the time left in the window and heals keys that have no TTL. |
| server/internal/cache/valkey.go:134 | retry-after | Valkey.Incr fixed-window counter: INCR, then a separate PEXPIRE only when n == 1 (valkey.go:129-140) | retry-after: each response breaks up the window edge |
| server/internal/cache/valkey.go:145 | none | Lock lease: SET NX PX ttl, released by a Lua script under a 3 s background context (valkey.go:145-165; in-memory version at memory.go:125-146). | none — Lock is not used in production; only tests call it. |
| server/internal/cache/valkey.go:149 | none | Valkey.Lock lease (SET NX PX ttl) and a release script with a 3s timeout on context.Background (valkey.go:145-165) | none — An unused lease, so nothing can synchronise on it. |
| server/internal/config/config.go:156 | admission | AI_CONCURRENCY (default 16) is parsed, validated and logged but never enforced, so nothing caps how many model calls run at once | admission: a FIFO semaphore in front of every paid model call, instead of a sleep. |
| server/internal/db/db.go:51 | none | Cloud SQL connector with WithLazyRefresh (IAM authN, private IP): the ephemeral certificate is fetched when a dial needs it | none — The connector refreshes once per instance under its mutex and already jitters its Admin API retries (cloudsqlconn v1.25.2). |
| server/internal/db/db.go:78 | none | The connection pool size (DB_POOL_MAX=6 per instance) is where the bell burst waits | none — Queuing at the pool is correct, and coalesced fills (cachelayer.go:18-20) remove duplicate work |
| server/internal/db/db.go:80 | library | pgxpool MaxConnLifetime = 30m with MaxConnLifetimeJitter left at 0 | library: pgxpool MaxConnLifetimeJitter. |
| server/internal/db/db.go:81 | none | Idle culling: MaxConnIdleTime 5m, HealthCheckPeriod 1m, MinConns 1, MinIdleConns unset (db.go:79-82) | none — A cold pool at the bell is a warmth problem, not a phase problem, so jitter would not change it |
| server/internal/db/db.go:83 | none | Per-connection dial and cancel behaviour: ConnectTimeout 15s, pgconn's default context watcher with no DeadlineDelay, PingTimeout unset | none — Re-dials happen on demand and are capped at MaxConns, so a random delay would only add latency |
| server/internal/db/db.go:99 | none | Startup DB ping retry loop in db.Connect (used by serve, migrate, sweep and seed-demo) | none — At most 3 instances plus 1 job, each opening one connection; retrying in lockstep cannot strain Cloud SQL |
| server/internal/db/migrate.go:39 | none | goose Postgres session advisory lock that serialises migrators | none — Production has a single migrator. |
| server/internal/demo/seed.go:44 | none | Every demo sign-in takes one global Postgres advisory lock | none — The advisory lock is held for one EXISTS query; it is not a timer. |
| server/internal/httpx/health.go:18 | none | /api/health uses one 3s budget for both SELECT 1 and a cache GET, and serves as the Cloud Run startup and liveness probe (docs/CLOUD.md:40; route at server/inte | none — Cloud Run decides when probes run |
| server/internal/httpx/health.go:21 | none | /api/health answers 503 ErrDatabase (apierr/apierr.go:48) when SELECT 1 fails within 3 s | none — Only this handler returns ErrDatabase (apierr.go:48), and its callers are platform probes, so it gets no Retry-After. |
| server/internal/httpx/health.go:47 | none | Slow() dev endpoint that sleeps for ms (at most 5000) | none — Development only. |
| server/internal/httpx/json.go:84 | retry-after | httpx.Fail is the single writer for every apierr response, 429 and 503 included | retry-after: the one place that writes it |
| server/internal/httpx/server.go:13 | retry-after | Graceful shutdown: on SIGTERM (cmd/server/main.go:67) srv.Shutdown waits ShutdownGrace=10 s (lines 12-13, 34-41) | retry-after |
| server/internal/httpx/server.go:21 | none | http.Server timeouts: ReadHeaderTimeout 10 s, ReadTimeout 2 min, IdleTimeout 2 min, no WriteTimeout | none — Per-connection bounds with no synchronized retry. |
| server/internal/httpx/static.go:75 | none | SPA document loader: 503 'web build missing' when the HTML file can't be read | none — A local 1 s stat cache and a path that only runs on misconfiguration. |
| server/internal/httpx/static.go:154 | none | Cache-Control rules for the static web build | none — Each device revalidates on its own next navigation, and hashed chunks are immutable. |
| server/internal/pdfx/extract.go:261 | none | Scanned-PDF pages are sent to OCR one after another inside the upload deadline while the request holds a pdfSlot, and every failure is reported as an unreadable | none — Serial within one upload and capped by pdfSlot and the AI semaphore |
| server/internal/ratelimit/ratelimit.go:20 | retry-after | ratelimit.Allow/Check: INCR rl:<key>, with TTL=window set on the first hit; allowed while n<=limit | retry-after on every refusal. |
| server/internal/srs/srs.go:123 | none | Review intervals are fixed, and FSRS fuzz is disabled | none — Due times are evaluated on the device, and nothing fires at a due time. |
| server/internal/sweep/sweep.go:59 | none | The sweep's orphan-blob pass can delete the objects of an upload that is still in progress | none — A race with one scheduled job, fixed by a minimum object age in a separate change. |
| server/internal/telemetry/telemetry.go:116 | none | Batch span processor (WithBatchTimeout 2s) and the OTLP gRPC trace and metric exporters with default retry | none — OTLP retries are already randomized, and there are at most 6 export streams. |
| server/internal/telemetry/telemetry.go:118 | none | Metric PeriodicReader exporting every 60s | none — Three exports a minute running in phase is harmless. |
| server/internal/telemetry/telemetry.go:161 | none | The pool-occupancy gauge is sampled only when metrics export, every 60 s | none — Measurement, not load |
| src/components/app.tsx:192 | none | HomeScreen setInterval every 60 s, plus 'focus' (193) and 'storage' (194) listeners | none — A local 60 s clock that sends no request. |
| src/components/app.tsx:637 | none | Toast auto-clear. | none — A toast timer. |
| src/components/app.tsx:663 | none | The App 'offline'/'online' listeners only toggle the offline banner (660-664) | none — These listeners only toggle the offline banner (app.tsx:661-665) and send no request. |
| src/components/app.tsx:679 | cooldown | The client decides between bootstrap and the Login screen using the memoryz_signed_in hint cookie (src/lib/session-hint.ts:9-14) | cooldown on sign-in refusals |
| src/components/app.tsx:684 | backoff | App mount restores the IndexedDB shell (665-674), then runs refresh() (GET /bootstrap, then shellDB put; 645-651) | backoff: a bounded automatic retry of the idempotent GET /bootstrap, floored by Retry-After. |
| src/components/app.tsx:701 | none | navigator.serviceWorker.register('/sw.js') on every App mount in production (dev builds unregister it and delete the caches, 702-715). | none — One tiny no-store GET of /sw.js per page load, spread by people. |
| src/components/onboarding.tsx:20 | none | School search debounce | none — A debounce paced by keystrokes |
| src/components/social/account.tsx:40 | none | GET /social on Account mount, and again whenever data.posts changes identity, i.e | none — One-shot GETs on navigation, not part of a chain the classroom lines up |
| src/components/social/account.tsx:421 | none | Profile editor school search debounce through api() (150 s timeout). | none — A debounce paced by keystrokes. |
| src/components/social/account.tsx:550 | none | Invite code countdown | none — A local countdown; a new code only comes from the button. |
| src/components/social/admin.tsx:30 | none | The admin screen fetches GET /admin once on mount | none — Admins only, one fetch per visit. |
| src/components/social/parent.tsx:351 | none | ChildLinks fetches GET /children once on mount | none — One fetch per screen visit. |
| src/components/social/planner.tsx:113 | none | Planner clock: setNow every 60 s, which recomputes due counts and gaps locally. | none — A local clock that sends no request. |
| src/components/social/planner.tsx:171 | none | Elapsed-time counter while a suggestion is generating. | none — An elapsed-time counter in the UI. |
| src/components/social/planner.tsx:314 | none | inspectSuggestion() polls a stored request up to 45 times, every 1600 ms (312-317) | none — It starts from a tap, errors are thrown to the caller, and no reconnect re-aligns it. |
| src/components/social/planner.tsx:346 | none | resume(): on Planner mount (366-392), a stored RUNNING suggestion is inspected and then polled up to 45 times, every 1600 ms (about 72 s) | none — It starts on each student's own navigation and ends at the first error, and nothing ('online', visibility, a deploy) restarts it, so nothing re-aligns these pollers |
| src/components/social/planner.tsx:466 | none | Planner fill-free-time suggest() calls runAiTask(/planner/suggest) on a user tap | none — A tap at a person's own pace |
| src/components/social/planner.tsx:488 | none | revealResult keeps the working state visible for at least 900 ms before opening the sheet (487-488). | none — A minimum reveal time for the UI only. |
| src/components/social/planner.tsx:558 | none | When applyPlan fails, it immediately does one GET /bootstrap plus a refresh to recompute which blocks were already saved (556-565) | none — One bounded re-read after a tap. |
| src/components/study/cards.tsx:147 | window | Flashcards 'online' listener (plus the update() call on mount, line 146) runs sync() (91-113) | window + backoff, through the offline.ts scheduler |
| src/components/study/cards.tsx:208 | backoff | After every rating, void sync() (208), plus the manual sync buttons (255, 484, 764) | backoff, only after a failure |
| src/components/study/essay.tsx:197 | none | On essay screen mount, a stored submission is inspected once with GET /ai-runs (188-222) | none — One GET on navigation, with no loop. |
| src/components/study/essay.tsx:486 | none | Essay submit calls runAiTask(/essay/submit) | none — Students finish free-text answers at different times |
| src/components/study/generation-task.ts:25 | none | When the GenerationSheet opens, recoverGenerationTask inspects a stored request once (called from study/shared.tsx:205). | none — One read when the sheet opens; errors fall back to the stored copy. |
| src/components/study/pdf-viewer.tsx:61 | none | Fetches the PDF bytes with a 45 s timeout | none — One fetch a person starts, with a manual retry. |
| src/components/study/shared.tsx:179 | none | GenerationSheet elapsed-time counter. | none — An elapsed-time counter in the UI. |
| src/components/study/shared.tsx:243 | none | GenerationSheet generate() calls runAiTask when the button is pressed (385) | none — The clicks are already spread by people; delaying a student's own click adds latency without lowering the peak |
| src/components/study/shared.tsx:446 | cooldown | uploadFile POSTs /api/upload with no timeout and no abort signal | cooldown |
| src/components/study/subjects.tsx:960 | none | UploadSheet save() | none — A serial chain a person starts, whose stages vary in length and already pull devices apart |
| src/components/ui-date.tsx:204 | none | Time-wheel scroll-settle timer, plus requestAnimationFrame focus restores (src/components/ui-choice.tsx:76, ui-date.tsx:41, 134). | none — A UI settle timer and requestAnimationFrame focus restores. |
| src/lib/ai-task.ts:4 | none | AI_CLIENT_DEADLINE_MS = 190000 | none — The deadline only leads to a status read, and only after a tap. |
| src/lib/ai-task.ts:344 | cooldown | How the client treats a POST 4xx (429 included) when no run record exists: the task is marked FAILED locally and not retried (lines 344-361) | cooldown on the manual retry |
| src/lib/ai-task.ts:365 | none | The 190 s client deadline (AI_CLIENT_DEADLINE_MS line 4, set at 313), plus an immediate exit when navigator.onLine === false | none — Reaching the 190 s deadline or going offline only changes UI state |
| src/lib/ai-task.ts:368 | period | runAiTask status loop: after the POST, GET /api/ai-runs/{id} every 2500 ms until the 190 s deadline (lines 312-370; first wait at line 332, later waits at 368-3 | period ±25%, a wake window after a failed POST, and a floor-plus-full-jitter backoff on failed reads |
| src/lib/api.ts:1 | retry-after | Client api(): fetch with a 20 s timeout for /bootstrap and 150 s otherwise | retry-after carrier |
| src/lib/api.ts:4 | none | Shared fetch wrapper: AbortSignal.timeout(20000) for /bootstrap and 150000 for everything else | none — Each timeout starts when its request starts, and people have already spread those |
| src/lib/materials.ts:17 | none | GET /api/materials/{id} with a 20 s timeout | none — One fetch a person starts, deduplicated in flight per id+hash, with a manual retry. |
| src/lib/materials.ts:31 | none | The in-memory material detail cache is keyed by id+contentHash with no time-based expiry (26-42) | none — Client caches have no TTLs; events invalidate them, so nothing on the client can expire together. |
| src/lib/offline.ts:70 | none | cacheCards image prefetch | none — Each uncached image is fetched once per device (cached ones are skipped at offline.ts:68) and served private/immutable (uploads.go:322) |
| src/lib/offline.ts:154 | backoff | syncReviews drains the IndexedDB review queue | backoff |
