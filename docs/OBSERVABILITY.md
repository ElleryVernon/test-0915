# 관측성

Go 서버는 OpenTelemetry 로 스팬과 지표를, `log/slog` 로 구조화 로그를 낸다. 셋은 trace id 로 이어진다. 설정은 `OTEL_EXPORTER` 하나로 고른다.

| `OTEL_EXPORTER` | 스팬 | 지표 | 기본 |
| --- | --- | --- | --- |
| `none` | 없음(전파 헤더만 읽음) | 없음 | 개발 |
| `stdout` | JSON 한 줄씩 stdout | JSON stdout (60초) | 검증 스크립트 |
| `gcp` | OTLP/gRPC → `telemetry.googleapis.com:443` → Cloud Trace | 같은 엔드포인트 → Cloud Monitoring (60초, `prometheus.googleapis.com/` 이름공간) | 프로덕션 (`GOOGLE_CLOUD_PROJECT` 필수; `DB_INSTANCE` 의 프로젝트로 유추) |

`gcp` 는 Google 이 폐기 예고(2027-01 보관)한 Cloud Trace/Monitoring 전용 익스포터 대신 표준 OTLP 익스포터를 쓴다: TLS, ADC 의 per-RPC 자격 증명(`cloud-platform` 범위), `x-goog-user-project` 헤더, 리소스 속성 `gcp.project_id` + GCP 감지기(Cloud Run 서비스·리비전·리전). 필요한 API 는 `telemetry.googleapis.com`, 서비스 계정 역할은 `roles/telemetry.tracesWriter`·`roles/telemetry.metricsWriter`(leaf-3.1 검사가 확인).

`OTEL_SAMPLE_RATIO`(기본 1.0)는 루트 트레이스의 표본 비율이다. 부모가 있으면 부모의 결정을 따른다(`ParentBased`). PoC 규모(학생 100명)에서는 전부 남겨도 Cloud Trace 무료 한도 안이다.

## 스팬

| 스팬 | 출처 | 이름 | 비고 |
| --- | --- | --- | --- |
| 서버 | `httpx.Trace()` = `otelhttp` | `GET /api/materials/{id}` (식별자 제거) | `/api/health` 제외. `traceparent`·`X-Cloud-Trace-Context` 를 이어 받는다 |
| 질의 | `otelpgx` (`db.Connect`) | sqlc 질의 이름 (`ListSubjectsWithCounts`) | 문장 본문은 속성에 넣지 않는다(리터럴 노출 방지) |
| 풀 | `otelpgx` | `pool.acquire` | 풀 대기 시간이 보인다 |
| 준비 | `otelpgx` | 질의 스팬의 자식 | 연결당 최초 1회 |

전파: W3C `TraceContext` + `Baggage` 만 쓴다(Google 의 Cloud Trace 전파기는 폐기 예고). Cloud Run 앞단은 `traceparent` 를 함께 보내므로 스팬은 그것으로 이어지고, 요청 로그의 trace 상관은 스팬이 없을 때 `X-Cloud-Trace-Context` 를 읽는 것으로 보완한다.

## 지표

| 이름 | 종류 | 라벨 |
| --- | --- | --- |
| `http.server.request.duration` | 히스토그램(초) | method, status, route |
| `http.server.request.body.size`, `http.server.response.body.size` | 히스토그램 | 위와 같음 |
| `memoryz.db.pool.connections` | 게이지 | `state`: acquired / idle / max — Cloud Monitoring 에서는 `prometheus.googleapis.com/memoryz.db.pool.connections/gauge` (리소스 `prometheus_target`) |
| `memoryz.cache.requests` | 카운터 | `cache.name`: bootstrap / posts / schools, `cache.result`: hit / miss |
| `memoryz.db.pool.empty_acquires`, `memoryz.db.pool.empty_acquire_wait`(초), `memoryz.db.pool.canceled_acquires`, `memoryz.db.pool.lifetime_closes` | 누적 카운터 | 60 s 게이지 표본에 안 보이는 10 s 짜리 수업 종이 대기 횟수·시간의 증가로 보인다 |
| `memoryz.http.retry_after` | 히스토그램(초) | `http.response.status_code` — 거절이 준 재시도 힌트의 분포 |
| `memoryz.ai.queue_wait` | 히스토그램(초) | `admitted` — 유료 모델 호출이 입장 슬롯을 기다린 시간 |
| `memoryz.ai.upstream_429` | 카운터 | 모델 공급자가 429 로 거절한 호출 |

