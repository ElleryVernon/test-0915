# AI 실행 설계

문항 생성·서술형 채점·일정 제안은 서버의 제한된 학습 도구를 거칩니다. 이미지 글자 추출도 같은 스킬 정의와 출력 검증을 사용합니다. 제공한 학습 자료는 데이터로 취급하며 자료 안의 명령을 실행하지 않습니다.

## 공급자와 스킬

OpenRouter의 `openai/gpt-5.6-luna`, reasoning `high`를 호출합니다. 공급자는 `openai/fast`를 먼저 쓰고, 실패하면 `amazon-bedrock/us-east-1`로만 넘깁니다(`provider.order`, `allow_fallbacks: false`; 2026-09-15 측정으로 순서를 바꿨습니다 — docs/SERVER.md AI 절). 다른 공급자로는 넘기지 않습니다. `OPENROUTER_PROVIDER_ORDER`로 순서를 바꿀 수 있습니다. Bedrock 엔드포인트는 `response_format`을 지원하지 않습니다. 그래서 JSON Schema를 강제 함수 호출(`tools` + `tool_choice`, `strict: true`)로 전달하고, `require_parameters: true`로 이를 지원하지 않는 경로를 막습니다. 비밀키는 서버 환경 변수에만 저장합니다. 함수 호출 스키마, 응답 시간 제한, 길이 제한, 원문 직접 인용·선택지·채점·시간표 검증을 통과한 결과만 사용합니다. 숨겨진 추론은 요청에서 제외하고 저장하지 않습니다.

일정 제안은 규칙에 어긋나는 블록(25–60분 밖, 기존 일정과 겹침, 휴식 10분 미만, 지난 시간, 없는 과목, 하루 4시간·4개 초과)만 버리고 나머지를 사용합니다. 한 안이 비면 같은 의도의 규칙 기반 안으로 채우고, 응답의 `method`(`AI` / `AI+규칙` / `규칙 기반 일정 추천`)와 `dropped`로 출처를 밝힙니다.

`server/internal/ai/skills.go`의 여섯 스킬은 quiz / essay / cards / grade / planner / ocr이며 각각 버전 1.0.0입니다. 저장되는 AI 작업은 LOAD_CONTEXT → GENERATE → VALIDATE → COMMIT의 허용된 순서를 따릅니다. 단독 OCR은 입력·생성·출력 검증을 거쳐 업로드 흐름으로 반환됩니다. 입력은 핸들러의 검증기로, 모델 출력은 Go 검증기(`server/internal/ai/tasks.go` 의 parseItems, `server/internal/planner` 의 ValidateAiGrade·ValidateAiPlans)로 확인하고, 자료와 기존 일정의 소유권을 확인한 뒤 생성합니다. 문항·서술형·카드는 모드별 프롬프트로 만들고, 형식 누출·중복·근거 없음으로 거부되면 거부 사유를 붙여 한 번만 다시 만듭니다(핸들러 시한이 60초 이상 남았을 때만). 모델에는 셸이나 임의 SQL 실행 권한이 없습니다.

- 문항: 5개 선택지, 올바른 정답 인덱스, 중복 선택지 방지, 원문에 실제 존재하는 인용.
- 서술형: 핵심 개념 60점·인과 논리 25점·설명 완결성 15점. 동의어와 정확한 바꾸어 쓰기를 인정하고 맞춘/빠진 개념의 분할을 검증.
- 일정: 고정 일정과 충돌 금지, 25–60분 블록, 최소 10분 휴식, 하루 추가 학습 4시간 이하.
- OCR: 실제 글자만 순서대로 추출. 이미지 속 지시를 실행하거나 읽히지 않는 내용을 만들어내지 않음.

### 판정 모델 (Jev)

생성기 옆에서 **판정만** 하는 두 번째 모델을 둘 수 있습니다(`server/internal/ai/jev.go`, TypeSafe System One `jev-latest`). 텍스트를 만들지 않고 키워드 상태·답안 유형·지시 삽입 확률·정답 보기·근거 판정 같은 확률과 선택지만 돌려주며, 한 요청은 약 0.3초·수천 입력 토큰입니다. 설정은 `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`, `AI_JUDGE`이며 `AI_JUDGE=off`(기본)이면 어떤 경로도 바뀌지 않습니다.

