# 커뮤니티 에디터·첨부·댓글 재설계

확인일: 2026-09-16. Mobbin 화면을 직접 시각 확인한 뒤 기능군별 3~5개 패턴을 비교했다. 아래 구현 선택은 Memoryz에 맞춘 판단이며 원본 앱의 복제를 의미하지 않는다.

## 한국 커뮤니티 참고의 범위

Blind 공식 FAQ: 채널 선택, 짧은 수정/삭제 메뉴, 작성자 정보 숨김을 참고했다. [공식 FAQ](https://us.teamblind.com/faq).
Everytime은 [공식 커뮤니티 화면](https://everytime.kr/images/about/screenshot_community_main.png)과 [2021년 사용 캡처의 목록·웹 에디터](https://healthydoctor.tistory.com/171)를 확인했다. 현행 인증 뒤 모바일 편집기를 직접 확인한 것으로 간주하지 않았다. Blind 2개 공식 이미지+1개 기능 문서, Everytime 3개 캡처를 구분해 사용했다.

## Mobbin 기능별 화면과 적용

### 글쓰기

본문 중심의 독립 페이지와 고정 등록 버튼.

- [Reddit · 15aec94e](https://mobbin.com/screens/15aec94e-0fd1-4f6c-8ebc-3fb04d743241)
- [Reddit · 15ae0726](https://mobbin.com/screens/15ae0726-fb04-40d4-8558-4abb007a5fd3)
- [Reddit · e87881a5](https://mobbin.com/screens/e87881a5-d288-42ad-ab47-c659249415bb)

### 게시 위치·공개 범위

짧은 요약 버튼에서 별도 선택 시트로 이동. Shelf 필터는 관련성이 낮아 제외.

- [Nextdoor · 118819d8](https://mobbin.com/screens/118819d8-23d2-49e5-bb1c-d69bd0afcab1)
- [X · ebd28b98](https://mobbin.com/screens/ebd28b98-a2ba-47ba-8d11-053789903c89)

### 작성자·분류 설정

게시판·과목은 선택 후 적용. 작성자 표시의 이진 설정은 아래의 토글과 실시간 초안 미리보기로 개선했다.

- [Reddit · 9c6e1e63](https://mobbin.com/screens/9c6e1e63-a446-415e-b78e-009689999b17)
- [Reddit · de84ecbc](https://mobbin.com/screens/de84ecbc-3a9b-4797-987f-2158f4b67697)
- [Reddit · ca0f3c0b](https://mobbin.com/screens/ca0f3c0b-13db-4859-9e6d-248983e62d30)

### 사진

선택 후 미리보기에서 필요할 때만 편집 도구 노출.

- [X · 879e979d](https://mobbin.com/screens/879e979d-5b0d-4e2b-a3a3-907135aeb2ae)
- [Weverse · edae2a3c](https://mobbin.com/screens/edae2a3c-d1c7-468d-967d-3a22d217f29e)
- [Glassdoor · d894da36](https://mobbin.com/screens/d894da36-d590-4915-9dca-e7c634533c6d)

### 문제·카드·자료·서술형 보관함

검색 목록 → 선택 → 미리보기 → 첨부. 4종류에 공통 선택 패턴을 적용하며 각각 별도 학습 앱 사례 3개를 확보했다는 뜻은 아니다.

- [ClickUp · dfa8a11e](https://mobbin.com/screens/dfa8a11e-cbb3-4f53-828a-1f69ce38d1f7)
- [Fabric · 114f20bf](https://mobbin.com/screens/114f20bf-ce42-4001-b581-a45731e78538)
- [Upwork · a677ac33](https://mobbin.com/screens/a677ac33-413d-4140-ad01-d47806304865)

### 투표

질문·선택지·추가·완료가 한 기능 화면에 집중.

- [BFF · d0c57eeb](https://mobbin.com/screens/d0c57eeb-0a39-47f6-a0f6-bb29b1f16597)
- [Discord · 575a8225](https://mobbin.com/screens/575a8225-fbf2-4dfe-8d41-6ecd972cebd4)
- [Spotify for Creators · 479a91a6](https://mobbin.com/screens/479a91a6-012f-4ae8-8e6c-b83eed82fef9)

### 시간표

날짜와 선택 내용을 확인한 뒤 공유. Saturn은 공유 대상 선택, Bumble은 약속 계획 공유, Tock은 예약 날짜/시간 입력의 보조 패턴으로 분류.

- [Saturn Calendar · 6378cd8d](https://mobbin.com/screens/6378cd8d-9077-4a34-9f48-324660cbdb71)
- [Bumble · 123d7553](https://mobbin.com/screens/123d7553-993f-428b-bf07-fcb4e09f1b3f)
- [Tock · 04808674](https://mobbin.com/screens/04808674-d83f-4c61-abc8-745e877daca3)

### 수식

입력과 결과, 기호 삽입을 분리. Notion은 TeX, Craft는 표 공식, Brilliant는 학습 답 입력이므로 사용 맥락은 다르다.

- [Notion · 80f033ef](https://mobbin.com/screens/80f033ef-6d4c-4871-9bf0-ebbc78bf6cf9)
- [Craft · dba4c9a8](https://mobbin.com/screens/dba4c9a8-1812-457b-a943-1fe09b64b50b)
- [Brilliant · a10baa28](https://mobbin.com/screens/a10baa28-d259-48e7-b739-977ad1f14014)

### 첨부 진입

짧은 도구 선택 메뉴에서 해당 기능만 연다.

- [Claude · 42bb2da1](https://mobbin.com/screens/42bb2da1-3873-4690-858f-dbfd808e6a6b)
- [Slack · 4a27fca5](https://mobbin.com/screens/4a27fca5-8332-42ee-a332-d4640a2ae181)
- [Telegram · 56cff18a](https://mobbin.com/screens/56cff18a-985d-4572-8b83-df9fa5e318ec)

## 댓글 참고

- [Instagram · 30df9dc7](https://mobbin.com/screens/30df9dc7-3473-45af-ac50-216c3907d0c6)
- [Instagram · cdc0398b](https://mobbin.com/screens/cdc0398b-fdff-4e39-89ef-c5a73971eaf8)
- [Instagram · f5db6252](https://mobbin.com/screens/f5db6252-33d7-478a-a442-6e0f9f3987d1)
- [Reddit · 913899b4](https://mobbin.com/screens/913899b4-2884-4b16-9db4-1499f7f7b98a)
- [Reddit · c8d0c8de](https://mobbin.com/screens/c8d0c8de-df29-4497-bd85-9a4d6ef1e794)
- [Reddit · f5fcaa01](https://mobbin.com/screens/f5fcaa01-4cbe-4601-8473-2577ff8edb7e)

Instagram: 본문과 답글을 들여쓰기·접기로 구분하고 입력창을 계속 접근 가능하게 둔다. Reddit: 답글 맥락, 행별 액션, 명시적인 전송 동작을 참고했다. 이 관찰에서 Memoryz의 텍스트+학습 첨부 도구, 답글 맥락 바, 첨부 미리보기, 등록/실패 후 재시도를 설계했다.

## 구현 규칙

- 글쓰기 전체 화면과 기능 시트를 구분. 기본 입력 화면에는 게시 위치·작성자 요약, 제목·본문, 도구만 배치.
- 사진·문제·카드·자료는 바로 열고 기타 도구는 짧은 메뉴에서 선택. 도구 전환·뒤로가기에서 선택·입력 유지.
- 댓글은 등록순/최신순, 답글 펼치기, 내 댓글 수정/삭제, 공감과 채택을 구분. 채택이 시간순을 몰래 재정렬하지 않음.
- 댓글 초안은 계정/게시물별 7일 보존. 전송 성공 전에는 지우지 않고 실패 재시도는 같은 요청 ID를 사용.
- 수정은 별도 입력으로 열어 작성 중 댓글을 보존. 삭제한 댓글은 내용을 가리고 대화 맥락과 답글 유지.
- 모든 QA 쓰기는 고유 임시 DB에서 진행. 사용자 3000 서버는 빌드 중에도 기존 파일을 제공하고 완성된 export만 교체.

## 정보위계·토글 후속 개선

2026-09-16 추가 확인. Mobbin 6개 화면을 직접 비교했다.

- [Instagram 추가 설정](https://mobbin.com/screens/195e4b8e-d6a4-42f3-8754-b98bd52e869a): 설정 이름·설명과 우측 토글의 고정 정렬.
- [adidas Running 공개 설정](https://mobbin.com/screens/bf60b8e6-de4b-4051-9d4a-0d0154a92eae): 대상 선택과 켜기/끄기 설정의 구분, 무채색 스위치.
- [Places 계정 공개 설정](https://mobbin.com/screens/3b49e341-ceb4-4444-8dee-27bdeb41992a): 토글의 의미를 설명하는 짧은 보조 문구.
- [Runna 글쓰기](https://mobbin.com/screens/0cef665a-d7e9-4b3a-97d0-d5fd5cc20880): 본문 위의 간결한 게시 대상 선택.
- [Grab 글쓰기](https://mobbin.com/screens/ac382f6f-7372-44c8-8e66-884bd1fd27ee): 제목·본문 입력과 선택적 주제 설정 분리. 원본의 주제 위치를 그대로 복제하지 않았다.
- [Fable 글쓰기](https://mobbin.com/screens/639b4f5c-cfde-42a9-b912-c4b55c91bb09): 간단한 대상 요약과 별도 대상 선택 시트.

Memoryz에는 게시판 → 과목·작성자 요약 → 제목·본문 순서로 적용했다. 과목 선택이 제목과 본문 사이를 끊지 않도록 이동했다. 작성자 시트는 공통 `Switch` 두 행, 실제 표시 이름·학년 미리보기, 완료 버튼으로 구성했다. 토글은 현재 초안에 즉시 반영하고 게시판·과목 선택은 적용하기를 유지한다. 스위치는 전체 행을 누를 수 있으며 키보드 Space/Enter, 접근성 이름·설명·상태, 모션 감소 환경을 지원한다.

댓글 후속 확인에서는 [Threads 답글 작성](https://mobbin.com/screens/c6f17190-7b64-4143-b657-1b114fc25dbe)의 작성 대상과 명시적 등록 버튼을 참고했다. 함께 검색된 [동명 Threads 협업 앱의 편집기](https://mobbin.com/screens/f5b56f8d-b3b7-45b9-b008-8e6eb896c653)는 보조 도구 분리만, [동명 앱의 메시지 화면](https://mobbin.com/screens/42fe0f0a-3763-4d69-8165-23071cccc634)은 입력창 배치만 비교했다. 세 화면 모두를 Instagram Threads 댓글 사례로 취급하지 않았다.

댓글 본문은 15px, 작성자 13px로 구분하고 불필요하게 겹친 구분선을 제거했다. 답글 대상의 아바타·답글 버튼 상태를 함께 강조한다. 등록 가능한 상태는 무채색 채움 버튼, 실패는 명시적 재시도로 구분한다. 전송 중 잠금·초안 보존·직접 재시도·기능별 학습 첨부는 유지한다.

후속 검증: 320/390px에서 토글 Space/Enter/클릭, 미리보기, 설정 취소·적용, 초안 복원, 카드 첨부 답글, 실패 후 직접 재시도 확인. 검증 중 발견한 재시도 안내·버튼의 용어 불일치도 수정 후 재확인했다. 최종 테스트·타입 검사·빌드 통과. 빌드 중 3000번 HTTP 응답104회 모두200. 실제3000 탭은 빈 초안을 확인한 뒤 최신 빌드로 갱신했다.

## 검증

- 프런트엔드 236개 테스트, TypeScript 검사, 정적 빌드 통과.
- 신규 댓글 API 격리 DB 테스트 4개와 커뮤니티 회귀 12개 통과.
- 실제 브라우저 320/390px에서 설정·첨부·초안 복원·게시, 댓글 작성/답글/공감/수정/삭제/실패 재시도, DM 카드 첨부 전송 확인.
- 3000 서버는 최신 프런트엔드와 migration11을 반영한 독립 프로세스로 유지. 최종 빌드 중 HTTP 응답 102회 모두200.
- 브라우저의 작은 뷰포트로 확인했으며 실제 iOS/Android 소프트웨어 키보드·스크린리더 검증은 별도 범위다.
