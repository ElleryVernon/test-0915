# Go 서버 설계·병목·성능 리뷰

사용자 지시(2026-09-15): "쓸모없는 함수 래퍼, 병목 및 설계 결함, 성능 문제 검토 후 해결". 검토는 세 갈래로 했다 — (1) 정적 도구 `server/scripts/review-static.mjs`(staticcheck v0.8.1, go vet, 패키지 간 중복 함수 본문, 호출 1곳·한 문장짜리 비메서드 래퍼), (2) 사람의 설계 리뷰(계층·트랜잭션 경계·캐시 무효화·동시성·메모리), (3) 측정(bootstrap 질의 수 `TestBootstrapQueryCount`, PoC 피크 부하 `server/scripts/load-peak.mjs`). 발견마다 파일·분류·조치·검증을 적는다.

## 발견

### 1. `itoa` 가 두 패키지에 중복 정의 (wrapper)
- 파일: `server/internal/api/bootstrap.go`, `server/internal/demo/seed.go`
- 조치: 둘 다 `strconv.Itoa` 로 교체하고 함수 삭제.
- 검증: `node server/scripts/review-static.mjs` (중복 본문 0)
- 상태: 고침

### 2. UTF-16 길이 함수가 `pdfx` 와 `textmatch` 에 따로 구현 (wrapper)
- 파일: `server/internal/pdfx/layout.go`, `server/internal/textmatch/textmatch.go`
- 조치: `pdfx` 가 `textmatch.UTF16Len` 을 쓰도록 통일(오프셋 규칙이 한 곳에서만 정의됨).
- 검증: `go test ./internal/pdfx/` (X1·X3 고정물·단위 테스트 유지), review-static
- 상태: 고침

### 3. 호출이 한 곳뿐인 한 줄 투영 함수 5개 (wrapper)
- 파일: `server/internal/api/community.go` (postRecordOf, commentRecordOf), `server/internal/api/parent.go` (cheerOf), `server/internal/api/rows.go` (scheduleOf, attemptOf)
- 조치: 호출 지점에 구조체 리터럴로 인라인. 여러 곳에서 쓰는 투영(`subjectOf`, `cardOf`, `materialOf`, `questionOf`, `essayOf`)은 유지.
- 검증: review-static, H1–H5 계약 검사 재실행
- 상태: 고침

### 4. `pdfx` 가 go-pdfium 의 폐기 필드 `RenderPage.Image` 를 폴백으로 참조 (design)
- 파일: `server/internal/pdfx/extract.go`
- 조치: `RenderedImage` 만 사용(다음 메이저에서 제거될 필드 의존 제거).
- 검증: staticcheck SA1019 0건, `go test ./internal/pdfx/`
- 상태: 고침

### 5. `srs` 오류 문자열이 대문자로 시작 (design)
- 파일: `server/internal/srs/srs.go`
- 조치: Go 관례대로 소문자(ST1005). 오류는 `errors.Is` 로만 비교되며 사용자에게 노출되지 않는다.
- 검증: staticcheck 0건, `go test ./internal/srs/` (파리티 330 케이스 유지)
- 상태: 고침

### 6. 테스트에서 `Token(8) == Token(8)` 같은 항등 비교 (design)
- 파일: `server/internal/ids/ids_test.go`
- 조치: 두 값을 변수에 받아 비교(SA4000).
- 검증: staticcheck 0건
- 상태: 고침

### 7. bootstrap 이 `todayAttempts` 를 세고 버림 (wrapper)
- 파일: `server/internal/api/bootstrap.go`
- 조치: 죽은 계산 삭제.
- 검증: `go vet`, H5 bootstrap 파리티
- 상태: 고침

### 8. `cache.ErrUnavailable` 이 선언만 되고 쓰이지 않음 (wrapper)
- 파일: `server/internal/cache/valkey.go`
- 조치: 삭제(캐시 장애는 호출자가 미스로 다루며 `ratelimit` 가 로그를 남긴다).
- 검증: staticcheck/vet
- 상태: 고침

### 9. `clientIP` 가 `X-Forwarded-For` 의 첫 항목을 믿음 (design, 보안)
- 파일: `server/internal/api/api.go`
- 문제: Cloud Run 의 프런트엔드는 클라이언트가 보낸 XFF 뒤에 실제 IP 를 덧붙이므로 첫 항목은 위조 가능하다. 속도 제한이 우회된다.
- 조치: `TRUST_PROXY=true`(프로덕션)면 마지막 항목을, 아니면 `RemoteAddr` 만 쓴다.
- 검증: `go test ./internal/api/ -run TestClientIP`
- 상태: 고침

### 10. 파일 제공이 원본 전체를 메모리에 올림 (perf, 메모리)
- 파일: `server/internal/blob/*.go`, `server/internal/api/uploads.go`
- 문제: `Get` 이 `[]byte` 를 돌려주므로 10MB PDF 를 80개 동시 요청이 읽으면 800MB — 1GiB 인스턴스에서 OOM 위험.
- 조치: `blob.Store.Get` 이 `io.ReadCloser` 와 크기를 돌려주고, 제공 핸들러는 스트리밍(`io.Copy`)한다. 업로드 처리(추출)는 여전히 바이트가 필요하므로 그대로.
- 검증: H2 materials-http (ETag·길이·304 유지), `go test ./internal/blob/`
- 상태: 고침

