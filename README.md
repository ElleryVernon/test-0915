# Memoryz

첨부한 HTML·PDF 디자인을 바탕으로 만든 한국어 모바일 학습 웹 앱입니다. 문제 풀이 → 서술형 → 오답노트 → 복습 카드로 이어지는 학습 기록을 PostgreSQL에 저장합니다. 학생과 학부모는 별도 메뉴·권한을 사용합니다.

## 로컬 실행

서버는 Go(`server/`), 웹은 Next.js 정적 빌드(`out/`)이며 한 프로세스가 둘 다 서빙합니다. 자세한 구조는 [docs/SERVER.md](docs/SERVER.md)·[docs/WEB.md](docs/WEB.md), 클라우드 배포는 [docs/CLOUD.md](docs/CLOUD.md).

Node.js 22 이상, Go 1.26, 전용 PostgreSQL(루프백 15444, DB `memoryz`)이 필요합니다. 현재 작업 환경에서는 `node scripts/native-db.mjs start` 로 DB 를 올린 뒤 아래를 실행합니다.

```sh
npm ci
cp .env.example .env        # DATABASE_URL, DEMO_MODE=true, APP_URL 확인
cd server && go run ./cmd/server migrate up && go run ./cmd/server seed-demo && cd ..   # 스키마·데모 시드 (또는 npm run db:seed)
npm run start               # Go 빌드 + next build + 사전 압축 + http://127.0.0.1:3000 (--detach 로 백그라운드)
```

개발: 터미널 1 `npm run dev:api`(Go, :8080), 터미널 2 `npm run dev`(Next, :3000, /api 는 Go 로 rewrite). 회귀 검사: `node server/scripts/regression.mjs`. 업로드 바이트는 DB(`ops.blob`)에, 클라우드에서는 GCS 에 저장됩니다. 기존 샘플 사용자가 있으면 seed 가 기록을 덮어쓰지 않습니다. 샘플 계정은 공개 서비스에서 사용하지 마세요.

## 구현된 흐름

- 학생 홈, 과목·자료 관리, 텍스트/PDF/이미지 업로드와 원문 열람
- 근거가 있는 객관식 문제, 해설, 앞뒤 개념 연결, 오답 카드 전환
- 키워드 선택 → 논리 순서 → 답안 작성 → 피드백의 서술형 학습
- 개념·관계·문제·블라인드 카드, 이미지 가림 영역 편집, 휴지통 복구
- 고정 간격 및 FSRS 맞춤 복습, IndexedDB 오프라인 카드와 UUID 중복 방지 동기화
- 시간표: 지금 선과 진행률, 60분 이상 빈 시간 채우기, 겹침 한 탭 수정, 학교 시간 템플릿, 근거가 있는 두 가지 학습 일정 제안([시간표 리뷰](docs/SCHEDULE_REVIEW.md))
- 역할별 커뮤니티, 댓글·저장·신고·차단·팔로우·쪽지
- 학부모 연결 코드, 학생이 선택한 공개 범위의 통계, 응원과 포인트
- 프로필, 공개 범위, 알림, 관리자 콘텐츠 관리

## 복습 방법

기획의 기본 방식은 다시 10분 / 어려움 1일 / 보통 3일 / 쉬움 7일입니다. 연속 두 번 쉬움은 암기완료로 분류합니다.

마이 → 나에게 맞는 복습에서 **기억에 맞춰서**를 선택하면 `ts-fsrs 5.4.2`의 FSRS-6 모델을 사용합니다. 목표 기억률은 90%, 선택 범위는 80–97%입니다. 카드별 기억 안정성·난이도·복습 시각을 저장하고 같은 입력으로 브라우저와 서버가 같은 간격을 계산합니다. FSRS의 암기완료는 표시이며, 복습 예정일이 되면 다시 등장합니다. 기존 고정 간격의 기록을 가짜 FSRS 학습 기록으로 변환하지 않습니다. 변경은 다음 평가부터 적용됩니다.

모델의 기본 파라미터를 사용하며 개인별 파라미터 최적화 학습은 포함하지 않습니다. 오프라인 기록은 당시 모드·목표 기억률·실제 복습 시각을 보존합니다. 오래된 다중 기기 충돌은 서버가 거절하고 기록을 보존합니다. 30일 이내 기록을 동기화할 수 있습니다. 망각했으면 ‘어려움’ 대신 ‘다시’를 선택해야 모델 입력이 정확합니다.

설계 근거와 라이선스는 [학습 방법론](docs/LEARNING_METHODS.md), [오픈소스 고지](docs/THIRD_PARTY_NOTICES.md)를 참고하세요.

## 외부 서비스 설정

OAuth: Google·Kakao·Naver·Apple의 CLIENT_ID/CLIENT_SECRET, AUTH_SECRET(무작위 32바이트 이상), APP_URL을 설정합니다. 콜백은 `APP_URL/api/auth/{provider}/callback`입니다. Apple secret은 유효한 ES256 JWT를 공급하고 만료 전에 교체합니다. 공급자에서 리다이렉트 주소를 등록해야 합니다. HTTP-only 세션, OAuth state·nonce 검증과 공급자별 불변 계정 ID 연결을 사용합니다.

