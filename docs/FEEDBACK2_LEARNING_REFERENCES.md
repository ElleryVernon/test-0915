# 피드백 2 — 학습 후속 행동과 개념 연결

2026-09-18 Mobbin MCP에서 아래 7개 화면의 실제 이미지를 확인했다. 네 개 행동의 문구는 사용자 요청을 따르고, 다른 앱의 장식보다 결과→다시 학습 흐름을 채택했다.

| 화면 | 참고한 점 | 적용 / 제외 |
|---|---|---|
| [Babbel](https://mobbin.com/screens/00c43458-c5b4-4e0f-9223-f5a933ccc59e) | 정오답 그룹과 마무리 행동 분리 | 결과 요약과 후속 행동 분리 |
| [Speechify](https://mobbin.com/screens/9ca89885-f158-450c-a687-503bd97bdb8d) | Finish와 Generate New의 우선순위 | 다른 문제 생성은 독립 행동, 자동 생성하지 않음 |
| [Crypto.com](https://mobbin.com/screens/1c57b956-5cc1-4478-8ade-3e0eb835cff7) | 문제별 결과 접기 | 전체 결과에서 대상으로 삼을 문제를 명시 |
| [ChatGPT](https://mobbin.com/screens/b8a33273-2ac1-4d6f-b901-0e27d77cbc0e) | 이유와 다음 학습 선택 연결 | 문맥 유지. 긴 채팅 형태는 제외 |
| [Coursera](https://mobbin.com/screens/3c98d923-55ce-45a4-b972-b1ef6d3104e1) | Try Again과 View Details 구분 | 틀린 문제 재시도와 4개 보완 행동 구분 |
| [Vocabulary](https://mobbin.com/screens/09632393-abdf-4476-88d9-52fabb059b70) | 결과에서 컬렉션에 저장 | 해당 문제를 중복 없이 오늘 카드로 연결 |
| [Quizlet](https://mobbin.com/screens/609a3ede-102a-42c0-bf90-c216edda5713) | 정오답과 다음 진행 연결 | 답안을 판단한 뒤 행동 제공 |

## 구현 계약
- 문제 해설·오답노트·전체 결과에 플래시카드 / 서술형 도우미 / 비슷한 문제 / 커뮤니티 질문.
- 서술형·비슷한 문제는 같은 자료와 해당 문제 주제를 넘긴다. 자료가 삭제되거나 본문이 부족하면 이유와 함께 비활성화한다.
- 플래시카드는 같은 TEXT 출처 문제 카드 재사용. 삭제 상태 복원, AGAIN, 현재 시각 이전 예약. 학습 이력과 FSRS를 조작하지 않는다.
- 전체 결과에서는 어느 문제로 후속 학습할지 선택한다. 커뮤니티는 작성기를 열며 자동 게시하지 않는다.
- 폴더 선택은 브라우저 뒤로가기와 일치. 새 풀이 세션은 새 ID, 삭제·변경된 문제는 세션을 통째로 무효화해 결과가 다른 문제에 붙지 않도록 한다.

## 교육과정 근거
[교육부 고시 제2022-33호](https://www.moe.go.kr/boardCnts/viewRenew.do?boardID=141&boardSeq=93458&lev=0&m=0404&opType=N&s=moe&statusYN=W)의 HWP 원문에서 고등학교 성취기준 텍스트 부분집합 1,486개/109과목을 수집했다. 원문 링크, 문서명, 단락, 파일 해시, 고시일과 추출일을 보존한다. 수식 객체가 빠지는 13개 단일 기준은 추측하지 않고 제외한다. 제외 목록의 나머지는 해설 범위·복수·오타 코드이며 성취기준 수로 세지 않는다.

[경남교육청 적용 일정](https://www.gne.go.kr/user/bbs/BD_selectBbs.do?q_bbsDocNo=1773018&q_bbsSn=1238), [경기도교육청 교육과정 Q&A](https://www.goe.go.kr/goe/na/ntt/selectNttInfo.do?mi=10961&nttSn=1051964), [인천교육청 과목 안내서](https://www.ice.go.kr/ice/na/ntt/selectNttInfo.do?bbsId=1671&mi=11634&nttSn=3327138), [NCIC 자료 구분](https://ncic.re.kr/search.cs?query=2022), [경기도교육청 통합과학 자료](https://www.goe.go.kr/resource/old/BBSMSTR_000000000126/BBS_202402261130401580.pdf)도 교차 확인했다.

이 데이터는 2022 원고의 별책 5–14 일부이며 최신 정정 전체·2015·대학교 교육과정을 포괄하지 않는다. 2026 고3은2015, 대학/학년미상은 자동연결하지 않는다. 정확한 과목명+복수어휘 일치를 통과한 목표만 최대3개 표시한다. 의미검색 정확도나 모든 문장의 독립 이중 검수를 보장하지 않는다.

배운 과목과 성취기준은 생성 프롬프트의 별도 학습 배경으로 제공하며 원문 인용 근거에 합치지 않는다. 파인튜닝/학습 완료라고 표현하지 않는다. 과목별 기록은 사용자의 자기 보고이며 숙달 판정이 아니다.
