# DM 디테일 참고 — 2026-09-17
Mobbin 실제 화면을 열어 확인했다.
- https://mobbin.com/screens/fafb59d5-9aa6-4c27-8ead-ddd7098eb85b — Instagram inbox: 상대 이름, 한 줄 미리보기, 작은 시간, 읽지 않음 강조. 우리 서비스는 수신 미확인 수와 발신 상태도 구분.
- https://mobbin.com/screens/674b1826-5513-4f83-ad23-89b4454e2129 — Instagram conversation: 메시지 아래 작은 Seen, 한 줄 입력창, 첨부 액션. 서버 응답 이후만 보냄, 실제 수신자 화면 확인 이후만 읽음.
- https://mobbin.com/screens/6d31c75e-4c65-4f1d-9937-5f9e9a2e8a46 — 첫 대화: 상대 프로필 중심의 맥락, 절제된 타임스탬프, 내용에 집중하는 말풍선.
- https://mobbin.com/screens/7d276c82-caa4-4b53-b442-e03657240fd4 — 발신/수신 말풍선의 표면 차이. 테마 색상은 복사하지 않고 Memoryz 그레이스케일과 보더리스 기조 유지.

범위: 메시지 상태, 읽음 경계, 실패·재시도, unread 시작점, inbox와 composer, 접근 가능한 메시지 액션. 온라인 상태·입력 중 표시는 서버 근거가 없어 추가하지 않음. 현재 2.5초 활성 대화 / 8초 목록 폴링 유지, 창 복귀 시 즉시 갱신.

메시지 조작 패턴 재검토:
- https://mobbin.com/screens/e7f3d9c5-c954-42b6-8153-fb8d2adb4c6f — Messenger의 길게 누른 메시지와 인접 반응 UI를 실제 확인. 대화 문맥을 유지하며 액션을 드러내는 원칙 적용.
- https://mobbin.com/screens/bb5378a8-553e-4d6e-a114-613f2c6dfb84 — Instagram 알림 행의 인접 컨텍스트 메뉴. 메시지 DM 자체의 화면은 아니므로 동일 구현이라고 주장하지 않음.
- https://mobbin.com/screens/d964e8bf-7532-4feb-b1c7-0790c179a5bf — Instagram 채널의 인접 메뉴. 작은 액션은 전체 화면 시트로 전환하지 않는 원칙.

수정: 메시지 더보기의 바텀시트와 전송 취소 바텀시트를 제거했다. 해당 메시지 옆 팝오버에 좋아요/답장/복사/보내기 취소를 배치하고 상태 클릭은 읽음/보낸 시간만 표시한다. 모바일 450ms 길게 누르기(10px 이동 시 취소), 우클릭, Shift+F10, 명시적 더보기 버튼을 모두 지원한다. 첨부 자료 편집은 콘텐츠 작업이므로 기존 시트 유지.
