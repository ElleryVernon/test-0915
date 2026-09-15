# 검증 기록

2026-09-15, 전용 로컬 PostgreSQL `127.0.0.1:15444/memoryz`와 Next.js 프로덕션 서버를 대상으로 확인했습니다. 샘플 사용자와 고유 접두사를 가진 검증 사용자만 사용했습니다. 외부 배포, 실제 OAuth 공급자 로그인, iOS·Android 기기 검증과 대규모 부하 시험은 수행하지 않았습니다.

## 자동 검증

최종 실행 결과는 루트 `GATES.md`와 `.unlazy/memoryz/gates/leaf-{backend,study,social}.md`의 명령·작업 경로·종료 상태·성공 표식으로 기록합니다. 각 leaf를 부모 작업에서 다시 실행한 뒤 통합합니다.

- 단위 검사: 고정 간격·FSRS, 원문 인용, 채점, 시간 충돌, 역할/프라이버시 집계, 이미지 가림, 사용자별 오프라인 기록과 AI 요청 복구.
- 실제 DB/API handler 검사: 소유권·역할·익명성·연결 코드 잠금·포인트 원자성·리뷰 UUID 중복 및 시각 경계.
- 실제 HTTP 검사: 로그인 세션, 교차 사용자 404, 역할 403, 자료·카드·오답·서술형·일정·응원·커뮤니티 저장, CSRF, 로그아웃과 AiRun 결과 재조회.
- 하네스 장애 검사: 합성 공급자 응답으로 동시 요청 409·입력 변경 409·타인 조회 404·완료 결과 재사용·잘못된 인용 거부·프로세스를 달리한 저장 결과 조회·stale 중단 상태를 검증. 이 검사는 실제 OpenRouter 호출과 구분합니다.
- Prisma migration diff 및 의존성 감사.

## Go 서버의 실제 프로바이더 검증 (2026-09-15)

`node server/scripts/provider-verify.mjs`(`server verify-provider`)로 quiz·essay·cards·grade·planner·ocr 를 각 1회 실제 호출했다(사용자 지시에 따른 유료 검사). 기록은 `.data/openrouter-verification.json`.

| 실행 | 공급자 순서 | 결과 |
| --- | --- | --- |
| 23:31 KST | Bedrock 우선(이전 기본) | 6개 모두 실패: 당시 프로바이더 호출 시한 120초 안에 본문을 끝까지 받지 못함(이후 시한을 175초로 올림) |
| 23:38 KST | Bedrock 우선 | 카드: Bedrock 이 93.4초 뒤 완성 토큰 0 으로 응답(형식 오류); 서술형: 인용 불일치 → 재시도 → 키워드 겹침으로 거부; 나머지 4개 통과, OpenAI 로 넘어간 호출은 68~89초 |
| 23:41 KST | `openai/fast` 우선(새 기본) | 6개 모두 통과, 재시도 0. 소요: OCR 1.5초, 카드 1.6초, 채점 2.8초, 퀴즈 3.2초, 서술형 4.5초, 플래너 6.2초. 토큰 3,757/2,194(추론 1,092), 비용 $0.0068 |
| 2026-09-16 00:28 KST | `openai/fast` 우선 | 리뷰 수정(21건) 뒤 재검증: 통과(leaf-6 Q3 증거; 세부 기록은 아래 실행이 덮어씀) |
| 2026-09-16 06:05 KST | `openai/fast` 우선 | 지터 작업(입장 세마포어·공급자 504 힌트·코드) 뒤 최종 AI 코드: 6개 모두 통과, 요청 7회(서술형 1회 자가 교정: 모범 답안에 없는 키워드 → 다시 생성). 소요: OCR 1.6초, 카드 2.0초, 채점 3.1초, 퀴즈 3.5초, 플래너 5.3초, 서술형 7.7초. 토큰 4,524/2,866(추론 1,482), 비용 $0.0087, codeHash `4347b533…` |

카드 뒷면은 답 한 문장(원문 문장 그대로)이고 형식 누출이 없다. 이전 Next.js 기록(2026-09-14 16:26 UTC, 6개 요청, $0.0046)과 같은 원문·같은 판정 기준을 쓴다.

## 실제 외부 AI

OpenRouter 모델 목록에서 `openai/gpt-5.6-luna`와 구조화 출력·추론 옵션을 확인했습니다. 같은 실제 어댑터로 객관식 1개, 서술형 1개, 카드 1개, 의미 채점, 일정 대안 2개, 합성 이미지 OCR을 검증했습니다. 요청 메타데이터는 `.data/openrouter-verification.json`에 기록되며 비밀키·숨겨진 추론은 포함하지 않습니다.

브라우저에서도 원문 기반 객관식 3개 생성과 이미지 카드 업로드/OCR을 실행했습니다. 실제 HTTP 서술형·일정 요청과 동일 UUID 재전송은 저장 결과를 재사용합니다. 연습용 로컬 규칙 채점 캡처는 실제 AI 채점과 파일명으로 구분합니다.