지터·재시도 설계와 이 지표로 무엇을 보는지는 [`docs/JITTER.md`](JITTER.md). 속도 제한 버킷이 LB 주소로 뭉치지 않는지는 서버 스팬 속성 `memoryz.client.hop`·`memoryz.client.entries`(주소는 남기지 않음)로 본다.

## 로그

JSON 한 줄(`LOG_FORMAT=json`; 프로덕션 기본). Cloud Logging 이 읽는 키를 쓴다.

| 필드 | 값 |
| --- | --- |
| `severity`, `message`, `time` | 표준 |
| `requestId` | 응답 헤더 `X-Request-Id` 와 같다 |
| `traceId` | 서버 스팬의 trace id |
| `logging.googleapis.com/trace` | `projects/<project>/traces/<traceId>` — 로그 탐색기에서 트레이스와 나란히 보인다 |
| `logging.googleapis.com/spanId` | 서버 스팬 id |
| 요청 로그 | `method`, `path`, `status`, `bytes`, `durationMs` (5xx 는 ERROR, `/_next/`·`/api/health` 는 DEBUG) |

클라이언트가 떠난 요청은 499 로 답한다(5xx 알림에 섞이지 않음). 500 은 `request failed` 로그에 오류 문자열을 남기고(재시도 힌트가 있는 5xx — 배포로 중단된 AI 실행 등 — 는 WARN), 패닉은 스택과 함께 `panic` 으로 남긴다. 비밀은 어디에도 찍히지 않는다(`config.Redacted`).

## 상태 확인

`GET /api/health` → `{status, database: connected, cache: ok|unavailable, cacheDriver}`. DB 가 답하지 않으면 503, 캐시는 보고만 한다. Cloud Run 의 startup 프로브와 업타임 검사가 이 경로를 본다(leaf-3.2).

`GET /api/live` → `{status: ok}`, I/O 없음. Cloud Run liveness 프로브가 이 경로를 본다: DB 가 흔들려도 모든 인스턴스가 함께 재시작하지 않는다.

## 알림 정책 (`scripts/deploy.mjs alerts`, 6개 — `verify-alerts` 가 개수·채널·업타임 호스트를 확인)

| 조건 | 임계 |
| --- | --- |
| 업타임 검사 memoryz-health(https://memoryz.kr/api/health) 실패 | 2분 |
| 5xx 비율 / 5xx 폭주 | 5분간 2% 초과, 또는 1분 정렬 구간 하나에서 10건 초과(같은 정책의 두 번째 조건, 재확인 창 0 — 한 번의 나쁜 1분에 바로 연다) |
| Cloud Run 요청 지연 p95 | 5분간 1초 초과 (bootstrap 목표 300 ms) |
| `memoryz.db.pool.connections{state=acquired}` | 5분간 5 초과 (인스턴스당 풀 6) |
| Cloud SQL CPU (`cloudsql.googleapis.com/database/cpu/utilization`) | 5분간 80% 초과 |
| Cloud SQL 디스크 (`cloudsql.googleapis.com/database/disk/utilization`) | 10분간 85% 초과 |

## 검증

`node server/scripts/telemetry-check.mjs` — stdout 익스포터로 서버를 띄워 `traceparent` 를 붙인 bootstrap 요청 하나를 보내고, 서버 스팬 이름·trace 계승·질의 스팬의 부모 관계·요청 로그의 traceId/spanId·지표 이름·프로덕션 설정 거부를 확인한다.
