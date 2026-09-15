# 클라우드 (GCP memoryz-prod, asia-northeast3)

PoC(고등학교 4개 반 100명 + 학부모)를 실제 클라우드에서 돌리기 위한 구성. 모든 gcloud 명령은 별도 구성 `memoryz`(`CLOUDSDK_ACTIVE_CONFIG_NAME=memoryz`)로만 실행하고 기본 구성(`default`, sinsin-486209)은 건드리지 않는다. 검사: `node server/scripts/gcp-check.mjs project|sql|valkey|infra`.

## 인벤토리

| 자원 | 이름 | 사양 |
| --- | --- | --- |
| 프로젝트 | memoryz-prod (201536310409) | 결제 0129C6-80A834-97FE3F, API: run, sqladmin, memorystore, storage, secretmanager, artifactregistry, servicenetworking, networkconnectivity, cloudscheduler, telemetry, cloudtrace, monitoring, logging |
| Cloud SQL | memoryz-pg | PostgreSQL 18, db-f1-micro, 사설 IP(default VPC 피어링) + 커넥터용 공인 IP, IAM 인증 on, 승인 네트워크 없음, 삭제 보호, PITR 7일, DB `memoryz`, 사용자 `memoryz`(비밀번호 시크릿), `memoryz-run@memoryz-prod.iam`(IAM), `innovoedutech@gmail.com`(IAM) |
| Memorystore for Valkey | memoryz-cache | VALKEY_8_0, shared-core-nano, 클러스터 모드 없음, IAM 인증 + 서버 인증 TLS, PSC 10.178.0.4:6379(primary) |
| GCS | gs://memoryz-prod-uploads | 균일 액세스, 공개 접근 차단; 키 `uploads/<uploadId>`, `uploads/<uploadId>/images/<imageId>` |
| Artifact Registry | asia-northeast3-docker.pkg.dev/memoryz-prod/memoryz | docker; 이미지 `server:<git sha>` |
| 서비스 계정 | memoryz-run | cloudsql.client, cloudsql.instanceUser, logging.logWriter, monitoring.metricWriter, cloudtrace.agent, memorystore.dbConnectionUser, telemetry.tracesWriter, telemetry.metricsWriter, 버킷 objectAdmin, 시크릿 accessor |
| Secret Manager | AUTH_SECRET, DB_PASSWORD, OPENROUTER_API_KEY, VALKEY_CA_PEM, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET | 값은 어디에도 출력하지 않는다 |
| Cloud Run | memoryz (서비스), memoryz-migrate · memoryz-migrate-status · memoryz-seed · memoryz-sweep (잡) | 아래 |
| Cloud Scheduler | memoryz-sweep | 매일 04:00 Asia/Seoul → memoryz-sweep 잡 |
| Cloud Monitoring | 업타임 memoryz-health(memoryz.kr), 이메일 채널, 정책 6개 | docs/OBSERVABILITY.md |

## 이미지

`Dockerfile`: 1단계 Node 22 로 `next build`(정적 export) + `scripts/precompress.mjs`, 2단계 Go 1.26 로 `CGO_ENABLED=0` 빌드(pdfium 은 wasm), 3단계 `gcr.io/distroless/base-debian12:nonroot`(glibc 만 있고 셸 없음 — webp 디코더가 purego 로 동적 로더를 요구해 `static` 은 못 쓴다). 한 프로세스가 `/srv/web` 을 `STATIC_DIR` 로 서빙한다.

```bash
node scripts/deploy.mjs image          # buildx linux/amd64 → Artifact Registry server:<tag>
node scripts/deploy.mjs verify-image   # 다이제스트·크기·version·설정 거부 확인
```

태그: 깨끗한 트리는 커밋 sha(12자), 커밋하지 않은 트리는 `<sha>-dirty-<내용 해시 10자>`(이미지 입력 파일의 diff·미추적 파일 내용으로 계산)라서 서로 다른 트리가 같은 태그를 쓰지 않는다. docker 는 배포 스크립트 전용 설정으로 돈다: Artifact Registry 는 gcloud(구성 `memoryz`) 자격 증명 도우미, Docker Hub 기반 이미지는 익명으로 받고, 사용자의 빌더·컨텍스트·CLI 플러그인은 심볼릭 링크로 공유한다. 사용자의 데스크톱 자격 증명 저장소는 쓰지 않는다(그 도우미가 멈춰 빌드가 `load metadata for docker.io/…` 에서 30분 걸린 적이 있다).

## 배포 순서