## 브라우저 검증

Codex 브라우저 모바일 뷰포트에서 실제 UI를 클릭·입력·업로드하며 확인했습니다. 주요 폭은 390px입니다. 화면별 근거는 [캡처 갤러리](screenshots/index.html), 변경 판단은 [화면 검토](VISUAL_REVIEW.md)에 있습니다.

- 학생 홈·학습·과목 자료·검색·알림과 하단 메뉴.
- 5문항 풀이, 정답/오답 해설, 점수 4/5와 오답 카드 생성.
- 서술형의 키워드 선택·논리 순서 잠금·힌트·직접 작성·피드백.
- 카드 뒤집기·FSRS 간격 표시·실제 평가 저장, 이미지 수동 가림·자동 형광펜 감지·정답 이미지 공개.
- PDF 업로드와 원문 추출, 인증 파일의 PDF.js canvas 렌더링과 실패 후 재시도 성공.
- 시간표 저장과 저장 전 일정 충돌 표시.
- 학생 커뮤니티 댓글·좋아요, 프로필·공개 범위·학부모 연결 화면.
- 별도 localhost 학부모 세션에서 자녀 통계·비공개 오답 상태·응원 전송·학부모 전용 게시판.

`*-before.png`는 개선 전 비교입니다. 실제 학습 기록을 저장했으므로 캡처별 카드 수·정답률·날짜·일정은 달라질 수 있습니다. 숫자를 맞추기 위해 화면 데이터를 조작하지 않았습니다.

## Go 서버 (2026-09-15)

Next.js 서버 코드를 대체하는 Go 서버(`server/`)는 리프별 검사를 한 러너로 다시 실행한다. 회귀 러너는 유료 AI 키를 비우고 전용 로컬 DB(`127.0.0.1:15444/memoryz`)만 허용하며, 스위트마다 종료 상태와 성공 표식을 함께 요구한다.

```bash
node server/scripts/regression.mjs
```

| 스위트 | 명령 | 검사 대상 |
| --- | --- | --- |
| static | build · vet · gofmt · `sqlc diff` | 컴파일·정적 결함·생성 코드 최신 여부 |
| go-test | `go test ./...` | SRS/플래너/PDF 골든(330/410 케이스), 인증, 세션, 캐시(Valkey Docker), 설정, DB, 시드, AI 실행기 |
| review-static | `server/scripts/review-static.mjs` | staticcheck, 중복 함수, 래퍼 |
| migrate-check | `server/scripts/migrate-check.mjs` | goose 마이그레이션 = Prisma 스키마 |
| config-safety | `server/scripts/config-safety.mjs` | 프로덕션 설정 거부 규칙, 비밀 미출력 |
| foundation-http · auth-http · seed-parity | `server/scripts/*.mjs` | 기반 HTTP(압축·시한·정적), 로그인·쿠키·정지·속도 제한, 데모 시드 13개 테이블 패리티 |
| integration-check · materials-http · study-review-http | `scripts/*.ts` (기존 검사 재사용) | 소유권·역할·자료·복습·학습 리뷰 계약 |
| api-contract · api-contract-community · api-contract-parent | `scripts/api-contract.ts`, `scripts/api-contract-community.ts`, `scripts/api-contract-parent.ts` | 전 엔드포인트 계약(가짜 OpenRouter 하네스 포함, 185/283/119 검사) |
| cache-http | `server/scripts/cache-http.mjs` | 캐시 hit/miss/304, 무효화, 캐시 답 = 계산 답 (29 검사) |
| telemetry-check | `server/scripts/telemetry-check.mjs` | 서버·질의 스팬 부모 관계, 로그 traceId, 지표, 프로덕션 설정 거부 (13 검사) |

부하(`LOAD_DURATION=15s node server/scripts/load-peak.mjs`, 캐시 계층 포함, 로컬):

| 시나리오 | 결과 |
| --- | --- |
| bootstrap c=50 | 12,469 req/s, p95 12 ms, 오류 0/187,150 |
| posts c=50 | 46,325 req/s, p95 3 ms |
| reviews 20명 동시 | 3,446 req/s, p95 11 ms |
| uploads 5 병렬 | 200 ×5, 2.8초 |
| bootstrap c=50, GOMAXPROCS=1 | 1,742 req/s, p95 50 ms |

bootstrap-parity(`server/scripts/bootstrap-parity.mjs`, TS 서버 ↔ Go 서버 깊은 비교 + 304)는 TS 서버를 제거하기 직전 leaf-1.5 H5 로 증명했고(BOOTSTRAP_PARITY_OK, 2026-09-15), TS 서버가 사라진 뒤로는 회귀 러너에서 제외했다. 이후 Go bootstrap 의 형태는 api-contract·cache-http 가 지킨다.

