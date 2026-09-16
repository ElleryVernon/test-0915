# 캐싱 설계

Go 서버(`server/`)의 캐시 계층. 원칙은 하나다: **정확성은 Postgres 가 보장하고, 캐시는 시간만 줄인다.** 캐시가 비거나 사라져도 모든 응답은 질의로 다시 만들 수 있고, 캐시된 답은 언제나 같은 시점에 계산한 답과 바이트 단위로 같다(`server/scripts/cache-http.mjs` 가 이를 검사한다).

## 드라이버

| 환경 | 구현 | 비고 |
| --- | --- | --- |
| 클라우드 | Memorystore for Valkey 8 (`memoryz-cache`, asia-northeast3, 클러스터 모드 없음) | IAM 인증 + 서버 인증 TLS |
| 개발·검증 | 프로세스 내 맵 (`internal/cache/memory.go`) | 인스턴스 1개일 때 의미가 같다 |

Valkey 클라이언트(`internal/cache/valkey.go`)는 `valkey-go` 를 쓴다.

- **IAM 인증**: 서비스 계정의 액세스 토큰이 비밀번호다. `AuthCredentialsFn` 이 연결마다 토큰(10분 조기 갱신하는 `FindDefaultCredentialsWithParams`)을 받아 `AUTH <token>` 으로 보내고, 만료 5분 + U[0,60 s) 전에 다시 인증한다. 만료가 이미 가까우면 U[30 s, 90 s)(남은 시간의 절반 이하) 뒤에 한다. 토큰이 1시간마다 바뀌어도 오래 산 연결이 끊기지 않고, 함께 연결된 연결들이 같은 순간에 재인증하지 않는다(`docs/JITTER.md`).
- **연산 시한**: Get·Set·Del 과 두 Lua 스크립트는 연산마다 250 ms 시한 안에서 돈다. valkey-go 의 재시도(equal jitter)는 그 안에서만 일어나고, 캐시가 멈추면 요청은 캐시 없이 진행한다.
- **TLS**: `VALKEY_CA_PEM`(인스턴스 CA, `gcloud memorystore instances get-certificate-authority`)이 있으면 그 CA 로만 서버를 검증한다(TLS 1.2 이상). 프로덕션에서는 CA 없는 설정을 거부한다.
- 로컬 통합 테스트(`go test ./internal/cache/ -run TestValkey`)는 Docker 의 `valkey/valkey:8` 을 자체 CA·ACL 로 띄워 같은 경로(TLS + AUTH 비밀번호 + 갱신 콜백)를 검증한다.

설정: `VALKEY_ADDR`, `VALKEY_IAM_AUTH`(프로덕션 기본 true), `VALKEY_CA_PEM`, `VALKEY_TLS_SERVER_NAME`, 로컬용 `VALKEY_USERNAME`/`VALKEY_PASSWORD`.

## 키·TTL·무효화

<!-- jitter: none — documentation of the cache keys and TTLs the code sets; it schedules nothing [site docs/CACHING.md:22] -->
| 키 | 내용 | TTL | 무효화 |
| --- | --- | --- | --- |
| `sess:<sha256(token)>` | 세션 행 스냅샷 | 60초 | 로그아웃·재로그인에서 삭제 |
| `user:<userId>` | 사용자 행 스냅샷 | 60초 | 프로필 변경·정지·포인트 변동에서 `auth.Invalidate` |
| `ver:<userId>` | 계정의 캐시 버전(십진 문자열) | 7일 | 그 계정의 성공한 쓰기마다 `max(현재+1, 현재 ms)` (`withUser`, 단조) |
| `ver:posts`, `ver:schools` | 공유 목록의 버전 | 7일 | 게시글·댓글·좋아요·차단·정지(저장 `/save` 는 제외) / 학교 생성 |
| `boot:<userId>:<learnerId>:<서울날짜>:<ver(user)>:<ver(learner)>` | ETag(34바이트) + bootstrap JSON | 60초 | 버전이 바뀌면 키가 바뀐다 |
| `posts:<userId>:<role>:<commented>:<ver(user)>:<ver(posts)>` | 피드 `[]PostView` JSON | 15초 | 위와 같음 |
| `schools:<ver(schools)>:<q>` | 학교 검색 결과 JSON | 1시간 | 위와 같음 |
| `rl:…` | 속도 제한 카운터(고정 창) | 창 길이 | 자연 만료(만료가 없는 키는 다음 증가에서 치유) |
| `lock:…` | 분산 락(`Cache.Lock`) — 지금 운영 코드는 쓰지 않는다(테스트만; 데모 시드는 Postgres advisory lock, 사용자 쓰기는 행 잠금) | 리스 | 소유자만 해제 |

