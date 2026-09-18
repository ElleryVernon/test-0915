# 문제 풀기 준비 화면 개선 · 2026-09-16

## 검토한 실제 화면

Mobbin MCP에서 iOS 화면 12개(9개 앱)의 이미지와 메타데이터를 직접 확인했다. Quizlet 4개는 같은 설정 흐름의 서로 다른 화면/상태이며, 독립된 앱 4개로 세지 않는다. 외형을 복제하지 않고 단계, 제약 안내, 선택 상태와 행동 위계를 가져왔다.

| 화면 | 관찰한 패턴 | 반영 판단 |
| --- | --- | --- |
| [Quizlet · Set up your test](https://mobbin.com/screens/efe8989b-a374-46fc-af31-94a5dd70a5c3) | 짧은 제목, 문제 수 등 간결한 설정 행, 하단 Start Test | 큰 소개 영역 축소, 설정과 시작 행동 분리 |
| [Quizlet · Answer options](https://mobbin.com/screens/ce347473-6eaa-490e-abaf-bfe92f6073bc) | 범위의 상세 설정은 별도 시트 | 기존 과목 선택 시트 유지, 초기 화면에 전체 목록 펼치지 않음 |
| [Quizlet · Options](https://mobbin.com/screens/0583e1dc-aaf2-4fd6-b38b-baf4d556bcfe) | General/Question types 등 설정 그룹 | 학습 범위/문제 종류/문제 수의 세 그룹만 노출 |
| [Quizlet · Options 선택 상태](https://mobbin.com/screens/bc7163c4-64bc-4469-b379-6c6554dc1fd8) | 동일 화면에서 명확한 활성/비활성 차이 | 선택된 모드와 수량은 진한 면과 밝은 글자로 구분 |
| [Nibble · Topic selection](https://mobbin.com/screens/aa5859b1-4dbd-45f9-a7f2-c40ce5e99e72) | 최대 3개라는 제약을 선택 전에 안내 | 실제 보유량 이내의 수량만 제공; 테두리 카드는 채택하지 않음 |
| [Preply · Weekly goals](https://mobbin.com/screens/8ac77975-6781-4ff3-aee0-9c3b6b602eea) | 숫자 프리셋과 학습 목표 분리 | 모드와 이번 회차 수량을 별도 그룹으로 표시 |
| [Uxcel Go · Topics](https://mobbin.com/screens/e8e07673-0f9e-4214-a511-67e1829c6671) | 선택 조건, Continue와 보조 Skip의 차등 위계 | 시작 CTA 하나, 새 문제 생성은 작은 아이콘 행 |
| [Duolingo · Goal selection](https://mobbin.com/screens/1a2c3854-ea7a-41fa-ab1b-95466c2c0228) | 선택된 면의 색과 명확한 상태 표현 | 보더 없이 면 대비와 aria-pressed; 만화풍 스타일은 제외 |
| [TIDE · Focus setup](https://mobbin.com/screens/f4e64ad4-04d4-4c21-a533-5075e17d05b7) | 현재 설정 수치와 Start를 가까이 배치 | 실제 시작할 문제 수를 CTA에 그대로 표시 |
| [Tiimo · Focus timer](https://mobbin.com/screens/2b65361e-d0de-4d94-bb81-8dd7d0b5949e) | 선택된 수치가 즉시 확인됨 | 수량 선택과 CTA가 동시에 갱신; 다이얼은 불필요해 제외 |
| [Opal · Session duration](https://mobbin.com/screens/649f9e92-3d9e-421f-8346-610bcbecd27d) | 프리셋과 실제 세션 값의 연결 | 범위가 줄어들면 가능한 전체 수량으로 명시적 선택 표시 |
| [Open · Meditation setup](https://mobbin.com/screens/48f57a40-c921-455f-9a53-73ee3132886d) | 한 개의 주 행동과 낮은 강조의 부가 설정 | 시작 강조, 자료 생성은 필요할 때만 들어가는 보조 행동 |

## 최종 동작 계약

- 기존 보더리스 기조: 설정은 회색 면, 선택은 진한 면으로 구별한다. 장식 테두리는 추가하지 않는다. 키보드 포커스 링은 접근성을 위해 유지한다.
- 공통 간격 토큰(`page-gutter`, `gap-section`, `gap-related`, `control-size`)을 사용한다. 대형 안내문과 반복 선택 카드 3개를 간결한 3개 모드로 바꾼다.
- `안 푼 것부터`는 기존의 우선 정렬 의미를 유지한다. 안 푼 문제를 먼저, 부족하면 이미 푼 문제를 이어서 푼다고 명시한다. `틀린 것만`은 마지막 풀이가 오답인 문제만 포함한다.
- 16개 보유 시 5개/10개/전체 16개. 3개 보유 시 전체 3개. 없는 20개/30개는 제시하지 않는다. 최대 회차 30개는 기존 범위를 유지한다.
- 과목이 바뀌어 개수가 줄면 요청 수량은 보존하되 실제 수량으로 선택·안내·CTA·세션을 일치시킨다. 다시 넓은 범위로 돌아오면 원래 요청 수량을 복원한다.
- 특정 자료에서 들어온 경우 그 자료 제목을 범위로 표시한다. 다른 과목 필터가 자료와 교차해 0개로 만드는 모순을 제거한다. 새 문제 생성에도 해당 자료를 전달한다.
- 오답이 없으면 `전체 문제에서 고르기`, 범위에 문제가 없으면 `자료로 문제 만들기`를 제공한다. 자료조차 없는 과목은 그 과목의 `자료 추가하기`로 연결한다. 실행 불가능한 0문제 버튼을 보여 주지 않는다.
- 문제 시작/뒤로는 기존 Journey 상태를 사용하며 선택한 범위·모드·문제 수를 보존한다. 실제 풀이/채점 UI는 변경하지 않는다.

검증 기록: `.unlazy/quiz-setup/GATES.md`, `.unlazy/quiz-setup/evidence.md`.