캐시 전 수치와 설계는 [CACHING.md](CACHING.md), 스팬·지표·로그·알림은 [OBSERVABILITY.md](OBSERVABILITY.md), 리뷰 결과는 [SERVER_REVIEW.md](SERVER_REVIEW.md).

## 검증의 경계

로컬 프로덕션 빌드는 공개 배포 성공을 의미하지 않습니다. 실제 OAuth 자격 증명, HTTPS 도메인, 백업·복원과 영속 파일 저장소, 운영 모니터링·부하 검증은 배포 환경에서 확인해야 합니다. AI 결과의 스키마·근거 검증이 모든 교육적 정확성을 보장하지 않으며, 학습 효과에 대한 임상적·실험적 성과 수치를 주장하지 않습니다.

추가 실행 확인: 전용 3001 서버만 중지하고 캐시된 카드 화면을 새로고침했습니다. 카드 정답 확인과 보통 평가가 기기에 1건 저장됐고, 서버 재시작 후 대기 기록이 사라지며 실제 DB의 카드가 GOOD·10분 뒤로 갱신됐습니다. 이는 서버 연결 중단 검증이며 기기 비행기 모드 검증은 아닙니다. 360px 및 430px에서 홈의 문서 폭과 뷰포트 폭이 일치했습니다.

환경 문제: 검증 중 공유 Docker VM 부하로 DB 연결이 일시적으로 15초를 넘겼습니다. 잠금·데이터 손실·컨테이너 재시작은 없었고 후속 연결 9~60ms, 쿼리 1~4ms로 회복 후 HTTP 45개 검사를 통과했습니다. 다른 프로젝트의 컨테이너는 수정하지 않았습니다.

최신 브라우저 복구 확인: 실제 문항 생성 중 새로고침 후 원래 3개 선택과 요청을 복구했습니다. DB에는 quiz 실행 1개만 완료됐고 자료의 객관식 개수가 4→7로 증가했습니다. AI 일정도 생성 중 새로고침 후 원래 날짜의 두 대안이 복구됐으며 Plan B를 선택해 적용했습니다.

반복 지연 해결: 공식 PostgreSQL 18.6 native 런타임을 프로젝트 안에 설치하고 전용 DB를 이전했습니다. 전환 시 27개 테이블·86행이 전체 해시로 일치했고, 기존 Docker 볼륨·백업을 보존했습니다. native 50회 연결 p95 12.83ms·최대 14.53ms, 별도 복원 및 재시작 검증을 통과했습니다. 이후 결과는 native의 같은15444 포트에서 검증합니다.

최종 실행 결과: 프로덕션 빌드, 단위 테스트 31개, DB handler 검사 102개, 실제 HTTP 검사 45개가 통과했습니다. 백엔드 6개·학습 7개·소셜 3개의 실행 가능한 게이트를 부모 작업에서 재검증했습니다. DB를 사용하는 검사는 native 전환 후에도 통과했습니다.

실제 브라우저 서술형은 100점·핵심 키워드 4/4의 OpenRouter 피드백과 원문 근거를 표시했습니다. AI Plan B의 4개 블록을 저장해 오늘 일정은 총 5개가 됐습니다. quiz/planner/grade AiRun 각각 1개가 같은 요청을 유지한 채 COMPLETED로 확인됐습니다. 최종 홈 브라우저 콘솔에 error/warn은 없었습니다.

관리자 권한의 신고 처리·계정 정지는 합성 관리자 계정을 사용한 API 검증이며, 실제 관리자 브라우저 로그인이나 외부 OAuth 성공으로 표현하지 않습니다.

## 시간표 리뷰 적용 (2026-09-15)

[시간표 리뷰 적용](SCHEDULE_REVIEW.md)에 항목별 반영 내용과 검증 범위를 기록했습니다. 단위 테스트 50개, DB handler 검사 102개, 새 빌드 대상 실제 HTTP 검사 48개가 통과했습니다. 실제 OpenRouter 일정 추천 1회도 확인했습니다. 브라우저 검증에서는 샘플 계정을 바꾸지 않았습니다. 대신 검증용 격리 학생 계정을 만들어 확인한 뒤 삭제했습니다. 캡처는 [시간표 리뷰 갤러리](screenshots/schedule-review/index.html)에 있습니다.

공급자 경로 변경 후 실제 OpenRouter 검증(2026-09-15): `scripts/backend-check.ts --provider-only`로 문항·서술형·카드·의미 채점·일정·이미지 OCR을 한 번씩 호출했습니다. 여섯 요청 모두 Amazon Bedrock이 처리했고 모든 검증을 통과했습니다(총 $0.0049, `.data/openrouter-verification.json`). 대체 경로는 `openai/fast`만 지정한 작은 요청 1회로 확인했습니다. OpenAI가 처리했고 같은 함수 호출 형식이 통과했습니다.
