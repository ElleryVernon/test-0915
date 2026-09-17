# 기획자 피드백 적용 검토

사용자 영상(148.34초)의 주석과 화면을 직접 확인했다. 화면을 복사하지 않고 기존 4px 간격 토큰, 보더리스 면, 공용 버튼을 유지한다. 환산율은 사용자 결정대로 **1원 = 1P**다.

## 1. 충전 — 실제 확인한 Mobbin 10개

| 앱 | 화면 | 관찰·적용 판단 |
|---|---|---|
| 7-Eleven | [레퍼런스](https://mobbin.com/screens/baf73bb8-ea4f-4e65-865b-89edf7a5b5b2) | 잔액/금액타일/결제수단을 단계로 분리 |
| foodpanda | [레퍼런스](https://mobbin.com/screens/52f39938-c87c-45fc-aa00-bb8b24796b95) | 직접입력과 증가칩, 하단 결제금액 요약 |
| Setel | [레퍼런스](https://mobbin.com/screens/0d7b27a3-e126-4f44-91f5-5eaf628247a4) | 큰 입력금액과 6개 프리셋; 범위 없는 추천금액은 제외 |
| Cash App | [레퍼런스](https://mobbin.com/screens/0b475b65-1fec-4c7d-9f27-f60594330aec) | 잔액과 출금수단을 함께 표시하고 미선택 CTA 비활성 |
| Revolut | [레퍼런스](https://mobbin.com/screens/ea475d4c-ce2f-4351-be42-98e531db7aa9) | 금액·잔액·수수료를 가까이 표시; 커스텀키패드는 미채택 |
| Chime | [레퍼런스](https://mobbin.com/screens/bc213e0f-1c21-42cc-b5f4-22653f95a783) | 3개 금액칩과 간결한 CTA |
| Greenlight | [레퍼런스](https://mobbin.com/screens/6ebca236-22c1-4cb1-8233-ce493241c005) | 가족 지갑의 입금액과 도착지 구분 |
| Blinkit | [레퍼런스](https://mobbin.com/screens/749c61b4-10dc-4ed2-9a60-36b35cc1be39) | 선택금액·주의사항·결제수단의 순서 |
| Stake | [레퍼런스](https://mobbin.com/screens/542ff421-78fa-4043-895d-fc64ffff5c14) | 최소금액 오류를 입력 바로 아래 표시; 투자패턴은 미채택 |
| PayPal | [레퍼런스](https://mobbin.com/screens/8e7e1c32-3d2a-4760-b69a-16602c3225ee) | 실제 금액을 CTA에 넣고 완료예상을 별도 설명 |

적용: 응원 포인트 옆 충전 진입 → 잔액 → 직접 금액/3개 프리셋 → 결제금액과 적립포인트 → 결제창 → 서버 승인 → 잔액. 새 시트 안에 결제수단을 중복으로 만들지 않는다. 최근 충전 내역에 불명확 상태를 남겨 재결제 대신 기존 주문을 확인한다.

토스페이먼츠 개별 연동 SDK v2 + 서버 승인 어댑터를 준비했다. [공식 결제 흐름](https://docs.tosspayments.com/guides/v2/payment-window/integration), [멱등키](https://docs.tosspayments.com/reference/using-api/authorization), [API](https://docs.tosspayments.com/reference)를 확인했다. 서버가 소유자·금액·통화·키·DONE을 검증하며 주문 상태 전환과 포인트 적립을 단일 DB 트랜잭션으로 수행한다. 통신 끊김은 실패로 단정하지 않는다. 공유 체험 계정의 실결제를 차단한다.

### 결제 활성화에 남은 외부 설정

결제사 최종 결정과 가맹점 키는 아직 제공되지 않았다. 로컬 환경의 `.env`에 `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`를 설정한다(값은 소스/문서에 넣지 않음). 테스트 키는 development에서만 사용하며 운영 포인트와 섞지 않는다. 실결제는 일치하는 live 키와 명시적인 `PAYMENTS_LIVE=true`가 모두 있어야 활성화된다. 현재 키가 없으므로 UI는 준비 중으로 표시한다. 실제 PG 결제, 가맹점 검수/환불 운영 정책, 운영 활성화는 검증하지 않았다. 이 작업에서 실제 결제와 배포는 수행하지 않는다.

## 2. 상단 중복 마이 — 실제 확인한 Mobbin 10개

| 앱 | 화면 | 관찰·적용 판단 |
|---|---|---|
| Mesh | [레퍼런스](https://mobbin.com/screens/37ebf48a-c540-4049-9a1f-4362828eb7fd) | 하단 목적지와 상단 유틸리티를 분리 |
| X | [레퍼런스](https://mobbin.com/screens/dfee11d4-16ef-4c07-b1e5-39cdbdee8dc7) | 프로필 상세의 검색/공유는 남김; 홈 중복 진입의 근거로 쓰지 않음 |
| eBay | [레퍼런스](https://mobbin.com/screens/cbd160a2-7382-41c9-973b-2b2173e52efb) | My eBay를 하단 고정, 상단은 메시지/장바구니 |
| Qantas Airways | [레퍼런스](https://mobbin.com/screens/927328fb-d038-4b13-b86a-ffe7eadf878a) | My QFF 하단 고정, 상단은 설정 |
| Calm | [레퍼런스](https://mobbin.com/screens/74914500-b5e1-4982-a3fe-1131926aba11) | Profile 하단 고정, 상단 알림 유지 |
| GitHub | [레퍼런스](https://mobbin.com/screens/113e7ba0-1146-4e85-bed4-e813829b731c) | 프로필 상세 동작과 홈 진입 구분; 홈과 직접 동일시하지 않음 |
| Glassdoor | [레퍼런스](https://mobbin.com/screens/b321740d-3c75-47e7-9077-ffe677d38799) | 하단 프로필이 없는 경우 상단 프로필 필요: 본 서비스에 복제 안함 |
| NYTimes | [레퍼런스](https://mobbin.com/screens/fe20322d-55e4-40e6-8c3d-cffde53eb88a) | You 탭으로 계정행동 통합, 상단 설정만 제공 |
| Bond | [레퍼런스](https://mobbin.com/screens/4ab3f9f7-3693-4f6f-9089-23713a63efd1) | 계정은 컨텍스트 메뉴로 제공하지만 탐색성이 낮아 미채택 |
| Goodreads | [레퍼런스](https://mobbin.com/screens/a2796959-5c8d-46f9-87e8-a39682b2b3d5) | 하단 More에 계정을 모으고 알림 상세는 뒤로가기 |

홈 상단의 중복 프로필만 제거하고 검색/알림을 유지한다. 커뮤니티 내정보는 내 게시글/댓글/스크랩을 관리하는 별도 기능이므로 일반 마이페이지와 혼동하여 삭제하지 않는다.

## 3–7. 기능별 검토

- [프로필과 부모 알림](PROFILE_FEEDBACK_REFERENCES.md): 각각 10개 이상.
- [학습 네 진입점과 자료 폴더](STUDY_FEEDBACK_REFERENCES.md): 각각 10개 이상. 과목을 폴더로 재사용하여 기존 자료가 숨거나 복제되지 않게 했다.
- [키워드·단계·의미 단위·구조도](ESSAY_FEEDBACK_REFERENCES.md): 각 세부 피드백별 10개 이상. 정답은 확인 전 비공개, 구조도는 근거 있는 문장 순서만 표시한다.

## 검증

진행 결과와 실제 브라우저 증거는 `.unlazy/planner-feedback/GATES.md` 및 `browser-evidence.md`에 기록한다. 모의 PG 테스트와 실제 결제 검증은 구분한다.
