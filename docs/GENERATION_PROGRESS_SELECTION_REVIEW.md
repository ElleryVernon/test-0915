# 생성 단계와 자료 선택 수 구분

2026-09-17. 상단의 `1/2`와 하단의 `0/5`가 같은 진행률처럼 읽히는 문제를 별도로 조사했다. Mobbin에서 단계 표시 10개, 선택 상태 10개 화면의 이미지를 직접 확인했다. 아래는 관찰이며, 화면만으로 확인할 수 없는 동작은 추정하지 않았다.

## 단계 표시: 10개

| 화면 | 실제 관찰 | 적용 판단 |
| --- | --- | --- |
| [Whatnot](https://mobbin.com/screens/a8062677-e4ed-44b5-81f5-b90e8325d2bd) | 하단 진행선, 5 of 8, Next | 하단 선택 수와 충돌하므로 위치와 숫자 표기 제외 |
| [Lifesum](https://mobbin.com/screens/36656131-4fbc-4015-8034-6ed3e2c01c29) | 하단 Step 1 of 4와 양쪽 이동 버튼 | Step은 뜻이 명확하지만 선택 도구와 경쟁하므로 제외 |
| [Deel](https://mobbin.com/screens/d4f1afe2-8c96-44e2-923d-043c11be46ab) | 세로 목록에 단계명과 COMPLETED | 완료 상태의 별도 표현 채택. 큰 세로 체크리스트는 2단계에 과해 제외 |
| [Cleo AI](https://mobbin.com/screens/31e28d24-288c-48d9-97d8-2738ad80ce3e) | 상단의 분절 진행선에서 현재 구간 강조 | 상단 진행선 채택. 다음 행동을 알 수 있도록 우리 UI에는 단계명 병기 |
| [X](https://mobbin.com/screens/fccd68c5-3134-4ca0-8943-f70a67114f4a) | 제목 아래 Step 1 of 2 | 간결하지만 숫자 두 곳의 구분 문제를 남기므로 제외 |
| [Remote](https://mobbin.com/screens/ef87911a-9220-4328-bcd8-b22137e88bfe) | 상단에 완료 체크, 현재 단계, 이후 단계 이름 | 이름과 완료 체크 채택. 여러 의미 색상 대신 기존 그레이스케일 사용 |
| [Zillow](https://mobbin.com/screens/aabf9607-16cd-4aea-bc1d-86a89d01d8de) | 긴 연결선에 단계 이름, 완료 체크, 현재 위치 | 순서와 완료 구분 채택. 많은 노드와 별도 분수 표기는 제외 |
| [Gorgias](https://mobbin.com/screens/1cd3ae3c-b294-40d9-97ae-8085a513e4c4) | 짧은 단계명 목록에서 현재 항목 강조 | 현재 이름 강조 채택. 숫자는 생략 |
| [Klaviyo](https://mobbin.com/screens/1cca6539-1631-4fe6-b399-3f1751ca81a6) | 모달 헤더에 작은 분절 진행 표시와 단계 이름 | 폼과 분리된 진행 상태 채택. 이름 없는 작은 점만으로 표현하지 않음 |
| [Gusto](https://mobbin.com/screens/95f7551e-b153-431b-82fd-47ac41509228) | 분절 진행선 아래 단계 이름, 현재 이름 강조 | 이번 상단의 주된 구조. 자료 선택/문제 설정 두 구간을 항상 표시 |

## 다중 선택 상태: 10개

| 화면 | 실제 관찰 | 적용 판단 |
| --- | --- | --- |
| [Google Photos](https://mobbin.com/screens/4ea47580-7372-4389-bcb0-fb4c714cfa98) | 최대 선택 수 안내와 선택된 9 items를 별도로 표시 | 선택 수와 최대 제한을 다른 정보로 분리 |
| [OpenPhone](https://mobbin.com/screens/04c3ef88-f825-4297-b030-dc94bf749b65) | 파일 위 체크, 하단 Select All/Deselect All | 체크와 해제 유지. 총량/단계 구분의 직접 근거는 아님 |
| [Tripsy](https://mobbin.com/screens/cf8d6d82-a690-4117-812a-df5bd64114cd) | 선택 파일 위 체크, 하단 선택 해제 | 체크 상태를 자료에 연결. 시스템 파일 선택 화면임을 감안 |
| [eBay 선택 전](https://mobbin.com/screens/b6a8da3d-7a62-494d-826a-eae1dba07065) | 하단 Select up to 23 photos | 제한을 분수가 아닌 문장으로 표시 |
| [WhatsApp](https://mobbin.com/screens/97d791d9-33c8-47d4-ba4e-cc94e019d94b) | 파일 행의 체크와 선택 배경, 해제 동작 | 행 전체 선택 상태와 명시적인 해제 유지 |
| [eBay 선택 후](https://mobbin.com/screens/432b2228-988a-4de0-9561-ff80324c5e0a) | Selected photos (2)와 Select up to 23 photos가 다른 줄·위계 | 이번 하단의 핵심 근거. 선택 수/목록 열기와 최대 제한 분리 |
| [Speechify](https://mobbin.com/screens/19f14b4e-89a8-4780-a4e6-02bc913bf9f0) | Done 아래 1 of 10 pages selected | selected라는 명칭은 명확함. 분수 형태는 이번 문제 때문에 제외 |
| [Tinder](https://mobbin.com/screens/0784f517-2a0b-486f-ab8e-dd509574a30b) | 상단 1 of 6 Selected, 사진 체크 | 선택이라는 단어는 참고하되 상단 단계와 경쟁하는 위치는 제외 |
| [Givingli](https://mobbin.com/screens/52f9403d-6da0-4c01-a027-bed1f9a6e9f1) | 하단 4/5 Photos Selected | 분모/분자 혼동을 그대로 남기므로 채택하지 않음 |
| [Apple News](https://mobbin.com/screens/0fb77b7c-cbad-4cb3-81de-25425cc6915d) | 하단 1 Selected와 작업 버튼 | 선택 개수를 선택 작업 가까이에 두는 원칙 채택 |

## 반영

- 상단: 숫자와 분수 없이 `자료 선택`과 `문제 설정`(카드는 `카드 설정`)을 두 분절 진행선으로 표시한다. 현재 단계 이름을 강조하고 완료 단계는 체크로 구분한다. 완료 단계는 밑줄 있는 버튼으로 되돌아갈 수 있다. `aria-current="step"`으로 현재 위치도 전달한다.
- 하단: 선택 전에는 읽을 수 있는 `선택한 자료 0개`, 선택 후에는 `선택한 자료 N개 보기` 버튼을 표시한다. 최대 5개는 별도 비상호작용 안내다. 기존 선택 해제 기능을 유지한다.
- 선택 상태는 검정/회색, 생성 CTA는 기존 주황색을 사용한다. 장식 테두리를 추가하지 않는다.
- 같은 구성요소를 쓰는 서술형·객관식·복습 카드에 함께 적용한다.

## 확인

로컬 3000에서 자료 0개 → 1개 → 2개 선택과 설정 단계 이동을 직접 조작했다. 현재 단계의 `aria-current`가 자료 선택에서 문제 설정으로 바뀌며, 완료한 자료 선택은 체크와 되돌아가기 버튼으로 남는다. 두 화면의 시트 높이는 모두 760px이고 가로 넘침이 없었다. 캡처는 `.unlazy/essay-composer/screenshots/08-step-selection-two.png`와 `09-step-configuration.png`에 저장했다.