- 서술형 채점(`GradeWithAI`): 판정 요청을 생성기 호출과 병렬로 보냅니다. 검증된 채점의 키워드 explained 여부·답안 유형이 판정과 일치하고 판정 confidence가 0.6 이상이며 지시 삽입 판정과 모순이 없으면, `AI_JUDGE=on`에서는 별도 검수 호출(`memoryz_essay_grade_review`)을 생략합니다. `shadow`는 일치 여부만 기록합니다(`AiRun` retries의 `judge` 항목). 판정 실패·시간 초과·긴 원문은 "판정 없음"으로 취급되어 기존 검수 경로가 그대로 실행됩니다.
- 생성 검수(`reviewItems`): 객관식은 원문만으로 보기를 고르게 하고 정답 키와 비교하며, 서술형은 키워드는 원문이 뒷받침하고 방해어는 뒷받침하지 않는지 판정합니다. `on`에서 판정이 거절한 항목은 모델 검수 없이 바로 생성기로 돌려보내고, 모두 0.8 이상으로 통과하면 모델의 독립 풀이 호출을 생략합니다. 의미 검수(`memoryz_learning_quality`)는 항상 그대로 실행됩니다.
- 빠른 판정 화면: `POST /api/essay/judge`는 소유한 서술형에 대한 판정(matched/missing·임시 점수·유형)을 돌려주고, 부트스트랩의 `judgeAvailable`이 true일 때 서술형 화면이 채점 요청과 동시에 호출해 코칭이 오기 전까지 핵심 개념 표시를 먼저 보여 줍니다. 학생별 AI 예산을 함께 소모하며 최종 점수는 언제나 채점 결과가 결정합니다.
- 판정 호출도 사용량(`provider=typesafe`, 입력 토큰·비용·시간)으로 기록됩니다. 측정과 비교표는 [TypeSafe Jev 평가](TYPESAFE_JEV_EVALUATION.md)에 있습니다.

## 요청 수명과 복구

브라우저는 유료 생성 요청 전에 사용자별 UUID와 입력을 IndexedDB에 저장합니다. 서버의 `AiRun`은 `(userId, requestId)`를 유일키로 사용하며 입력 해시·스킬 버전·모델·단계별 시간·상태·최종 결과를 PostgreSQL에 보관합니다.

동일 UUID와 동일 입력의 완료 요청은 기존 결과를 반환합니다. 내용이 달라지면 409, 처리 중 중복도 409를 반환합니다. 타인의 실행 기록은 404입니다. 생성 문항·채점 기록과 완료 결과를 같은 트랜잭션에 저장하므로 저장 후 응답이 끊겨도 결과를 조회할 수 있습니다.

화면 재진입은 GET 상태 조회만 합니다. 완료 결과를 적용하고 화면 데이터 갱신까지 성공하면 처리 확인을 기록합니다. 실패·중단 상태를 새 UUID로 다시 요청하는 것은 명시적인 버튼 동작입니다. 일정 적용 도중 끊겼다면 이미 저장된 동일 블록을 건너뛰고 원래 날짜에 이어서 적용합니다.

5분 이상 갱신되지 않은 RUNNING은 다음 조회나 요청 때 INTERRUPTED로 표시합니다. **상태와 완료 결과를 복구하는 구조이며, 서버 프로세스 중단 후 모델 실행 자체를 자동 재개하는 작업 큐는 아닙니다.** 외부 공급자 호출은 175초, AI 핸들러와 이미지 업로드(OCR 포함)는 180초, 브라우저 대기는 190초로 제한합니다. 이미지 업로드/OCR 자체에는 문항 생성과 동일한 AiRun 재실행 방지 계약을 적용하지 않으며, 업로드 후 문항·카드 생성 단계에는 적용합니다. 원본 이미지 재업로드는 별도 요청입니다.

## 참고한 방법

[Pi agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)의 도구 사전 검증·상태 이벤트와 [Pi skills](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)의 목적별 스킬 구분을 참고했습니다. [Vercel WorkflowAgent](https://vercel.com/kb/guide/what-is-workflowagent)의 지속 가능한 실행 기록과 재시도 경계를 검토했습니다. 해당 프레임워크를 복사하거나 설치한 것이 아니라, 학습 서비스에 필요한 제한된 실행과 결과 복구에 적용했습니다.

[OpenRouter reasoning 문서](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)에 따라 추론 강도를 공급자 요청에 전달합니다. 모델 목록에 실제 존재하는 ID와 지원되는 구조화 출력 옵션을 확인했습니다. 실제 공급자 검증과 로컬 가짜 응답을 사용하는 장애 검증의 범위는 VERIFICATION.md에 구분합니다.
