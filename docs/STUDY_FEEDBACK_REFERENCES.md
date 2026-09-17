# 학습 홈·자료 선택 피드백 반영

2026-09-17. 기획 피드백 4·7 및 제공 영상의 해당 장면을 확인했다. 화면을 그대로 복제하지 않고 Memoryz의 무테·그레이스케일·공통 여백/버튼 체계에 맞췄다. 아래 20개 화면은 Mobbin 도구가 반환한 이미지 자체를 확인한 기록이다. 원본 출처는 각 링크이며, 이미지의 재배포나 외부 화면에 대한 기능 동작 보장은 포함하지 않는다.

검색에 공통으로 사용한 task_intent: `Improve a Korean learning app's payment, navigation, profile, study and guided writing journeys.`

## 피드백 4: 학습 메인을 네 가지 학습 방법으로

검색: `Learning app home screen with a grid of study modes or practice categories that open their own study settings` (iOS, 10개)

| 확인한 화면 | 이미지에서 확인한 구조 | 적용 판단 |
|---|---|---|
| [Speechify](https://mobbin.com/screens/02f4155e-b65f-4caa-b41c-dff661a843f6) | Productivity/Learning Differences 등 섹션 제목 아래 동일 크기 콘텐츠 타일을 모았다. | 타일은 학습 목적별로 묶되 Memoryz는 목적 네 개만 남겨 가로 스크롤 탐색 부담을 없앤다. |
| [Quizlet](https://mobbin.com/screens/2d3bf1c9-33a9-4c85-9fe7-237d44bada63) | For your next study session 카드에서 제목과 68 cards를 함께 보여주고 게임 진입을 따로 배치한다. | 방법명 아래 현재 학습 개수/상태를 작게 표시한다. 상세 설정은 해당 방법 안에 둔다. |
| [Headway](https://mobbin.com/screens/e6b2eb5b-40ce-42b8-8e2b-e47f4548671c) | Personalized challenges와 Collections가 별도 섹션이며 타일은 큰 목적명 중심이다. | 이름을 가장 먼저 읽고 선택할 수 있게 한다. 화면에 별도 과목 목록까지 중첩하지 않는다. |
| [Vocabulary](https://mobbin.com/screens/6ccd9069-79cf-49ed-b1f0-4dd23415d243) | Practice 안에서 Sprint/Rush/Perfection 세 가지 모드와 Categories를 구분했다. | 방법 선택과 내용 범위 선택을 별 단계로 둔다. 윤곽선/그림 스타일은 가져오지 않는다. |
| [Deezer](https://mobbin.com/screens/220e1105-97af-4bc9-ab3d-d55dfa448a73) | Music quizzes에서 2열 타일로 장르 이름을 동일한 위계로 보여준다. | 네 가지 기능에 동일한 크기·시각적 무게를 부여한다. 강한 색 배경은 가져오지 않는다. |
| [GoHenry](https://mobbin.com/screens/501e252e-9b4f-4dee-9cf8-2d9404ddff2c) | Learn에서 Banking basics, Jobs & earning 등 2열 주제 타일과 mission 수가 보인다. | 2×2 선택 구조와 이름/짧은 설명/개수 위계를 적용한다. 레벨·이미지 장식은 제외한다. |
| [NBA](https://mobbin.com/screens/96299a17-5205-4fec-a881-54fd586dc5bd) | Rank/IQ/Player Path/Hoop Connect 네 개 게임 진입이 2×2이며 각 설명을 포함한다. | 목적이 다른 네 가지 진입을 한눈에 비교할 수 있게 한다. 뒤의 홍보 배너는 적용하지 않는다. |
| [MyDyson](https://mobbin.com/screens/db7781be-da98-4713-9e56-5d435ca5d3dc) | Using your machine에서 두 열 카드마다 이미지와 짧은 기능 설명이 있다. | 한 카드 전체를 하나의 일관된 클릭 대상으로 만든다. 사진은 학습 목적 구분에 필요 없어 생략한다. |
| [Open](https://mobbin.com/screens/f90aa03c-22ba-4fb5-b80b-322300924195) | Breathe 내 Sleep/Energy/Focus/Transform 등 목적명이 2열 타일 위에 크게 보인다. | 사용자가 하고 싶은 행동을 먼저 고르는 구조를 적용한다. 필터는 기능 안에서 제공한다. |
| [Ulta Beauty](https://mobbin.com/screens/3c8aadc9-018e-4fd2-96f0-881ad3fa7abc) | Beauty Quizzes에서 Foundation/Skin Care/Hair Care/Lash 네 종류를 2×2로 보여준다. | 네 타일만으로도 선택이 완결되는 구조를 참고한다. 관련 없는 상단 쇼핑 탐색은 적용하지 않는다. |

### 구현

- `/study`: 플래시카드 → 서술형 도우미 → 문제은행 → 오답노트 네 타일을 제공한다. 각 타일은 목적 설명과 해당 학습 데이터의 요약을 가진다. 후속 요청에 따라 그 아래에는 두 칸 너비의 `내 과목·자료` 관리 진입을 별도 섹션으로 둔다.
- 메인의 별도 복습 배너·과목 목록·만들기 버튼을 제거한다. 기존 복습/생성/과목 필터는 각 기능 안에 유지한다.
- `StudySubjectLibrary`는 과목명순 목록, 학기 선택, 과목 추가/편집/시험 일정, 자료 올리기, 이전 이수 과목 진입을 보존한다. 공유 호출부에서 `/subjects`에 연결한다.
- `StudyLibraryAction`은 기능 첫 화면에서 내 과목·자료에 접근하는 같은 이름/형태의 진입점이다. 풀이 중에는 추가하지 않는다.
- 홈의 사진 찍기 링크가 사라지지 않도록 기존 `/study?upload=camera` 요청을 과목 라이브러리로 이어 준다.

## 피드백 7: 자료를 폴더로 찾아 선택하기

검색: `File picker showing folders, files, a search field, sort menu and the current folder path` (iOS, 10개)

| 확인한 화면 | 이미지에서 확인한 구조 | 적용 판단 |
|---|---|---|
| [Fabric](https://mobbin.com/screens/114f20bf-ce42-4001-b581-a45731e78538) | Add link 시트에서 상단 검색과 파일/폴더 아이콘이 있는 평평한 목록이 보인다. | 파일과 폴더의 시각적 종류를 구분하고 제목은 행의 주 정보로 둔다. |
| [Asana](https://mobbin.com/screens/eff26e28-709f-4640-b391-faa4dbc6f2d3) | Recents 문서 선택기에서 검색, 문서 썸네일, 날짜/용량, Recents/Shared/Browse 탐색이 보인다. | 폴더 탐색과 최근 자료를 나눈다. 긴 한국어 자료 제목에는 그리드보다 행 목록을 쓴다. |
| [Google Drive](https://mobbin.com/screens/0ce96445-b51d-46d6-a7fe-8d99ec44d4ab) | 정렬 메뉴에서 Name/Date modified 및 A to Z/Z to A 선택이 명시된다. | 순서를 추측하지 않도록 최근 등록순/이름순을 표시하고 동률에는 제목·ID 정렬로 안정성을 유지한다. |
| [Microsoft Copilot](https://mobbin.com/screens/b5d0dd1b-9a7b-47c0-bef0-ef5b3221968d) | On My iPhone 뒤로 경로와 현재 Chrome 폴더명이 상단에 함께 보인다. | 현재 폴더명과 내 자료로 돌아가기 버튼을 동시에 보여준다. |
| [OpenPhone](https://mobbin.com/screens/e8f062ee-eafa-4655-ac0a-61fca9ffe7e2) | Recents에 문서 종류별 썸네일과 개별 날짜/용량이 있고 Cancel이 분리되어 있다. | 각 행에 파일 유형/등록일을 보조 정보로 제공하고 취소는 선택 확정과 분리한다. |
| [Dropbox](https://mobbin.com/screens/e2456032-96ee-4874-b350-1868fe86f317) | Choose a folder에서 최근 폴더/전체 폴더, 선택 체크, 하단 Upload 확정 버튼이 분리된다. | 폴더를 이동하는 것과 자료를 확정하는 것을 분리한다. 선택은 초안으로 유지하고 N개 자료 사용하기으로 완료한다. |
| [Microsoft Teams](https://mobbin.com/screens/eefec72b-9a1d-4409-8a79-0aee0ae436cc) | 파일 선택기 검색 아래 적은 수의 최근 파일과 비어 있는 나머지 공간이 보인다. | 적은 자료에 과도한 채움이나 가짜 추천을 추가하지 않는다. 빈 상태는 실제 상태와 다음 행동을 설명한다. |
| [Microsoft Outlook](https://mobbin.com/screens/8b5e6da4-a287-404a-926c-aea0d7b5d484) | Files에서 My Files/Recent/Email Attachments/iCloud & Device를 아이콘과 화살표 행으로 표시한다. | 자료의 위치를 먼저 고르는 명확한 진입을 둔다. Memoryz에서는 이미 저장되는 과목이 폴더다. |
| [Speechify](https://mobbin.com/screens/665831f9-8fca-48ac-b4c5-9670f7e73b3b) | Recents에 자료의 제목·날짜·용량이 반복되는 문서 브라우저가 보인다. | 유사 제목을 구별할 수 있도록 유형·등록일을 유지한다. 검색 결과에는 과목도 표시한다. |
| [Upwork](https://mobbin.com/screens/a677ac33-413d-4140-ad01-d47806304865) | 문서 선택기에 Recents와 Browse 전환, 검색 및 두 개 파일이 보인다. | 최근 자료를 빠르게 선택하는 경로와 폴더를 찾아가는 경로를 모두 제공한다. |

### 구현

- 기존 과목을 실제 자료 폴더로 사용한다. 별도의 브라우저 전용 폴더 저장소나 분류를 만들지 않아 다른 기기와 데이터 구조가 같게 유지된다.
- 첫 화면은 과목명순 폴더·자료 개수, 선택한 자료가 있으면 해당 폴더를 연다. 현재 경로에서 한 번 누르면 전체 폴더로 돌아간다.
- 폴더 안 검색은 그 폴더로 제한되고, 루트 검색은 전체 자료명/과목명을 찾는다. 최근 자료는 전체 자료를 날짜순으로 보여준다.
- 자료의 제목 → 파일 유형/등록일 → 선택 표시 순서로 읽힌다. 자료 부족(20자 미만)은 선택을 막되 이유를 읽을 수 있게 유지한다.
- 선택한 자료는 폴더를 바꿔도 하단에 남으며, 명시적인 `N개 자료 사용하기` 버튼으로 적용한다. 이 버튼 자체는 생성을 시작하지 않는다.
- 빈 폴더, 검색 결과 없음, 사라진 선택 자료, 과목 미지정 자료를 별도로 처리한다. 과목 없는 기존 자료가 목록에서 사라지지 않는다.
- 임의 중첩 폴더 생성/이동 기능은 추가하지 않았다. 현재 과목-자료 구조를 기반으로 자료 선택을 폴더화한 구현이다.

## 검증·4-pass 기록

1. **완전 구현:** 네 가지 홈 진입, 과목 라이브러리 분리, 기존 촬영/생성 진입 유지, 재사용 가능한 폴더 선택기 구현.
2. **설계 재검토:** 버튼 이름을 `이 자료로 만들기`에서 `N개 자료 사용하기`으로 교정했다. 자료 선택 시트는 생성 설정을 확정하는 곳이 아니므로 즉시 생성하는 듯한 문구를 쓰지 않는다.
3. **정합성 검토:** 소속 과목이 없는 자료의 별도 폴더, 선택 자료 삭제 시 확인 비활성화, 빈 폴더, 20자 미만 문구의 가독성, 정렬 동률과 입력 배열 불변성을 확인했다. 미정의 hover 토큰을 발견해 기존 색상 토큰의 color-mix로 교정했다.
4. **마감 검토:** 키보드 focus-visible, 전체 버튼 클릭 영역, 넘치는 제목 줄바꿈, `aria-checked` 다중 선택 상태, 검색 범위를 드러내는 레이블, reduced-motion 처리를 점검했다. 마지막 재검토에서 추가 결함 없음.

집중 테스트: `tsx --import ./tests/register-css.mjs --test tests/material-folders.test.ts tests/study-library.test.ts` — 9개 통과. 여기서 확인한 것은 순수 로직과 서버 렌더링 구조다. 최종 호출부 연결·실제 브라우저 조작·전체 타입/빌드는 root 통합 게이트에서 별도 확인한다.


## 추가 피드백: 여러 자료와 일관된 시트 높이

- 한 주제에 최대 5개의 자료를 함께 선택한다. 폴더를 바꾸거나 검색해도 선택은 유지된다. 선택 목록에서 확인·해제하고, 하단에서 개수를 확인한 뒤 명시적으로 확정한다. 최근 자료/과목 폴더/선택한 자료의 검색 범위를 구분한다.
- 자료 개수와 선택 가능 개수를 구분하고 20자 미만의 자료는 이유와 함께 비활성화한다. 5개 초과 선택은 기존 선택을 유지하면서 안내한다.
- 자료 선택과 생성 설정은 같은 workspace 시트 크기(`min(760px,90dvh)`)를 사용한다. 검색·경로·하단 확인은 고정하고 목록/본문만 스크롤한다. 폴더 전환은 160ms fade/4px 이동, reduced-motion에서는 끈다.
- 여러 자료를 고른 뒤 집중할 주제(선택)와 결과 저장 과목을 지정할 수 있다. 전체 원문을 함께 사용하며 너무 큰 입력을 임의로 잘라 생성하지 않는다.
- 여러 자료로 만든 결과는 생성 당시 원문/제목/출처가 보존된 모은 자료에 저장한다. 원본이 수정·삭제돼도 근거를 확인할 수 있다. 서버가 소유권과 생성 중 변경을 검증한다.
- 브라우저 실측: 기본·빈 폴더·검색 결과 없음·긴 목록·생성 중·완료 모두 같은760px 높이와 하단CTA좌표를 유지했다. 실제3자료로서술형3개 생성, 결과와 원문3개 표시·개별 펼치기 확인. 해당 브라우저의 viewport override가 실제390px에 적용되지 않아 작은 화면 실기기 검증이라고 주장하지 않는다.
