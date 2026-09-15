# Memoryz

첨부한 HTML·PDF 디자인을 바탕으로 만든 한국어 모바일 학습 웹 앱입니다. 문제 풀이 → 서술형 → 오답노트 → 복습 카드로 이어지는 학습 기록을 PostgreSQL에 저장합니다. 학생과 학부모는 별도 메뉴·권한을 사용합니다.

## 로컬 실행

Node.js 22.12 이상과 Docker가 필요합니다. 현재 작업 환경에는 전용 PostgreSQL 18.6 native 런타임과 프로덕션 앱이 `http://127.0.0.1:3000`에서 실행되어 있습니다. 공유 Docker VM의 반복적인 연결 지연을 피하도록 DB만 프로젝트 내부에 독립 실행했습니다.

현재 이 작업 환경에서 다시 시작할 때는 `node scripts/native-db.mjs start` 다음 `npm start`를 실행합니다. 상태와 검증은 `node scripts/native-db.mjs status` / `node scripts/native-db.mjs verify`입니다.

다른 환경에서 새로 설치할 때는 아래 Docker 경로를 사용할 수 있습니다. native와 Docker가 같은 15444 포트를 동시에 사용하면 안 됩니다.

```sh
npm ci
cp .env.example .env
# 샘플 체험 계정을 사용하려면 .env의 DEMO_MODE=true 설정
# APP_URL은 실제 접속할 주소와 일치시킵니다.
docker compose up -d
npx prisma migrate deploy
npm run db:seed
npm run build
npm start
```

개발 모드는 `npm run dev`입니다. PostgreSQL은 루프백 `15444` 포트의 전용 `memoryz` DB를 사용합니다. 현재 데이터는 `.data/postgres-native/data`에, 업로드 파일은 `.data/uploads`에 보관합니다. 전환 전 Docker 볼륨과 0600 권한의 백업도 보존했습니다. 신규 Docker 설치는 Docker 볼륨을 사용합니다. `.data`는 재생성 가능한 빌드 캐시가 아니므로 삭제하지 마세요. 기존 샘플 사용자가 있으면 seed가 기록을 덮어쓰지 않습니다. 샘플 계정은 공개 서비스에서 사용하지 마세요.

## 구현된 흐름

- 학생 홈, 과목·자료 관리, 텍스트/PDF/이미지 업로드와 원문 열람
- 근거가 있는 객관식 문제, 해설, 앞뒤 개념 연결, 오답 카드 전환
- 키워드 선택 → 논리 순서 → 답안 작성 → 피드백의 서술형 학습
- 개념·관계·문제·블라인드 카드, 이미지 가림 영역 편집, 휴지통 복구
- 고정 간격 및 FSRS 맞춤 복습, IndexedDB 오프라인 카드와 UUID 중복 방지 동기화
- 시간표, 충돌 방지, 두 가지 학습 일정 제안
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

OpenRouter: `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=openai/gpt-5.6-luna`, `OPENROUTER_REASONING_EFFORT=high`를 설정합니다. 생성 결과를 스키마와 원문 근거로 검증합니다. 이미지 OCR·문항 생성·의미 기반 서술형 채점·일정 제안에 사용됩니다. 키가 없으면 생성은 명시적으로 사용할 수 없다고 안내합니다. 기존 서술형은 키워드·순서·분량 기준의 연습 피드백으로 동작하고 일정 제안은 규칙 기반이라고 표시합니다. 실제 OpenRouter 생성·의미 채점·일정·OCR 호출을 검증했습니다. 문항 생성·채점·일정 제안은 사용자별 UUID와 PostgreSQL 실행 기록으로 중복 호출을 막고, 새로고침 후 저장된 결과를 복구합니다. [AI 실행 설계](docs/AI_ARCHITECTURE.md)에 스킬·도구·재시도 경계를 정리했습니다. 실제 외부 OAuth 로그인은 공급자 자격 증명이 없어 검증하지 않았습니다.

## 배포 조건

이 결과는 로컬 프로덕션 빌드이며 외부 배포는 수행하지 않았습니다. 공개 배포 시 DEMO_MODE=false, HTTPS와 정확한 APP_URL, 실제 OAuth 설정, 전용 DB 자격 증명, DB 백업·복원, 영속 업로드 스토리지가 필요합니다. 다중 인스턴스는 로컬 업로드 디렉터리를 공유 영속 저장소로 교체해야 합니다. 업로드 읽기는 로그인·소유권 검사 후에만 허용됩니다. AI는 120초 제한의 동기 요청이며 대규모 사용량에 대한 부하 검증은 하지 않았습니다.

## 검증

```sh
npm run typecheck
npm test
npm run build
npx tsx scripts/backend-check.ts
npx tsx scripts/integration-check.ts
node scripts/delivery-check.mjs
```

DB 검사는 호스트·포트·DB 이름을 확인하고 고유 검증 사용자만 생성·정리합니다. 운영 DB를 검사 대상으로 넘기지 마세요. 실행 결과와 실제 브라우저 범위는 [검증 기록](docs/VERIFICATION.md)에 구분해 기록합니다.

## 기술과 디자인

Next.js 16.3.5 / React 19.3.0 / Tailwind CSS 4.3.3 / Prisma 7.10.0 / PostgreSQL 18.6. 실험적 Prisma 8 RC 대신 최신 안정 버전을 사용했습니다. 재현 가능한 버전은 package-lock.json에 고정되어 있습니다.

화면 구조·문구·정보 밀도는 제공한 HTML과 PDF, 동작 상세는 세 DOCX와 PRD를 기준으로 구현했습니다. Pretendard·Outfit과 넉넉한 터치 영역, 모바일 하단 메뉴, 흰 바탕과 회색 면을 유지했습니다. 주황색 배경은 추가 제공한 이미지의 크림색 곡선 빛을 참고한 코드 기반 SVG이며 참고 이미지의 로고는 포함하지 않습니다.

## 독립 DB 실행 근거

공식 PostgreSQL 18.6 소스를 SHA256 확인 후 `.data/postgres-native/runtime`에 빌드했습니다. 전역 Homebrew 서비스와 다른 프로젝트의 컨테이너는 변경하지 않았습니다. 전환 시 27개 테이블·86행 전체 내용을 해시로 비교했고, 50회 연결 p95 12.83ms·최대 14.53ms를 확인했습니다. UTF8·UTC·SCRAM·루프백 전용입니다.

설치 재현은 `node scripts/native-db-install.mjs`입니다(macOS에서 검증, C 컴파일러와 make 필요). 기존 Docker DB 이전 도구의 `prepare`와 `cutover --app-stopped`는 초기 이전용입니다. 이미 활성화한 DB는 `start`로 실행합니다. `rollback --app-stopped`는 전환 후 데이터가 달라졌으면 중단합니다. 새 학습 기록이 생긴 뒤 Docker로 돌아가려면 현재 native DB를 새로 백업하여 Docker에 복원한 후 전환해야 합니다. 오래된 볼륨만 켜는 방식으로 되돌리지 않습니다.