### 11. 정적 셸 `index.html` 을 요청마다 디스크에서 읽고 압축은 요청 시 gzip 만 (perf)
- 파일: `server/internal/httpx/static.go`
- 조치: index.html 은 시작 시 메모리에 올리고 ETag 로 304; `_next/static` 등 불변 자산은 빌드가 만든 `.br`/`.gz` 사전 압축본을 `Accept-Encoding` 협상으로 제공(없으면 요청 시 gzip).
- 검증: `node server/scripts/foundation-http.mjs` (사전 압축 fixture 포함)
- 상태: 고침

### 12. `httpx.Deadline` 이 클라이언트 취소를 끊음 (design)
- 파일: `server/internal/httpx/middleware.go`
- 판단: AI 실행·업로드는 클라이언트가 끊어도 결과가 저장되어 같은 requestId 로 재요청 시 재생되므로, 취소를 끊는 것이 의도된 동작이다. 주석으로 사유를 남김.
- 검증: H4 AI 하네스(재생·중단 규칙)
- 상태: 유지(요청 취소와 무관하게 결과를 저장해 재생하는 것이 계약)

### 13. 속도 제한이 캐시 장애 시 열림(fail-open) (design)
- 파일: `server/internal/ratelimit/ratelimit.go`
- 판단: 캐시 장애로 학생 전원의 로그인·업로드를 막는 것보다 잠시 제한 없이 서비스하는 쪽이 낫다. 경고 로그로 관측된다.
- 검증: ratelimit 단위 테스트
- 상태: 유지(가용성 우선, 로그로 관측)

### 14. bootstrap 의 13개 병렬 질의가 풀(최대 6)을 두고 경쟁 (bottleneck)
- 파일: `server/internal/api/bootstrap.go`
- 측정: `TestBootstrapQueryCount` — 학생 14문·학부모 14문(데이터 크기 무관), 부하 `load-peak.mjs`.
- 조치: 질의 수는 고정(N+1 없음)임을 테스트로 고정하고, 풀 크기(6)와 동시 요청 50 에서 p95 를 측정해 기록. 병렬도는 errgroup 을 유지하되 한 요청이 풀을 독점하지 않도록 동시에 4개까지만 실행(`SetLimit(4)`).
- 검증: V3, V4
- 상태: 고침

### 15. bootstrap 이 요청마다 모든 자료 본문을 NFC 정규화·해시하고 발췌를 만듦 (perf)
- 파일: `server/internal/api/bootstrap.go`, `server/internal/db/migrations/00003_material_summary.sql`
- 측정: GOMAXPROCS=1 프로파일에서 `x/text/unicode/norm` 4.4%·`strings.Fields` 1.5% — 자료 본문 총량(학생당 최대 20×200KB)에 비례하는 요청당 비용.
- 조치: `Material.contentHash`·`excerpt` 컬럼을 두고 본문이 바뀔 때(생성·수정·시드) SQL 식으로 갱신, bootstrap 은 저장값을 읽는다. Prisma 미러도 갱신.
- 검증: G2 스키마 파리티, H4(contentHash·excerpt 값), V4
- 상태: 고침

### 16. 응답 압축이 요청당 CPU 의 36% (perf)
- 파일: `server/internal/httpx/gzip.go`
- 측정: 126KB bootstrap, GOMAXPROCS=1 프로파일에서 `compress/flate` 누적 36%(BestSpeed).
- 판단: 학교 네트워크에서 전송량 절감이 더 중요하고 레벨은 이미 최저. 근본 해결은 payload 축소 — 자료 본문을 bootstrap 에서 빼고 상세 API 로 옮기는 leaf-2 의 계약(contentLength·excerpt·contentHash 는 이미 제공). ETag 별 압축 결과 캐시는 leaf-1.7 에서 측정 후 결정.
- 검증: V4(GOMAXPROCS=1 p95 159ms)
- 상태: 유지(레벨 최저; payload 축소로 해결)

### 17. 외래키 참조 컬럼에 인덱스가 없어 카운트·역방향 조회가 전체 스캔 (bottleneck)
- 파일: `server/internal/db/migrations/00004_foreign_key_indexes.sql`, `prisma/schema.prisma`
- 측정: 다른 학생들의 복습 26,213건이 쌓인 뒤 한 학생의 bootstrap 이 GOMAXPROCS=1 에서 26 req/s·p95 2,774ms(`count(*) FROM CardReview WHERE cardId = …` 가 카드마다 전체 스캔). 인덱스 추가 후 434 req/s·p95 159ms. 다중 코어: 1,507 → 1,806 req/s.
- 조치: CardReview(cardId), Card/Material/Question/Essay/Schedule(subjectId), Question/Essay(materialId), Attempt(questionId, essayId), Post/Comment(userId), PostLike/PostSave/Report(postId), Block(blockedId), Follow(followingId), Message(recipientId,senderId,createdAt), ParentLink(studentId), Cheer(senderId,createdAt) 인덱스 20개.
- 검증: G2 스키마 파리티(Prisma 미러 동일), V4
- 상태: 고침

### 18. 서버가 프로파일링 수단 없이 배포됨 (design)
- 파일: `server/cmd/server/main.go`, `server/internal/config/config.go`
- 조치: `PPROF_ADDR`(루프백만 허용)로 net/http/pprof 를 켤 수 있게 함. 이 리뷰의 15·16·17 은 이것으로 찾았다.
- 검증: config 검증(루프백 외 주소 거부), 프로파일 로그
- 상태: 고침

## 허용 래퍼

- `internal/planner/ai.go:isSafeInteger` — `z.number().int()` 의 안전 정수 규칙을 이름으로 드러내는 술어. 호출은 한 곳이지만 인라인하면 규칙이 숨는다.