### 버전 무효화

쓰기 뒤에 캐시 항목을 찾아 지우는 대신, **계정마다 버전 번호**를 두고 캐시 키에 그 번호를 넣는다. 쓰기는 번호만 올린다(`internal/api/cachelayer.go`). 옛 항목은 아무도 읽지 않고 TTL 로 사라진다. 이 방식은 무효화 누락이 구조적으로 생기지 않는다: 어떤 엔드포인트가 어떤 키에 영향을 주는지 목록을 관리할 필요가 없다.

- `withUser` 는 GET/HEAD 가 아닌 요청이 400 미만의 상태로 답하는 순간(응답 헤더가 나가기 직전, 즉 트랜잭션 커밋 뒤) 호출자의 버전을 올린다. 같은 위치에서 `/api/posts*`(저장 `/save` 는 보는 사람의 표시만 바꾸므로 제외), `/api/blocks*`, `/api/admin/users/{id}` 는 `ver:posts` 를, `/api/admin/schools` 는 `ver:schools` 를 한 번의 호출로 함께 올린다.
- 올리기는 Lua 한 번(`max(cur+1, now_ms)`, 동시 쓰기끼리도 값이 겹치지 않음)이고, 요청이 이미 취소됐어도 분리된 500 ms 문맥에서 full jitter 로 최대 3회 시도한다. 어떤 더 큰 값이든 유효한 올리기이므로 재시도는 멱등이다.
- 다른 계정의 화면을 바꾸는 쓰기는 명시적으로 그 계정도 올린다: 응원 보내기(자녀의 응원·알림), 관리자 정지(정지된 계정).
- 학부모의 bootstrap 은 자녀의 데이터를 담으므로 키에 **자녀의 버전**도 들어간다. 자녀가 무엇이든 쓰면 학부모의 다음 읽기는 miss 다.
- bootstrap 은 서울 날짜(연속 학습일·오늘 통계)에 의존하므로 키에 날짜가 들어간다. 자정을 넘기면 자동으로 새 항목이다.

경쟁 상태: bootstrap 이 버전을 읽고(v1) 질의하는 사이에 쓰기가 커밋되고 버전이 올라가면(v2), 옛 데이터는 `…:v1` 키에 저장되고 다음 읽기는 `…:v2` 를 찾아 miss 가 된다. 반대로 쓰기의 버전 증가는 항상 커밋 뒤에 일어나므로 새 버전 키에 옛 데이터가 들어갈 수 없다.

### ETag 와 304

bootstrap 항목은 ETag 와 본문을 한 값에 담는다. `If-None-Match` 가 맞으면 캐시만 보고 304 로 답한다(DB 접근 0). 응답 헤더 `X-Cache: hit|miss|shared` 로 어느 경로였는지 볼 수 있다(`shared` 는 다른 요청의 채우기를 기다려 받은 것).

### 채우기 합치기 (singleflight)

같은 키의 동시 미스는 로더를 한 번만 부른다(`fill`, `golang.org/x/sync/singleflight`). 데모 모드에서는 반 전체가 demo-student 의 bootstrap 키 하나를 쓰므로 수업 종의 미스 50건이 채우기 1회가 된다(`server/scripts/bell-check.mjs`). 채우기는 분리된 12 s 문맥에서 끝나 먼저 떠난 호출자가 취소하지 못하고, 결과는 다음 읽기의 hit 로 남는다. TTL 은 그대로다: 모든 키가 사용자별이거나 버전 키라 만료가 요청을 보내지 않으므로 TTL 에는 지터를 넣지 않는다.

## 속도 제한·재시도 계약