OpenRouter: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=openai/gpt-5.6-luna`, `OPENROUTER_REASONING_EFFORT=high`를 설정합니다. 공급자는 OpenAI fast를 먼저 쓰고 실패하면 Amazon Bedrock us-east-1로만 넘깁니다(2026-09-15 측정으로 순서를 바꿨습니다 — [docs/SERVER.md](docs/SERVER.md) AI 절, `OPENROUTER_PROVIDER_ORDER`로 변경 가능). 문항·서술형·카드는 모드별 프롬프트로 만들고, 다른 형식이 섞이거나 근거가 없으면 거부 사유를 붙여 한 번만 다시 만듭니다. 생성 결과를 스키마와 원문 근거로 검증합니다. 이미지 OCR·문항 생성·의미 기반 서술형 채점·일정 제안에 사용됩니다. 키가 없으면 생성은 명시적으로 사용할 수 없다고 안내합니다. 기존 서술형은 키워드·순서·분량 기준의 연습 피드백으로 동작하고 일정 제안은 규칙 기반이라고 표시합니다. 실제 OpenRouter 생성·의미 채점·일정·OCR 호출을 검증했습니다(Go 서버: `node server/scripts/provider-verify.mjs`, 유료 6회 호출). 문항 생성·채점·일정 제안은 사용자별 UUID와 PostgreSQL 실행 기록으로 중복 호출을 막고, 새로고침 후 저장된 결과를 복구합니다. [AI 실행 설계](docs/AI_ARCHITECTURE.md)에 스킬·도구·재시도 경계를 정리했습니다. Google 로그인 클라이언트는 Google Cloud Console 에서 사람이 만들어야 하므로 `bash scripts/oauth-wizard.sh` 로 설정합니다([docs/CLOUD.md](docs/CLOUD.md)의 Google 로그인 절). Kakao·Naver·Apple 은 키가 있을 때만 켜집니다.

## 배포

PoC 는 GCP 프로젝트 `memoryz-prod`(서울 asia-northeast3)에서 돌아갑니다: Cloud Run(Go 서버가 API 와 정적 웹을 함께 서빙), Cloud SQL PostgreSQL 18, Memorystore for Valkey, GCS 업로드 저장소, 전역 HTTPS 부하분산기와 관리형 인증서 뒤의 공개 주소 **https://memoryz.kr**. 구성·배포 순서·검사·알림은 [docs/CLOUD.md](docs/CLOUD.md) 에 있습니다. 스키마는 Cloud Run 잡이 `server migrate up` 으로 적용합니다.

PoC 에서는 학생·학부모 체험을 위해 체험 계정을 켜 두었습니다(서비스의 `DEMO_MODE=true`). 실사용으로 넘어갈 때 끄고 재배포합니다. 업로드 읽기는 로그인·소유권 검사 뒤에만 허용됩니다. AI 요청은 동기식이며 서버 시한은 180초(공급자 호출 175초)입니다. 수업 피크(두 반 50명 동시 접속) 부하 검증은 [검증 기록](docs/VERIFICATION.md)에 있습니다.

## 검증

```sh
npm run typecheck
npm test
npm run build
node server/scripts/regression.mjs      # Go 테스트 + HTTP 계약 스위트 (전용 로컬 DB, 유료 AI 없음)
node scripts/delivery-check.mjs
node scripts/cloud-smoke.mjs            # 배포된 서비스 (gcloud 구성 memoryz)
```

DB 검사는 호스트·포트·DB 이름을 확인하고 고유 검증 사용자만 생성·정리합니다. 운영 DB를 검사 대상으로 넘기지 마세요. 실행 결과와 실제 브라우저 범위는 [검증 기록](docs/VERIFICATION.md)에 구분해 기록합니다.

## 기술과 디자인

Go 1.26.5(net/http, pgx v5, sqlc, goose, OpenTelemetry) / Next.js 16.3.5 정적 export / React 19.3.0 / Tailwind CSS 4.3.3 / PostgreSQL 18. 스키마는 Go 마이그레이션(`server/internal/db/migrations`)이 소유하고, Prisma 7.10.0 은 로컬 QA 스크립트의 DB 접근에만 씁니다. 재현 가능한 버전은 package-lock.json 과 server/go.mod 에 고정되어 있습니다.

화면 구조·문구·정보 밀도는 제공한 HTML과 PDF, 동작 상세는 세 DOCX와 PRD를 기준으로 구현했습니다. Pretendard·Outfit과 넉넉한 터치 영역, 모바일 하단 메뉴, 흰 바탕과 회색 면을 유지했습니다. 주황색 배경은 추가 제공한 이미지의 크림색 곡선 빛을 참고한 코드 기반 SVG이며 참고 이미지의 로고는 포함하지 않습니다.

## 독립 DB 실행 근거

공식 PostgreSQL 18.6 소스를 SHA256 확인 후 `.data/postgres-native/runtime`에 빌드했습니다. 전역 Homebrew 서비스와 다른 프로젝트의 컨테이너는 변경하지 않았습니다. 전환 시 27개 테이블·86행 전체 내용을 해시로 비교했고, 50회 연결 p95 12.83ms·최대 14.53ms를 확인했습니다. UTF8·UTC·SCRAM·루프백 전용입니다.

설치 재현은 `node scripts/native-db-install.mjs`입니다(macOS에서 검증, C 컴파일러와 make 필요). 기존 Docker DB 이전 도구의 `prepare`와 `cutover --app-stopped`는 초기 이전용입니다. 이미 활성화한 DB는 `start`로 실행합니다. `rollback --app-stopped`는 전환 후 데이터가 달라졌으면 중단합니다. 새 학습 기록이 생긴 뒤 Docker로 돌아가려면 현재 native DB를 새로 백업하여 Docker에 복원한 후 전환해야 합니다. 오래된 볼륨만 켜는 방식으로 되돌리지 않습니다.
