# 실제 로그인 · 가입 온보딩

2026-09-17. Mobbin 검색 결과 이미지 10개를 직접 확인했다. 학생/학부모 선택과 프로필 입력의 실제 화면을 비교했으며, 참고 서비스의 색·테두리·장식은 복제하지 않는다.

| 화면 | 관찰 / Memoryz 적용 |
|---|---|
| [Duolingo ABC](https://mobbin.com/screens/2c9d91ca-7d27-4a1e-b30e-039e88b9ef99) | 누구를 위한 학습인지 한 질문, 설명이 붙은 선택지, 하단 계속. 역할을 소셜 로그인 이후에 선택. |
| [TikTok](https://mobbin.com/screens/3ee374c7-be6d-4996-bdac-c2fa8047b92c) | 가족 연결에서 부모/청소년 역할을 명확히 구분. 역할별 제공 기능을 선택지에 설명. |
| [Spotify Kids](https://mobbin.com/screens/bf5be757-1d6a-4dd8-9391-cee17bdfc1b3) | 선택한 대상에 따른 콘텐츠 구성, 선택 이유와 변경 가능성 안내. 학년은 실제 학습 설정에만 사용. |
| [Peacock](https://mobbin.com/screens/a1e0cc1c-ef7b-4118-8741-609bfbce0fcf) | 프로필 대상 선택과 정책 설명을 함께 표시. 큰 장식/과한 글자 크기는 채택하지 않음. |
| [Brilliant](https://mobbin.com/screens/0985030b-7fc2-488d-883e-d7575e93cb93) | 학습 목적을 사용자 행동 언어로 제시. 'STUDENT/PARENT' 대신 '직접 공부/자녀 응원'. |
| [Flo](https://mobbin.com/screens/a8f2b86d-154c-4bcd-835a-069e3cdfe6f1) | 불러줄 이름 한 가지에 집중. 실명·닉네임 중복 입력을 제거. |
| [Bevel](https://mobbin.com/screens/f0217a83-5962-427f-96bd-385972f6c604) | 한 입력, 상단 진행 안내, 고정된 하단 CTA. 숫자 분수 대신 이름 있는 3단계 표시. |
| [MyFitnessPal](https://mobbin.com/screens/6aba5d40-025e-4bfb-8533-47806b654fd1) | 입력 라벨과 이전/다음 동작이 분리됨. 뒤로 이동해도 작성값 유지. |
| [Deepstash](https://mobbin.com/screens/90d45b30-48ef-4d31-bc12-8d31cb2bfac5) | 이름 공개 이유 설명과 키보드 위 계속 버튼. 닉네임 공개 범위, 실명 비공개 안내. |
| [7-Eleven](https://mobbin.com/screens/0cbd3df5-92b7-4cb3-ac40-a60c1c61bc0e) | 현재 질문과 입력을 상단에, 계속 동작은 하단에 유지. 이름을 여러 칸으로 나누는 방식은 미채택. |

## 연결 구조

- `/`: Google/Naver/Kakao 실제 로그인. 역할 선택이나 데모 CTA를 로그인 전 화면에 섞지 않는다.
- `/demo`: 샘플 계정 전용. 공유되는 체험 데이터임을 명시. 실제 계정은 demo=false.
- OAuth 신규 계정 생성 트랜잭션 안에 가입 진행 행을 함께 만든다. 기존 계정의 역할/데이터는 유지한다.
- `/onboarding`: 이용 목적 → 공개 닉네임 → 학생 학년·학교(선택) 또는 학부모 연결 안내.
- 각 다음 단계에서 서버 저장. 재로그인/새로고침/다른 화면 직접 진입에서도 미완료 상태를 복구한다.
- 완료 요청은 프로필·역할·완료 표시를 단일 트랜잭션으로 저장한다. 반복 제출로 역할이 다시 바뀌지 않는다.
- 학생 → 자료 없는 상태의 `/study` 온보딩. 학부모 → `/parent`의 실제 자녀 연결. 가입 전에 자료나 자녀 연결을 강요하지 않는다.

## 설정 조사

- 로컬 `.env`: 세 제공자 CLIENT_ID/CLIENT_SECRET 존재(값 출력 안 함).
- GCP `memoryz-prod`: 여섯 Secret Manager 시크릿 존재. 조사 시 Cloud Run revision `memoryz-00018-x58`에는 OAuth env binding이 없었음.
- 기존 배포 스크립트는 Google만 연결하므로 세 제공자를 모두 확인/연결하도록 수정.
- 콜백 origin은 서버 APP_URL 한 곳에서 결정. localhost와 127.0.0.1을 섞어 사용해도 인증 시작부터 canonical origin으로 이동해 state 쿠키를 같은 호스트에 둔다.

## 로그인 화면 재설계 — 추가 Mobbin 10개

초기 로그인 디자인의 중복 소개·보조 아이콘 행·과도한 제목을 사용자 피드백에 따라 폐기했다. 아래 로그인 화면 10개의 이미지를 추가로 직접 확인했다.

| 화면 | 관찰 / 적용 |
|---|---|
| [Manus](https://mobbin.com/screens/d974bae0-ebea-4481-acf1-f96ee425253a) | 로고와 짧은 환영 문구 다음에 소셜 버튼을 묶음. 로딩 오버레이는 참고하지 않음. |
| [Replika](https://mobbin.com/screens/bd84a073-8759-4205-b536-aa777f9cf052) | 서비스 소개 한 문장, 로그인 수단을 하단에 고정된 묶음으로 배치. |
| [Meetup](https://mobbin.com/screens/3e2d6c66-4d14-47f3-9f4a-8f29d4356cd3) | 제공자별 아이콘 위치·버튼 높이가 일정함. |
| [Hypelist](https://mobbin.com/screens/d96461fe-6ec6-4fe1-b002-3ae3373b9e19) | 브랜드 메시지와 하단 인증 동작을 분리. 장식 배경은 미채택. |
| [Grok](https://mobbin.com/screens/fb90afc6-53ef-4872-9c73-34e1cd75b0d0) | 중앙 워드마크·짧은 태그라인·소셜 버튼 세 개의 분명한 계층. |
| [X](https://mobbin.com/screens/8b032d29-7249-4a31-9adf-cd8ca5182125) | 흰 배경에서 로고와 한 문장만으로 제품 진입을 구성. |
| [Alta](https://mobbin.com/screens/cbbe3ae0-d746-4c95-9b4c-e6615ea5f2aa) | 브랜드와 버튼만 남긴 간결함. 과도한 기능 설명 삭제. |
| [Sesame](https://mobbin.com/screens/359eeff7-962b-49df-bda6-f3e68e6c094f) | 한 문구와 하단 버튼, 동작을 방해하지 않는 여백. |
| [Vibecode](https://mobbin.com/screens/009c4ced-98c6-48cf-8eb4-1d31accc8074) | 로고와 로그인 동작의 명확한 분리. 모달/그라데이션은 채택하지 않음. |
| [Fabric](https://mobbin.com/screens/2213c0c1-1864-4899-897c-fb46ae86743f) | 인증 버튼의 일정한 행 높이와 라벨. 지원하지 않는 이메일 로그인은 추가하지 않음. |

최종 구성: 중앙 memoryz 워드마크 + 짧은 태그라인 → 하단 52px 소셜 로그인 3개 → 가입 안내 한 줄. `자료를 담고 → 내 것으로`, 중복 제목, 보안 장식 아이콘 삭제. 네이버 글자 아이콘의 line-height 때문에 버튼만 더 높아지던 문제를 공통 높이로 교정. `/login`은 체험 계정으로 접속 중에도 실제 로그인 화면을 열 수 있다.