- 카운터는 원자적 Lua 한 번(INCR → PTTL → 만료 없으면 PEXPIRE)으로 (횟수, 창의 남은 시간)을 돌려준다. 캐시가 실패하면 열린 채 통과한다.
- 거절은 모두 `429` + `Retry-After`(올림 초) + 본문 `retryAfterMs` 를 갖는다: 창의 남은 시간 + U[0,15 s). AI 일 한도는 코드 `AI_DAILY_LIMIT` 와 정확한 남은 시간. 영구 503(`AI_UNAVAILABLE`, `PROVIDER_OFF`)은 코드만 갖는다. 전체 표와 이유는 [`docs/JITTER.md`](JITTER.md).
- 세션 스냅샷(`sess:`)은 세션 수명 8 d − U[0,12 h) 를 따르고, 남은 시간이 4 d 미만이면 인증 요청에서 미끄럼 갱신(쿠키 둘이 같은 Max-Age)되며 생성 + 30 d + 세션별 오프셋 U[0,28 d) 에서 멈춘다.

## 측정

PoC 피크(학생 50명 동시 bootstrap, `server/scripts/load-peak.mjs`, 로컬 M-series, 개발 DB):

| 시나리오 | 캐시 전 (leaf-1.9 V4) | 캐시 후 |
| --- | --- | --- |
| bootstrap c=50 | 1,806 req/s, p95 45 ms | 12,469 req/s, p95 12 ms |
| bootstrap c=50, GOMAXPROCS=1 (Cloud Run 1 vCPU 상당) | 436 req/s, p95 160 ms | 1,742 req/s, p95 50 ms |
| posts c=50 | 23k req/s | 46,325 req/s, p95 3 ms |
| reviews 20명 동시 | 2,068 req/s, p95 18 ms | 3,446 req/s, p95 11 ms |

bootstrap 크기(데모 학생 김지우, 자료 6개, 2026-09-15 측정):

| 페이로드 | 크기 |
| --- | --- |
| content 포함 (leaf-2.1 시점, 자료 본문 24,075바이트 동봉) | 68,087 B |
| content 제외 (leaf-2.2: contentLength·excerpt·contentHash 만) | 43,219 B |

본문은 `GET /api/materials/{id}` 로 열 때 한 번 받고 세션 동안 해시 키로 기억한다(`src/lib/materials.ts`). 저장 응답이 이미 본문을 담고 있으면(생성·수정·샘플) 그것으로 캐시를 채워 다음에 열 때 다시 받지 않는다 — 단 그 응답에는 파일의 이미지·쪽수가 없으므로, 파일 없는 자료이거나 편집기가 이미 상세를 불러온 수정일 때만 채운다(`rememberSavedMaterial`). 로그아웃·계정 전환·세션 만료(부트스트랩 401)에서는 `forgetMaterialDetails()` 로 전부 지운다: 로그아웃은 새로고침 없이 화면만 바꾸기 때문이다. 2만 자 자료 하나를 더해도 bootstrap 은 본문 바이트의 1.93% 만 는다(`scripts/materials-payload.ts`).

캐시 후 수치는 프로세스 내 캐시 기준이다. Valkey 는 왕복 약 0.3–1 ms 를 더하지만 Cloud Run 인스턴스가 여럿일 때도 같은 항목을 공유한다.

## 관측

- 지표 `memoryz.cache.requests{cache.name, cache.result}` (hit/miss 비율), `memoryz.http.retry_after`(거절 힌트 분포), `/api/health` 의 `cache: ok|unavailable` 과 `cacheDriver`.
- 캐시 오류는 요청을 실패시키지 않는다. 읽기 오류는 miss 로, 쓰기 오류는 경고 로그로 처리한다.

## 검증

- `node server/scripts/serve.mjs "node server/scripts/cache-http.mjs"` — hit/miss/304, 무효화(자료·복습·프로필·자녀의 쓰기·게시글·좋아요), 캐시 답과 새로 계산한 답의 동일성, hit 의 DB 연결 획득 0.
- `cd server && go test ./internal/cache/ -run TestValkey -v` — Docker Valkey 8 (TLS + ACL) 통합(창 스크립트의 치유·감소, 버전 스크립트의 하한·단조). `TestOpDeadline` 은 컨테이너를 멈춰 Get·Set·Del·Incr·Bump 가 모두 약 250 ms(허용 240–450 ms)에 오류로 끝나는지 본다.
- `node server/scripts/bell-check.mjs` — Valkey 컨테이너 + 풀 6 + 데모 모드로 수업 종(bootstrap 50건 → 채우기 1회)을 재현한다.
