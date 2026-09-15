import 'dotenv/config';
import { db } from '../scripts/lib/db';

export const DEMO_STUDENT = 'demo-student';
export const DEMO_PARENT = 'demo-parent';
export const DEMO_ADMIN = 'demo-admin';
export async function seedDemo() {
  if (process.env.DEMO_MODE !== 'true') throw new Error('Demo seeding requires DEMO_MODE=true');
  await db.$transaction(async tx => {
    // An advisory lock makes concurrent first demo sessions safe without resetting existing work.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(636362910)`;
    if (await tx.user.findUnique({where:{id:DEMO_STUDENT}})) return;
    await tx.user.createMany({data:[
      {id:DEMO_STUDENT,name:'김지우',nickname:'지우',role:'STUDENT',school:'서울고등학교',grade:'고2',streak:7,points:1200,completedSubjects:['통합과학','통합사회','공통수학']},
      {id:DEMO_PARENT,name:'김수현',nickname:'지우맘',role:'PARENT',points:5000,selectedChildId:DEMO_STUDENT},
      {id:DEMO_ADMIN,name:'메모리즈 관리자',nickname:'메모리즈 운영팀',role:'ADMIN'},
      {id:'demo-peer-1',name:'이서연',nickname:'서연의공부일기',role:'STUDENT',school:'서울고등학교',grade:'고2'},
      {id:'demo-peer-2',name:'박도윤',nickname:'수학하는도윤',role:'STUDENT',school:'한빛고등학교',grade:'고2'},
      {id:'demo-peer-parent',name:'박현정',nickname:'함께걷는엄마',role:'PARENT'},
    ]});
    await tx.parentLink.create({data:{parentId:DEMO_PARENT,studentId:DEMO_STUDENT}});
    await tx.school.createMany({data:['서울고등학교','한빛고등학교','경기고등학교','경복고등학교','숙명여자고등학교'].map(name=>({name})),skipDuplicates:true});
    const subjects = [
      {id:'demo-biology',name:'생명과학Ⅰ',icon:'leaf',color:'green'},
      {id:'demo-math',name:'수학Ⅱ',icon:'calculator',color:'blue'},
      {id:'demo-history',name:'한국사',icon:'landmark',color:'purple'},
      {id:'demo-english',name:'영어',icon:'languages',color:'yellow'},
    ];
    await tx.subject.createMany({data:subjects.map(subject=>({...subject,userId:DEMO_STUDENT}))});
    const materials = [
      {id:'demo-neuron',subjectId:'demo-biology',title:'3. 항상성과 몸의 조절',content:'뉴런은 자극을 받아 다른 세포로 흥분을 전달하는 신경계의 구조적·기능적 단위이다. 휴지 전위 상태에서 뉴런 세포막 안쪽은 바깥쪽에 비해 상대적으로 음전하를 띤다. 역치 이상의 자극이 가해지면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 이후 칼륨 이온이 세포 밖으로 이동하여 재분극이 일어난다. 말이집 신경에서는 랑비에 결절에서 활동 전위가 발생하는 도약 전도가 일어나 흥분이 빠르게 전달된다. 시냅스에서는 신경 전달 물질이 시냅스 틈으로 분비되어 다음 뉴런에 신호를 전달한다.'},
      {id:'demo-hormone',subjectId:'demo-biology',title:'4. 호르몬과 항상성',content:'항상성은 외부 환경이 변해도 몸의 내부 환경을 일정하게 유지하는 성질이다. 혈당량이 증가하면 이자에서 인슐린의 분비가 증가하고 세포의 포도당 흡수와 간의 글리코젠 합성이 촉진된다. 혈당량이 감소하면 글루카곤의 분비가 증가하고 간에서 글리코젠이 포도당으로 분해된다. 인슐린과 글루카곤은 길항 작용을 통해 혈당량을 일정하게 조절한다.'},
      {id:'demo-derivative',subjectId:'demo-math',title:'미분계수와 도함수',content:'함수 f(x)의 x=a에서의 미분계수는 평균변화율의 극한값으로 정의한다. 미분계수는 곡선 y=f(x) 위의 점 (a, f(a))에서 그은 접선의 기울기와 같다. 함수 f(x)=x²의 도함수는 f′(x)=2x이다. 함수가 x=a에서 미분 가능하면 그 점에서 연속이다. 연속인 함수가 반드시 미분 가능한 것은 아니다.'},
      {id:'demo-goryeo',subjectId:'demo-history',title:'고려의 통치 체제 정비',content:'고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다. 광종은 과거제를 실시하여 유교적 소양을 갖춘 인재를 관리로 선발하였다. 성종은 최승로의 시무 28조를 수용하여 유교 정치 이념을 통치에 반영하였다. 성종은 전국에 12목을 설치하고 지방관을 파견하였다.'},
    ];
    await tx.material.createMany({data:materials.map(material=>({...material,userId:DEMO_STUDENT,type:'TXT'}))});
    const questions = [
      {id:'demo-q1',subjectId:'demo-biology',materialId:'demo-neuron',prompt:'뉴런에서 탈분극이 일어날 때 나타나는 현상으로 옳은 것은?',options:['칼륨 이온이 세포 안으로 유입된다.','나트륨 이온이 세포 안으로 유입된다.','나트륨 이온이 세포 밖으로 이동한다.','세포막 안쪽이 더 음전하를 띤다.','신경 전달 물질이 분해된다.'],answer:1,explanation:'역치 이상의 자극을 받으면 나트륨 이온 통로가 열립니다. 나트륨 이온이 세포 안으로 들어오면서 막전위가 상승하는 현상이 탈분극입니다.',citation:'역치 이상의 자극이 가해지면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.',past:'통합과학 · 세포막의 선택적 투과성',future:'생명과학Ⅱ · 이온 통로와 막전위'},
      {id:'demo-q2',subjectId:'demo-biology',materialId:'demo-neuron',prompt:'말이집 신경에서 흥분 전도 속도가 빠른 이유는?',options:['모든 구간에서 신경 전달 물질이 분비되기 때문에','말이집에서만 이온이 이동하기 때문에','랑비에 결절 사이에 도약 전도가 일어나기 때문에','축삭 돌기가 짧아지기 때문에','활동 전위의 크기가 점차 커지기 때문에'],answer:2,explanation:'말이집은 축삭을 절연합니다. 활동 전위가 랑비에 결절에서 발생하여 흥분이 결절 사이를 건너뛰는 방식으로 빠르게 전달됩니다.',citation:'말이집 신경에서는 랑비에 결절에서 활동 전위가 발생하는 도약 전도가 일어나 흥분이 빠르게 전달된다.',past:'생명과학Ⅰ · 뉴런의 구조',future:'생명과학Ⅱ · 신호 전달'},
      {id:'demo-q3',subjectId:'demo-biology',materialId:'demo-hormone',prompt:'식사 후 혈당량이 높아졌을 때 일어나는 반응은?',options:['글루카곤 분비 증가','글리코젠 분해 촉진','인슐린 분비 감소','세포의 포도당 흡수 촉진','간의 글리코젠 합성 억제'],answer:3,explanation:'혈당량이 증가하면 인슐린이 분비되어 포도당의 세포 내 흡수와 글리코젠 합성을 촉진합니다.',citation:'혈당량이 증가하면 이자에서 인슐린의 분비가 증가하고 세포의 포도당 흡수와 간의 글리코젠 합성이 촉진된다.',past:'통합과학 · 생명 시스템',future:'생명과학Ⅱ · 세포 호흡'},
      {id:'demo-q4',subjectId:'demo-math',materialId:'demo-derivative',prompt:'함수 f(x)=x²의 x=3에서의 미분계수는?',options:['2','3','6','9','12'],answer:2,explanation:'f′(x)=2x이므로 x=3을 대입하면 f′(3)=6입니다.',citation:'함수 f(x)=x²의 도함수는 f′(x)=2x이다.',past:'수학Ⅰ · 함수',future:'미적분 · 도함수의 활용'},
      {id:'demo-q5',subjectId:'demo-history',materialId:'demo-goryeo',prompt:'고려 광종의 정책으로 옳은 것은?',options:['전국에 12목 설치','노비안검법과 과거제 실시','시무 28조 수용','훈민정음 창제','대동법 전국 확대'],answer:1,explanation:'광종은 노비안검법으로 호족의 경제적·군사적 기반을 약화하고 과거제로 새로운 인재를 등용했습니다.',citation:'고려 광종은 노비안검법을 실시하여 불법으로 노비가 된 사람들을 양인으로 해방하였다.',past:'한국사 · 고려 건국',future:'한국사 · 중앙 집권 강화'},
    ];
    await tx.question.createMany({data:questions.map(question=>({...question,userId:DEMO_STUDENT}))});
    await tx.essay.createMany({data:[
      {id:'demo-essay1',userId:DEMO_STUDENT,subjectId:'demo-biology',materialId:'demo-neuron',prompt:'역치 이상의 자극을 받은 뉴런에서 탈분극이 일어나는 과정을 설명해 보세요.',keywords:['자극','나트륨 이온 통로','유입','탈분극'],distractors:['광합성','항체','글루카곤','글리코젠'],modelAnswer:'역치 이상의 자극을 받으면 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입된다. 그 결과 세포막 안쪽의 전위가 상승하여 탈분극이 일어난다.',citation:questions[0].citation},
      {id:'demo-essay2',userId:DEMO_STUDENT,subjectId:'demo-biology',materialId:'demo-hormone',prompt:'식사 후 혈당량이 증가했을 때 항상성이 유지되는 과정을 설명해 보세요.',keywords:['혈당량','인슐린','포도당 흡수','글리코젠 합성'],distractors:['글루카곤 증가','체온 상승','항원','혈액 응고'],modelAnswer:'혈당량이 증가하면 이자에서 인슐린의 분비가 증가한다. 인슐린은 세포의 포도당 흡수와 간에서의 글리코젠 합성을 촉진하여 혈당량을 낮추고 항상성을 유지한다.',citation:questions[2].citation},
    ]});
    const cardPairs = [
      ['뉴런이란?','자극을 받아 다른 세포로 흥분을 전달하는 신경계의 구조적·기능적 단위','CONCEPT','demo-biology'],
      ['탈분극은 어떻게 일어날까?','역치 이상의 자극 → 나트륨 이온 통로 열림 → Na⁺ 유입 → 막전위 상승','RELATION','demo-biology'],
      ['탈분극과 재분극의 차이는?','탈분극: Na⁺가 안으로 유입되어 막전위 상승. 재분극: K⁺가 밖으로 유출되어 막전위 하강.','COMPARISON','demo-biology'],
      ['도약 전도란?','말이집 신경에서 랑비에 결절 사이를 건너뛰며 빠르게 흥분을 전달하는 현상','CONCEPT','demo-biology'],
      ['인슐린의 역할은?','세포의 포도당 흡수와 간의 글리코젠 합성을 촉진하여 혈당량을 낮춘다.','RELATION','demo-biology'],
      ['인슐린과 글루카곤의 공통점과 차이점','둘 다 이자에서 분비되는 혈당 조절 호르몬. 인슐린은 혈당을 낮추고 글루카곤은 높인다.','COMPARISON','demo-biology'],
      ['미분계수의 기하학적 의미는?','곡선 위 한 점에서 그은 접선의 기울기','CONCEPT','demo-math'],
      ['f(x)=x²의 도함수는?','f′(x)=2x','CONCEPT','demo-math'],
      ['미분 가능하면 반드시 연속일까?','미분 가능하면 연속이다. 역은 성립하지 않는다.','RELATION','demo-math'],
      ['노비안검법을 실시한 왕은?','고려 광종','CONCEPT','demo-history'],
      ['시무 28조를 수용한 왕은?','고려 성종. 최승로의 건의를 수용하여 유교 통치 이념을 반영했다.','CONCEPT','demo-history'],
      ['광종과 성종의 정책 비교','광종: 노비안검법·과거제. 성종: 시무 28조 수용·12목 설치.','COMPARISON','demo-history'],
    ];
    await tx.card.createMany({data:cardPairs.map(([front,back,type,subjectId],index)=>({id:`demo-card${index+1}`,userId:DEMO_STUDENT,subjectId,front,back,type:type as 'CONCEPT'|'RELATION'|'COMPARISON',bucket:(['AGAIN','HARD','GOOD','EASY','MASTERED'] as const)[index % 5],consecutiveEasy:index % 5===4?2:index % 5===3?1:0,nextReviewAt:new Date(Date.now()-60_000)}))});
    const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date());
    await tx.schedule.createMany({data:[
      {userId:DEMO_STUDENT,title:'학교 수업',date:today,start:'08:30',end:'16:00',kind:'FIXED'},
      {userId:DEMO_STUDENT,title:'수학 학원',date:today,start:'18:00',end:'19:30',kind:'FIXED',subjectId:'demo-math'},
      {userId:DEMO_STUDENT,title:'생명과학 개념 복습',date:today,start:'20:00',end:'20:40',kind:'FLEXIBLE',subjectId:'demo-biology'},
    ]});
    await tx.post.createMany({data:[
      {id:'demo-post1',userId:'demo-peer-1',role:'STUDENT',category:'공부 팁',title:'아는 것 같은데 설명은 안 되는 사람 🙋',body:'저도 딱 그랬는데 서술형으로 설명하는 연습을 시작하고 많이 달라졌어요. 개념을 외운 다음 책을 덮고 한 문장만 써보세요. 막히는 부분이 진짜 복습할 부분이더라고요.',anonymous:false},
      {id:'demo-post2',userId:'demo-peer-2',role:'STUDENT',category:'자유',title:'오늘도 25분만 집중해 보자',body:'시험까지 얼마 안 남아서 마음만 급했는데 타이머를 켜고 딱 한 단원부터 시작했어요. 다들 오늘의 작은 목표가 뭔가요?',anonymous:false},
      {id:'demo-post3',userId:'demo-peer-1',role:'STUDENT',category:'수시',title:'생명과학 탐구 주제 같이 이야기해요',body:'항상성과 호르몬 단원을 공부하다가 생활 속 혈당 조절에 관심이 생겼어요. 교과 개념에서 출발해서 자료를 찾아보는 중이에요.',anonymous:true},
      {id:'demo-parent-post',userId:'demo-peer-parent',role:'PARENT',category:'자유',title:'성적보다 꾸준함을 먼저 봐주려고요',body:'아이가 스스로 정한 공부 시간을 지켰다는 사실을 먼저 칭찬해 줬어요. 작은 습관을 응원하는 것도 부모의 역할인 것 같아요.',anonymous:false},
    ]});
    await tx.comment.create({data:{postId:'demo-post1',userId:'demo-peer-2',body:'한 문장부터 시작한다는 게 좋네요. 오늘 바로 해볼게요!'}});
    await tx.cheer.create({data:{senderId:DEMO_PARENT,recipientId:DEMO_STUDENT,message:'오늘도 너의 속도로 한 걸음. 엄마가 늘 응원해 🧡',points:100}});
    await tx.notification.create({data:{userId:DEMO_STUDENT,title:'오늘의 기억을 오래오래',body:'복습할 카드가 기다리고 있어요. 5분이면 충분해요.',href:'/flashcards'}});
  }, {timeout:30_000});
}

if (process.argv[1]?.endsWith('seed.ts')) seedDemo().then(()=>console.log('DEMO_SEED_OK')).finally(()=>db.$disconnect());