```bash
node scripts/deploy.mjs jobs      # memoryz-migrate(migrate up) → migrate status(pending 0) → memoryz-seed(seed-demo)
node scripts/deploy.mjs service   # Cloud Run 서비스 (첫 배포는 URL 을 안 뒤 APP_URL 로 한 번 더)
node scripts/deploy.mjs verify-service
node scripts/cloud-smoke.mjs      # health(valkey), 셸(br·ETag), 데모 로그인, bootstrap miss→hit→304, GCS 업로드, 로그·트레이스 상관
node scripts/deploy.mjs sweep     # memoryz-sweep 잡 + 스케줄러, 1회 실행
node scripts/deploy.mjs alerts && node scripts/deploy.mjs verify-alerts
```

서비스 사양(용량 모델): SA memoryz-run, min 1 · max 3, concurrency 80, 1 vCPU / 1 GiB, 시한 300초, startup CPU boost, gen2, Direct VPC egress(default/default, private ranges only), Cloud SQL 커넥터(IAM, 사설 IP), 프로브 startup `/api/health`(DB 확인)·liveness `/api/live`(I/O 없음), 환경: ENV=production, OTEL_EXPORTER=gcp, DB_IAM_AUTH, BLOB_STORE=gcs, VALKEY_IAM_AUTH, DEMO_MODE=true(PoC 데모 계정), TRUST_PROXY, 도메인 컷오버 뒤 TRUSTED_PROXIES=<memoryz-ip>(LB 가 X-Forwarded-For 끝에 자기 주소를 붙이므로 클라이언트는 그 앞 항목 — 없으면 전 사용자가 한 속도 제한 버킷), 시크릿 참조 AUTH_SECRET/OPENROUTER_API_KEY/VALKEY_CA_PEM(/GOOGLE_CLIENT_*). 마이그레이션은 서비스가 아니라 잡이 적용한다(`MIGRATE_ON_START` 는 끔).

## 스윕

`server sweep`(`server/internal/sweep`): 하루 넘게 자료에 붙지 않은 업로드(자료 url·카드 이미지가 가리키지 않는 것)의 행·이미지 행·객체를 지우고, 업로드 행이 없는 객체(`uploads/*`)를 지운다. 바이트를 먼저 지우고 행을 지우므로 중간에 죽어도 다음 실행이 이어서 정리한다. 결과는 JSON 한 줄. 로컬 검증: `go test ./internal/sweep/ -run TestSweep`.

## 관측·알림

OTLP(gcp) → Cloud Trace / Cloud Monitoring, 로그는 JSON(Cloud Logging 키), 요청 로그의 `traceId` 로 트레이스와 상관. 업타임 검사와 정책 6개(업타임 실패, 5xx 2%, p95 1초, 풀 포화, Cloud SQL CPU 80%, Cloud SQL 디스크 85%)는 `scripts/deploy.mjs alerts` 가 REST 로 만든다. 자세한 표는 docs/OBSERVABILITY.md.

## Google 로그인

Go 서버가 OIDC(인가 코드 + PKCE)를 직접 처리한다. 요청 범위는 `openid profile` 뿐이다(학생 이메일을 받지 않는다). 동의 화면은 External + 프로덕션 게시, 앱 이름 Memoryz, 승인된 도메인 memoryz.kr, 로고 없음(로고는 브랜드 검증을 요구한다). 웹 클라이언트 memoryz-web 의 JS 원본 `https://memoryz.kr`, 리디렉션 URI `https://memoryz.kr/api/auth/google/callback`. 클라이언트 ID·시크릿은 Secret Manager(GOOGLE_CLIENT_ID·GOOGLE_CLIENT_SECRET, 서울 복제, memoryz-run 만 읽기) → 서비스 환경 변수.

Console 단계는 사람이 해야 한다(약관 동의, 클라이언트 보안 비밀번호는 만들 때 한 번만 보인다). 도메인 컷오버 뒤 저장소 루트에서:

```bash
bash scripts/oauth-wizard.sh
```

마법사가 Console 페이지를 차례로 열고 무엇을 누를지 알려 주며, ID·보안 비밀번호를 숨김 입력으로 받아 Secret Manager 에 넣고, 실행 중인 이미지를 그대로 재배포한 뒤 `deploy.mjs verify-oauth`·`cloud-smoke.mjs --oauth` 를 돌린다. 마지막에 실제 로그인 확인을 `.unlazy/memoryz-cloud/status.log` 에 남긴다. 클라이언트를 바꿀 때(비밀번호 교체 등)도 같은 마법사를 다시 돌리면 된다.

## 도메인 memoryz.kr (leaf-8)

hosting.kr 에서 산 memoryz.kr 은 Cloud DNS 영역 `memoryz-kr`(public, DNSSEC 서명 on)이 관리한다. 등록기관의 네임서버를 아래 4개로 바꿨다(2026-09-16, `.kr` 상위 위임 TTL 1일):

```
ns-cloud-e1.googledomains.com
ns-cloud-e2.googledomains.com
ns-cloud-e3.googledomains.com
ns-cloud-e4.googledomains.com
```

