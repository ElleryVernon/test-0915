# 골든 오라클 참조 구현 (동결)

이 디렉터리는 Go 로 옮기기 전의 TypeScript 서버 로직을 **그대로 동결한 사본**이다. 런타임에서는 쓰이지 않고, Go 패키지의 패리티 골든을 만드는 생성기만 가져온다.

| 파일 | 쓰는 곳 | Go 대응 |
| --- | --- | --- |
| algorithms.ts, ai.ts, errors.ts, provider.ts, skill-runtime.ts, skills.ts | server/internal/planner/testdata/gen.ts | internal/planner, internal/textmatch, internal/ai |
| pdf-extract.ts | server/internal/pdfx/testdata/ts-text.ts, tests/pdf-extract.test.ts | internal/pdfx |

SRS 골든(server/internal/srs/testdata/gen.ts)은 클라이언트와 공유하는 src/lib/srs.ts 를 그대로 쓴다.

바꾸지 않는다: 여기 파일을 고치면 골든이 바뀌고 패리티의 의미가 사라진다. Go 쪽 동작을 바꾸려면 골든 케이스를 늘리거나 Go 테스트에 별도 기대를 두라. 원본은 git 이력(src/lib/server/**, 2026-09-15 이전)에 있다.
