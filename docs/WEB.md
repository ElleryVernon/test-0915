# 웹 (Next.js 정적 빌드 → Go 가 서빙)

2026-09-15 부터 웹은 브라우저에서만 도는 정적 파일이다. Next.js 는 빌드 도구이자 개발 서버이고, 프로덕션에서는 Go 서버(`server/`)가 같은 출처에서 API 와 정적 파일을 함께 낸다. Node 서버 코드는 없다.

## 개발

```bash
# 터미널 1: Go API (:8080) — scripts/dev-api.mjs 가 .env 를 읽고 APP_URL=http://127.0.0.1:3000 으로 띄운다
npm run dev:api
# 터미널 2: `next dev` (:3000) — /api/* 는 GO_API_URL 로 rewrite
npm run dev
```

`next.config.ts` 는 개발 단계(`PHASE_DEVELOPMENT_SERVER`)에서만 `/api/:path*` 를 `GO_API_URL`(기본 `http://127.0.0.1:8080`)로 rewrite 한다. 쿠키·Set-Cookie 는 그대로 통과한다. Go 의 `APP_URL` 은 브라우저 출처(`http://127.0.0.1:3000`)여야 CSRF 규칙이 프록시를 거친 요청을 받는다(`dev:api` 가 그렇게 띄운다; Go 는 `.env` 를 직접 읽지 않는다). 검사: `node scripts/dev-proxy-check.mjs`.

## 빌드

```bash
npm run build      # next build (output: 'export') → out/  +  node scripts/precompress.mjs out
```

- `output: 'export'` 는 빌드 단계에서만 켜진다. `src/app/[...path]/page.tsx` 의 `generateStaticParams` 가 알려진 최상위 화면(`/study`, `/planner`, …)을 `out/<screen>.html` 로 내고(Go 가 `/<screen>` 을 그 문서로 답함), 그 밖의 경로(`/subjects/<id>` 등)는 Go 의 셸 폴백(`httpx.NewSPA`)이 `index.html` 로 답한다.
- `scripts/precompress.mjs` 가 `out/**` 의 html/js/css/svg/json/webmanifest 에 `.br`·`.gz` 형제를 만든다. Go 는 `Accept-Encoding` 에 맞는 형제를 그대로 보내고(`Content-Encoding`, `Vary`), `/_next/static/**` 는 `immutable`, 셸은 `no-cache` + ETag, `/sw.js` 는 `no-store`.
- 보안 헤더(nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy)는 `httpx.SecurityHeaders` 가 낸다. 예전 `next.config.ts` 의 `headers()` 는 export 에서 무시되므로 제거했다.

## 로컬 실행 (:3000)

```bash
npm run start      # = node scripts/start-local.mjs: Go 빌드 + next build + precompress + Go 가 :3000 에서 out/ 서빙
```

`--detach` 로 백그라운드(`.data/local-server.pid`, `.data/local-server.log`), `--no-web`/`--no-go` 로 재빌드 생략. 데이터베이스는 전용 로컬 `127.0.0.1:15444/memoryz` 만 허용한다.

## 배포 산출물

- 컨테이너 이미지에 `out/` 을 `STATIC_DIR` 로 넣고 Go 바이너리 하나가 :8080 에서 전부 서빙한다(leaf-3.2, docs/CLOUD.md).
- 서비스 워커(`public/sw.js`)는 `/_next/static/` 을 cache-first 로 두는데 export 도 같은 경로를 쓰므로 그대로 동작한다.

## 제거된 서버 코드와 그 대체

| 제거 | 대체 |
| --- | --- |
| `src/lib/server/api.ts` (REST 전체) | `server/internal/api/**` — `scripts/api-contract*.ts` 가 계약을 검사 |
| `src/lib/server/auth.ts`, `src/lib/oauth.ts`, `src/proxy.ts` | `server/internal/auth/**` (세션·OAuth·HTML 게이트) — `server/scripts/auth-http.mjs` |
| `src/lib/server/bootstrap.ts` | `server/internal/api/bootstrap.go` (+ 캐시, ETag/304) — `server/scripts/cache-http.mjs` |
| `src/lib/server/algorithms.ts`, `ai*.ts`, `skills*.ts`, `provider.ts` | `server/internal/{planner,textmatch,srs,ai}` — 골든 패리티(`server/testdata/reference/` 의 동결 사본이 오라클) |
| `src/lib/server/pdf-extract.ts`, `uploads.ts` | `server/internal/pdfx`, `internal/blob` — 골든·유사도, `scripts/materials-http.ts` |
| `src/lib/server/db.ts`, Prisma 런타임 | pgx + sqlc. Prisma 는 개발 전용(스키마 diff `server/scripts/migrate-check.mjs`, 시드 패리티) |
| `src/app/api/**` 라우트 핸들러 | Go 라우트 |
| `tests/backend.test.ts` | Go 테스트 + 계약 스크립트 |

QA 스크립트의 `createSession` 은 `scripts/lib/session.ts`(pg 로 Session 행 삽입)로 옮겼다. `bootstrap-parity.mjs`(TS 서버 ↔ Go 서버 깊은 비교)는 TS 서버가 사라져 실행할 수 없으므로 회귀 러너에서 뺐다; 제거 직전의 증거는 `.unlazy/memoryz-cloud/gates/leaf-1.5.md` H5 에 있다.

## 공용 컨트롤 (OS 기본 UI 대체, 2026-09-15)

앱 화면에서 열리는 선택기는 모두 앱이 그린다(`src/components/ui-choice.tsx`, `ui-date.tsx`, 순수 로직 `src/lib/ui-logic.ts`). 파일 선택만 OS 경계라 네이티브로 둔다.

| 컨트롤 | 대체한 것 | 형태 |
| --- | --- | --- |
| `OptionList` | `<select>` (자료·과목처럼 항목이 적을 때) | 한 겹 시트/화면 안의 라디오 행: 아이콘 · 제목 · 메타 · 라디오 점, 5개 넘으면 "n개 더 보기" |
| `OptionField` | `<select>` (학년·교육과정·정렬·게시판) | 값을 보이는 필드 → 시트에 `OptionList`, 고르면 닫히고 포커스 복귀 |
| `DateField` / `MonthPicker` | `<input type=date>` | 월 그리드 시트(오늘·선택·범위 밖), "날짜 없음" 옵션 |
| `TimeField` | `<input type=time>` | 시·분 두 휠(5분 단위, 스냅 스크롤·탭·화살표 키) + "HH:MM로 정하기" |
| `Checkbox` | `<input type=checkbox>` | 앱이 그린 체크박스(role=checkbox) |
| `Stepper` | `<input type=number>` | −/+ 는 단위(step)만큼, 직접 입력은 범위 안에서 그대로 |
| `Slider` | `<input type=range>` | 트랙·엄지(role=slider, 화살표·Page·Home/End) |
| `noValidate` + `validationMessage` | 브라우저 검증 말풍선 | 인라인 문구 |

참고한 패턴: 토스의 선택 시트(항목 행 + 체크/라디오 + 하단 버튼)와 Mobbin 의 옵션 시트들 — 중첩 시트 대신 한 겹 안에서 고르는 구조. 검사: `npx tsx scripts/native-ui-audit.ts`(18개 화면 네이티브 컨트롤 0, 캡처 `docs/screenshots/native-ui/`), `tests/ui-logic.test.ts` + `scripts/ui-logic-mutation.mjs`.