DNSSEC 을 끝까지 켜려면 등록기관(hosting.kr → 도메인 → DNSSEC)에 이 DS 를 넣는다. 넣기 전까지는 서명된 영역이 비보안 위임으로 동작할 뿐 해석에는 문제가 없다. 확인: `node server/scripts/gcp-check.mjs dnssec`.

```
키 태그 58862 · 알고리즘 8 (RSASHA256) · 다이제스트 유형 2 (SHA-256)
다이제스트 4926F6EEE0AC65CDE9BF6A97E6E239AD174266E8F83251EFB2E4D883D5EB0BAD
```

Cloud Run 의 asia-northeast3 는 도메인 매핑을 지원하지 않으므로 전역 외부 HTTPS 부하분산기가 앞에 선다.

| 자원 | 이름 | 비고 |
| --- | --- | --- |
| 전역 고정 IP | memoryz-ip | 136.110.129.207 (A 레코드 memoryz.kr, www.memoryz.kr, TTL 300) |
| CAA | memoryz.kr | `0 issue "pki.goog"`, `0 issue "letsencrypt.org"` — 관리형 인증서를 내는 두 CA 만 허용 |
| 서버리스 NEG | memoryz-neg (asia-northeast3) | Cloud Run 서비스 memoryz |
| 백엔드 서비스 | memoryz-backend | EXTERNAL_MANAGED (서버리스 NEG 는 포트 이름을 받지 않는다) |
| URL 맵 | memoryz-lb | 기본 memoryz-backend; 호스트 www.memoryz.kr 은 301 로 memoryz.kr (경로·쿼리 유지) |
| 관리형 인증서 | memoryz-cert | memoryz.kr, www.memoryz.kr — 위임 뒤 PROVISIONING → ACTIVE. 캐시된 옛 위임 때문에 한동안 도메인 상태가 FAILED_NOT_VISIBLE 로 보일 수 있고 Google 이 계속 재시도한다 |
| HTTPS 프록시·전달 규칙 | memoryz-https-proxy, memoryz-https | 443, 프리미엄 티어 |
| HTTP → HTTPS | memoryz-http-redirect (URL 맵) → memoryz-http-proxy → memoryz-http | 80, 301, 쿼리 유지; www 는 곧장 https://memoryz.kr |

부하분산기의 리디렉션 `Location` 에는 기본 포트가 적힌다(`https://memoryz.kr:443/…`). 브라우저는 같은 주소로 다룬다.

위임을 바꾼 직후에는 운영자 PC 의 리졸버가 옛 위임(상위 TTL 1일)을 캐시해 hosting.kr 의 주차 IP 를 계속 줄 수 있다. 그래서 `domain-live` 검사와 클라우드 스모크는 공개 DNS(8.8.8.8·1.1.1.1)의 답으로 접속한다.

검사: `node server/scripts/gcp-check.mjs domain`(자원·레코드·CAA·www), `node server/scripts/gcp-check.mjs domain-live`(공개 DNS 위임, 인증서 ACTIVE, `https://memoryz.kr/api/health` 200, HTTP·www 301), `node server/scripts/gcp-check.mjs dnssec`(상위 DS 일치·AD 플래그).

컷오버(인증서 ACTIVE 뒤, 한 번): `node scripts/deploy.mjs service --app-url https://memoryz.kr`. 이 배포부터 APP_URL 이 https://memoryz.kr 이 되고(Secure 쿠키·CSRF·OAuth 콜백이 새 출처를 따른다) ingress 가 `internal-and-cloud-load-balancing` 으로 좁혀져 run.app 직접 접속은 404 가 된다. 이후의 일반 `deploy.mjs service` 는 설정된 도메인을 유지한다. 잡은 `deploy.mjs jobs`·`deploy.mjs sweep` 으로 갱신될 때 같은 APP_URL 을 받는다(잡은 공개 출처를 쓰지 않고 설정 검증에만 필요하다). 이어서 `node scripts/deploy.mjs alerts` 가 업타임 검사를 memoryz.kr 로 새로 만들고 건강 알림 정책을 옮긴 뒤 옛 검사를 지운다. 확인: `node scripts/deploy.mjs verify-service && node scripts/deploy.mjs verify-alerts && node scripts/cloud-smoke.mjs`(스모크는 서비스의 APP_URL 로 접속하고 run.app 이 닫혔는지도 본다).

비용: 전역 부하분산기 전달 규칙 과금과 처리 데이터 과금이 붙는다(요율은 Cloud Load Balancing 가격표를 따른다).

## 비용·한계

db-f1-micro(공유 코어, max_connections 25 → 인스턴스당 풀 6 × 3), shared-core-nano Valkey, Cloud Run 최소 1 인스턴스 상시. 학생 100명 규모에서 무료 크레딧 안에 들어가도록 잡았고, 커지면 Cloud SQL 티어와 max 인스턴스만 올리면 된다.
