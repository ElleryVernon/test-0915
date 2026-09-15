// Package demo creates the sample accounts the PoC's "체험" sign-in uses. The rows match
// prisma/seed.ts so the demo experience is unchanged; an advisory lock makes concurrent first
// sign-ins safe and a second run changes nothing.
package demo

import (
	"context"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"memoryz/server/internal/db"
	"memoryz/server/internal/ids"
)

// Sample account ids.
const (
	Student = "demo-student"
	Parent  = "demo-parent"
	Admin   = "demo-admin"
)

// lockID matches the previous server's advisory lock so both never seed at once.
const lockID = 636362910

var seoul = mustLocation("Asia/Seoul")

func mustLocation(name string) *time.Location {
	loc, err := time.LoadLocation(name)
	if err != nil {
		panic("demo: " + err.Error())
	}
	return loc
}

// Today is the Seoul calendar date, the same representation as Schedule.date.
func Today(now time.Time) string { return now.In(seoul).Format("2006-01-02") }

// Seed inserts the sample data unless the demo student already exists.
func Seed(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	return db.Tx(ctx, pool, func(tx pgx.Tx) error {
		// jitter: none — once seeded the lock covers one EXISTS query; waiters queue and nothing retries on a timer [site server/internal/demo/seed.go:44]
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockID); err != nil {
			return err
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM "User" WHERE "id" = $1)`, Student).Scan(&exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		b := &pgx.Batch{}
		for _, u := range users {
			b.Queue(`INSERT INTO "User" ("id", "name", "nickname", "role", "school", "grade", "streak", "points", "selectedChildId", "completedSubjects")
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, u.id, u.name, u.nickname, u.role, u.school, u.grade, u.streak, u.points, u.selectedChild, u.completed)
		}
		b.Queue(`INSERT INTO "ParentLink" ("parentId", "studentId") VALUES ($1, $2)`, Parent, Student)
		for _, name := range schools {
			b.Queue(`INSERT INTO "School" ("id", "name") VALUES ($1, $2) ON CONFLICT ("name") DO NOTHING`, ids.New(), name)
		}
		for _, s := range subjects {
			b.Queue(`INSERT INTO "Subject" ("id", "userId", "name", "icon", "color") VALUES ($1, $2, $3, $4, $5)`, s.id, Student, s.name, s.icon, s.color)
		}
		for _, m := range materials {
			b.Queue(`INSERT INTO "Material" ("id", "userId", "subjectId", "title", "content", "type", "contentHash", "excerpt")
				VALUES ($1, $2, $3, $4, $5, 'TXT', encode(sha256(convert_to($5, 'UTF8')), 'hex'), left(btrim(regexp_replace($5, '\s+', ' ', 'g')), 160))`, m.id, Student, m.subjectID, m.title, m.content)
		}
		for _, q := range questions {
			b.Queue(`INSERT INTO "Question" ("id", "userId", "subjectId", "materialId", "prompt", "options", "answer", "explanation", "citation", "past", "future")
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, q.id, Student, q.subjectID, q.materialID, q.prompt, q.options, q.answer, q.explanation, q.citation, q.past, q.future)
		}
		for _, e := range essays {
			b.Queue(`INSERT INTO "Essay" ("id", "userId", "subjectId", "materialId", "prompt", "keywords", "distractors", "modelAnswer", "citation")
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, e.id, Student, e.subjectID, e.materialID, e.prompt, e.keywords, e.distractors, e.modelAnswer, e.citation)
		}
		buckets := []string{"AGAIN", "HARD", "GOOD", "EASY", "MASTERED"}
		for i, c := range cards {
			consecutive := 0
			switch i % 5 {
			case 4:
				consecutive = 2
			case 3:
				consecutive = 1
			}
			b.Queue(`INSERT INTO "Card" ("id", "userId", "subjectId", "front", "back", "type", "bucket", "consecutiveEasy", "nextReviewAt")
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, "demo-card"+strconv.Itoa(i+1), Student, c.subjectID, c.front, c.back, c.kind, buckets[i%5], consecutive, now.Add(-time.Minute))
		}
		today := Today(now)
		for _, s := range schedules {
			b.Queue(`INSERT INTO "Schedule" ("id", "userId", "title", "date", "start", "end", "kind", "subjectId") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
				ids.New(), Student, s.title, today, s.start, s.end, s.kind, s.subjectID)
		}
		for _, p := range posts {
			b.Queue(`INSERT INTO "Post" ("id", "userId", "role", "category", "title", "body", "anonymous") VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				p.id, p.userID, p.role, p.category, p.title, p.body, p.anonymous)
		}
		b.Queue(`INSERT INTO "Comment" ("id", "postId", "userId", "body") VALUES ($1, 'demo-post1', 'demo-peer-2', $2)`, ids.New(), "한 문장부터 시작한다는 게 좋네요. 오늘 바로 해볼게요!")
		b.Queue(`INSERT INTO "Cheer" ("id", "senderId", "recipientId", "message", "points") VALUES ($1, $2, $3, $4, 100)`, ids.New(), Parent, Student, "오늘도 너의 속도로 한 걸음. 엄마가 늘 응원해 🧡")
		b.Queue(`INSERT INTO "Notification" ("id", "userId", "title", "body", "href") VALUES ($1, $2, $3, $4, '/flashcards')`, ids.New(), Student, "오늘의 기억을 오래오래", "복습할 카드가 기다리고 있어요. 5분이면 충분해요.")
		results := tx.SendBatch(ctx, b)
		for i := 0; i < b.Len(); i++ {
			if _, err := results.Exec(); err != nil {
				_ = results.Close()
				return err
			}
		}
		return results.Close()
	})
}

type user struct {
	id, name, nickname, role, school, grade string
	streak, points                          int
	selectedChild                           *string
	completed                               []string
}

func ptr(s string) *string { return &s }

var users = []user{
	{id: Student, name: "김지우", nickname: "지우", role: "STUDENT", school: "서울고등학교", grade: "고2", streak: 7, points: 1200, completed: []string{"통합과학", "통합사회", "공통수학"}},
	{id: Parent, name: "김수현", nickname: "지우맘", role: "PARENT", points: 5000, selectedChild: ptr(Student), completed: []string{}},
	{id: Admin, name: "메모리즈 관리자", nickname: "메모리즈 운영팀", role: "ADMIN", completed: []string{}},
	{id: "demo-peer-1", name: "이서연", nickname: "서연의공부일기", role: "STUDENT", school: "서울고등학교", grade: "고2", completed: []string{}},
	{id: "demo-peer-2", name: "박도윤", nickname: "수학하는도윤", role: "STUDENT", school: "한빛고등학교", grade: "고2", completed: []string{}},
	{id: "demo-peer-parent", name: "박현정", nickname: "함께걷는엄마", role: "PARENT", completed: []string{}},
}

var schools = []string{"서울고등학교", "한빛고등학교", "경기고등학교", "경복고등학교", "숙명여자고등학교"}

var subjects = []struct{ id, name, icon, color string }{
	{"demo-biology", "생명과학Ⅰ", "leaf", "green"},
	{"demo-math", "수학Ⅱ", "calculator", "blue"},
	{"demo-history", "한국사", "landmark", "purple"},
	{"demo-english", "영어", "languages", "yellow"},
}

var materials = []struct{ id, subjectID, title, content string }{
	{"demo-neuron", "demo-biology", "3. 항상성과 몸의 조절", "뉴런은 자극을 받아 다른 세포로 흥분을 전달하는 신경계의 구조적·기능적 단위이다. 휴지 전위 상태에서 뉴런 세포막 안쪽은 바깥쪽에 비해 상대적으로 음전하를 띤다. 역치 이상의 자극이 가해지면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 이후 칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다. 말이집 신경에서는 랑비에 결절에서 활동 전위가 발생하는 도약 전도가 일어나 흥분이 빠르게 전달된다. 시냅스에서는 신경 전달 물질이 시냅스 틈으로 분비되어 다음 뉴런에 신호를 전달한다."},
	{"demo-hormone", "demo-biology", "4. 호르몬과 항상성", "항상성은 외부 환경이 변해도 몸의 내부 환경을 일정하게 유지하는 성질이다. 혈당량이 증가하면 이자에서 인슐린의 분비가 증가하고 세포의 포도당 흡수와 간의 글리코젠 합성이 촉진된다. 혈당량이 감소하면 글루카곤의 분비가 증가하고 간에서 글리코젠이 포도당으로 분해된다. 인슐린과 글루카곤은 길항 작용을 통해 혈당량을 일정하게 조절한다."},
	{"demo-derivative", "demo-math", "미분계수와 도함수", "함수 f(x)의 x=a에서의 미분계수는 평균변화율의 극한값으로 정의한다. 미분계수는 곡선 y=f(x) 위의 점 (a, f(a))에서 그은 접선의 기울기와 같다. 함수 f(x)=x²의 도함수는 f′(x)=2x이다. 함수가 x=a에서 미분 가능하면 그 점에서 연속이다. 연속인 함수가 반드시 미분 가능한 것은 아니다."},
	{"demo-goryeo", "demo-history", "고려의 통치 체제 정비", "고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다. 광종은 과거제를 실시하여 유교적 소양을 갖춘 인재를 관리로 선발하였다. 성종은 최승로의 시무 28조를 수용하여 유교 정치 이념을 통치에 반영하였다. 성종은 전국에 12목을 설치하고 지방관을 파견하였다."},
}

type question struct {
	id, subjectID, materialID, prompt   string
	options                             []string
	answer                              int
	explanation, citation, past, future string
}

var questions = []question{
	{"demo-q1", "demo-biology", "demo-neuron", "뉴런에서 탈분극이 일어날 때 나타나는 현상으로 옳은 것은?", []string{"칼륨 이온이 세포 안으로 유입된다.", "나트륨 이온이 세포 안으로 유입된다.", "나트륨 이온이 세포 밖으로 이동한다.", "세포막 안쪽이 더 음전하를 띤다.", "신경 전달 물질이 분해된다."}, 1, "역치 이상의 자극을 받으면 나트륨 이온 통로가 열립니다. 나트륨 이온이 세포 안으로 들어오면서 막전위가 상승하는 현상이 탈분극입니다.", "역치 이상의 자극이 가해지면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.", "통합과학 · 세포막의 선택적 투과성", "생명과학Ⅱ · 이온 통로와 막전위"},
	{"demo-q2", "demo-biology", "demo-neuron", "말이집 신경에서 흥분 전도 속도가 빠른 이유는?", []string{"모든 구간에서 신경 전달 물질이 분비되기 때문에", "말이집에서만 이온이 이동하기 때문에", "랑비에 결절 사이에 도약 전도가 일어나기 때문에", "축삭 돌기가 짧아지기 때문에", "활동 전위의 크기가 점차 커지기 때문에"}, 2, "말이집은 축삭을 절연합니다. 활동 전위가 랑비에 결절에서 발생하여 흥분이 결절 사이를 건너뛰는 방식으로 빠르게 전달됩니다.", "말이집 신경에서는 랑비에 결절에서 활동 전위가 발생하는 도약 전도가 일어나 흥분이 빠르게 전달된다.", "생명과학Ⅰ · 뉴런의 구조", "생명과학Ⅱ · 신호 전달"},
	{"demo-q3", "demo-biology", "demo-hormone", "식사 후 혈당량이 높아졌을 때 일어나는 반응은?", []string{"글루카곤 분비 증가", "글리코젠 분해 촉진", "인슐린 분비 감소", "세포의 포도당 흡수 촉진", "간의 글리코젠 합성 억제"}, 3, "혈당량이 증가하면 인슐린이 분비되어 포도당의 세포 내 흡수와 글리코젠 합성을 촉진합니다.", "혈당량이 증가하면 이자에서 인슐린의 분비가 증가하고 세포의 포도당 흡수와 간의 글리코젠 합성이 촉진된다.", "통합과학 · 생명 시스템", "생명과학Ⅱ · 세포 호흡"},
	{"demo-q4", "demo-math", "demo-derivative", "함수 f(x)=x²의 x=3에서의 미분계수는?", []string{"2", "3", "6", "9", "12"}, 2, "f′(x)=2x이므로 x=3을 대입하면 f′(3)=6입니다.", "함수 f(x)=x²의 도함수는 f′(x)=2x이다.", "수학Ⅰ · 함수", "미적분 · 도함수의 활용"},
	{"demo-q5", "demo-history", "demo-goryeo", "고려 광종의 정책으로 옳은 것은?", []string{"전국에 12목 설치", "노비안검법과 과거제 실시", "시무 28조 수용", "훈민정음 창제", "대동법 전국 확대"}, 1, "광종은 노비안검법으로 호족의 경제적·군사적 기반을 약화하고 과거제로 새로운 인재를 등용했습니다.", "고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다.", "한국사 · 고려 건국", "한국사 · 중앙 집권 강화"},
}

type essay struct {
	id, subjectID, materialID, prompt string
	keywords, distractors             []string
	modelAnswer, citation             string
}

var essays = []essay{
	{"demo-essay1", "demo-biology", "demo-neuron", "역치 이상의 자극을 받은 뉴런에서 탈분극이 일어나는 과정을 설명해 보세요.", []string{"자극", "나트륨 이온 통로", "유입", "탈분극"}, []string{"광합성", "항체", "글루카곤", "글리코젠"}, "역치 이상의 자극을 받으면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입된다. 그 결과 세포막 안쪽의 전위가 상승하여 탈분극이 일어난다.", questions[0].citation},
	{"demo-essay2", "demo-biology", "demo-hormone", "식사 후 혈당량이 증가했을 때 항상성이 유지되는 과정을 설명해 보세요.", []string{"혈당량", "인슐린", "포도당 흡수", "글리코젠 합성"}, []string{"글루카곤 증가", "체온 상승", "항원", "혈액 응고"}, "혈당량이 증가하면 이자에서 인슐린의 분비가 증가한다. 인슐린은 세포의 포도당 흡수와 간에서의 글리코젠 합성을 촉진하여 혈당량을 낮추고 항상성을 유지한다.", questions[2].citation},
}

var cards = []struct{ front, back, kind, subjectID string }{
	{"뉴런이란?", "자극을 받아 다른 세포로 흥분을 전달하는 신경계의 구조적·기능적 단위", "CONCEPT", "demo-biology"},
	{"탈분극은 어떻게 일어날까?", "역치 이상의 자극 → 나트륨 이온 통로 열림 → Na⁺ 유입 → 막전위 상승", "RELATION", "demo-biology"},
	{"탈분극과 재분극의 차이는?", "탈분극: Na⁺가 안으로 유입되어 막전위 상승. 재분극: K⁺가 밖으로 유출되어 막전위 하강.", "COMPARISON", "demo-biology"},
	{"도약 전도란?", "말이집 신경에서 랑비에 결절 사이를 건너뛰며 빠르게 흥분을 전달하는 현상", "CONCEPT", "demo-biology"},
	{"인슐린의 역할은?", "세포의 포도당 흡수와 간의 글리코젠 합성을 촉진하여 혈당량을 낮춘다.", "RELATION", "demo-biology"},
	{"인슐린과 글루카곤의 공통점과 차이점", "둘 다 이자에서 분비되는 혈당 조절 호르몬. 인슐린은 혈당을 낮추고 글루카곤은 높인다.", "COMPARISON", "demo-biology"},
	{"미분계수의 기하학적 의미는?", "곡선 위 한 점에서 그은 접선의 기울기", "CONCEPT", "demo-math"},
	{"f(x)=x²의 도함수는?", "f′(x)=2x", "CONCEPT", "demo-math"},
	{"미분 가능하면 반드시 연속일까?", "미분 가능하면 연속이다. 역은 성립하지 않는다.", "RELATION", "demo-math"},
	{"노비안검법을 실시한 왕은?", "고려 광종", "CONCEPT", "demo-history"},
	{"시무 28조를 수용한 왕은?", "고려 성종. 최승로의 건의를 수용하여 유교 통치 이념을 반영했다.", "CONCEPT", "demo-history"},
	{"광종과 성종의 정책 비교", "광종: 노비안검법·과거제. 성종: 시무 28조 수용·12목 설치.", "COMPARISON", "demo-history"},
}

var schedules = []struct {
	title, start, end, kind string
	subjectID               *string
}{
	{"학교 수업", "08:30", "16:00", "FIXED", nil},
	{"수학 학원", "18:00", "19:30", "FIXED", ptr("demo-math")},
	{"생명과학 개념 복습", "20:00", "20:40", "FLEXIBLE", ptr("demo-biology")},
}

var posts = []struct {
	id, userID, role, category, title, body string
	anonymous                               bool
}{
	{"demo-post1", "demo-peer-1", "STUDENT", "공부 팁", "아는 것 같은데 설명은 안 되는 사람 🙋", "저도 딱 그랬는데 서술형으로 설명하는 연습을 시작하고 많이 달라졌어요. 개념을 외운 다음 책을 덮고 한 문장만 써보세요. 막히는 부분이 진짜 복습할 부분이더라고요.", false},
	{"demo-post2", "demo-peer-2", "STUDENT", "자유", "오늘도 25분만 집중해 보자", "시험까지 얼마 안 남아서 마음만 급했는데 타이머를 켜고 딱 한 단원부터 시작했어요. 다들 오늘의 작은 목표가 뭔가요?", false},
	{"demo-post3", "demo-peer-1", "STUDENT", "수시", "생명과학 탐구 주제 같이 이야기해요", "항상성과 호르몬 단원을 공부하다가 생활 속 혈당 조절에 관심이 생겼어요. 교과 개념에서 출발해서 자료를 찾아보는 중이에요.", true},
	{"demo-parent-post", "demo-peer-parent", "PARENT", "자유", "성적보다 꾸준함을 먼저 봐주려고요", "아이가 스스로 정한 공부 시간을 지켰다는 사실을 먼저 칭찬해 줬어요. 작은 습관을 응원하는 것도 부모의 역할인 것 같아요.", false},
}
