import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from '../src/lib/server/db';
import { handleApi } from '../src/lib/server/api';
import { createSession } from '../src/lib/server/auth';
import { scheduleCard, isDue } from '../src/lib/srs';
import { generateItems,gradeWithAi,planWithAi,extractImageText } from '../src/lib/server/ai';
import { aiAvailable,captureProviderUsage } from '../src/lib/server/provider';
import { hasCitation } from '../src/lib/server/algorithms';
import { inputHash } from '../src/lib/server/ai-runs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function main() {
  if(process.argv.includes('--provider-only'))return verifyProvider();
  // The database regression suite must never incur provider charges.
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.GEMINI_API_KEY;
  const target=new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1','localhost'].includes(target.hostname)&&target.pathname==='/memoryz'&&target.port==='15444','Checks are authorized only for the dedicated local memoryz database on port 15444');
  assert.equal(process.env.DEMO_MODE,'true');
  assert.equal(aiAvailable(),false,'The non-provider test must keep all AI calls disabled');
  if(process.argv.includes('--harness-only'))return verifyHarness();
  const prefix=`check-${randomUUID()}`;
  const ids={student:`${prefix}-s`,other:`${prefix}-o`,parent:`${prefix}-p`,admin:`${prefix}-a`};
  const files:string[]=[];
  const cookie:Record<string,string>={};
  let assertions=0;
  async function call(role:keyof typeof ids|null,route:string,method='GET',payload?:unknown,expected=200,headers:Record<string,string>={}) {
    const response=await handleApi(new Request(`http://127.0.0.1:3000/api/${route}`,{method,headers:{...(role?{cookie:cookie[role]}:{}),...(payload?{'Content-Type':'application/json'}:{}),...headers},...(payload?{body:JSON.stringify(payload)}:{})}));
    const result=await response.json();assert.equal(response.status,expected,`${method} ${route}: ${JSON.stringify(result)}`);assertions++;return result.data;
  }
  try {
    for(const [role,userId] of Object.entries(ids)) {
      await db.user.create({data:{id:userId,name:'검증 계정',nickname:userId,role:role==='parent'?'PARENT':role==='admin'?'ADMIN':'STUDENT',points:1000}});
      cookie[role]=(await createSession(userId,new Request('http://127.0.0.1:3000'))).split(';')[0];
    }
    await call(null,'bootstrap','GET',undefined,401);
    assert.equal((await call(null,'health')).database,'connected');
    await call('student','notifications','PATCH',{read:true},200,{origin:'http://localhost:3000',host:'localhost:3000','sec-fetch-site':'same-origin'});
    await call('student','subjects','POST',{name:'검증 과목'},403,{origin:'https://evil.example','sec-fetch-site':'cross-site'});
    const subject=await call('student','subjects','POST',{name:'검증 생명과학'},201);
    await call('other',`subjects/${subject.id}`,'PATCH',{name:'탈취'},404);
    await call('parent','subjects','POST',{name:'불법 과목'},403);
    const form=new FormData();form.append('file',new File(['나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.'],'테스트.txt',{type:'text/plain'}));
    const uploadResponse=await handleApi(new Request('http://127.0.0.1:3000/api/upload',{method:'POST',headers:{cookie:cookie.student},body:form}));
    assert.equal(uploadResponse.status,200);const upload=(await uploadResponse.json()).data;files.push(upload.url.split('/').pop());
    const uploaded=await handleApi(new Request(`http://127.0.0.1:3000${upload.url}`,{headers:{cookie:cookie.student}}));assert.equal(uploaded.status,200);assert.equal(await uploaded.text(),'나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.');
    await call('other',upload.url.replace('/api/',''),'GET',undefined,404);
    const material=await call('student','materials','POST',{subjectId:subject.id,title:'검증 자료',content:upload.content,type:'TXT',url:upload.url},201);
    await call('student',`materials/${material.id}`,'PATCH',{title:'수정한 자료'});
    await call('other',`materials/${material.id}`,'DELETE',undefined,404);
    await call('student','generate','POST',{materialId:material.id,count:1,mode:'quiz'},503);
    // A synthetic provider response exercises the long-running generation race without a billable request.
    const originalFetch=globalThis.fetch;
    process.env.OPENROUTER_API_KEY='synthetic-provider-key';
    process.env.OPENROUTER_MODEL='openai/gpt-5.6-luna';
    process.env.OPENROUTER_REASONING_EFFORT='high';
    try {
      globalThis.fetch=async()=>{
        await db.material.update({where:{id:material.id},data:{content:'생성 중 변경한 학습 자료의 본문입니다.'}});
        return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{prompt:'어떤 이온이 유입되나요?',options:['나트륨','칼륨','칼슘','염소','마그네슘'],answer:0,explanation:'나트륨 이온이 세포 안으로 유입됩니다.',citation:upload.content,past:'세포막',future:'막전위'}]})}}]});
      };
      await call('student','generate','POST',{materialId:material.id,count:1,mode:'quiz'},409);
      assert.equal(await db.question.count({where:{userId:ids.student}}),0);
    }finally{globalThis.fetch=originalFetch;delete process.env.OPENROUTER_API_KEY;await db.material.update({where:{id:material.id},data:{content:upload.content}});}
    const question=await db.question.create({data:{userId:ids.student,subjectId:subject.id,materialId:material.id,prompt:'탈분극의 원인은?',options:['Na 유입','Na 유출','K 유입','물 유입','없음'],answer:0,explanation:'Na 이온이 유입됩니다.',citation:upload.content,past:'세포막',future:'막전위'}});
    const essay=await db.essay.create({data:{userId:ids.student,subjectId:subject.id,materialId:material.id,prompt:'과정을 설명하세요.',keywords:['자극','통로','유입','탈분극'],distractors:['항체','호르몬','광합성','배설'],modelAnswer:'자극으로 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.',citation:upload.content}});
    await call('other','quiz/answer','POST',{questionId:question.id,answer:0},404);
    const wrong=await call('student','quiz/answer','POST',{questionId:question.id,answer:-1});assert.equal(wrong.correct,false);
    const correct=await call('student','quiz/answer','POST',{questionId:question.id,answer:0});assert.equal(correct.correct,true);
    const converted=await call('student','wrong-notes/cards','POST',{questionIds:[question.id]});
    const again=await call('student','wrong-notes/cards','POST',{questionIds:[question.id]});assert.equal(converted[0].id,again[0].id);
    const card=await call('student','cards','POST',{subjectId:subject.id,front:'앞',back:'뒤',type:'CONCEPT'},201);
    const reviewId=randomUUID();
    const first=await call('student','cards/review','POST',{cardId:card.id,rating:'EASY',reviewId});assert.equal(first.bucket,'EASY');
    const duplicate=await call('student','cards/review','POST',{cardId:card.id,rating:'EASY',reviewId});assert.equal(duplicate.consecutiveEasy,1);
    await call('other','cards/review','POST',{cardId:card.id,rating:'EASY',reviewId:randomUUID()},404);
    await call('student','cards/review','POST',{cardId:card.id,rating:'HARD',reviewId},409);
    const mastered=await call('student','cards/review','POST',{cardId:card.id,rating:'EASY',reviewId:randomUUID()});assert.equal(mastered.bucket,'MASTERED');
    assert.equal(mastered.fsrs,null);
    assert.equal((await call('student','bootstrap')).profile.srsMode,'FIXED');
    await call('student','profile','PATCH',{srsMode:'UNKNOWN'},400);
    await call('student','profile','PATCH',{desiredRetention:.79},400);
    await call('student','profile','PATCH',{desiredRetention:.98},400);
    const preferences=await call('student','profile','PATCH',{srsMode:'FSRS',desiredRetention:.93});assert.equal(preferences.srsMode,'FSRS');assert.equal(preferences.desiredRetention,.93);
    assert.equal((await db.user.findUniqueOrThrow({where:{id:ids.student}})).srsMode,'FSRS');
    const adaptive=await call('student','cards','POST',{subjectId:subject.id,front:'적응형 앞',back:'적응형 뒤',type:'CONCEPT'},201);assert.equal(adaptive.fsrs,null);
    const reviewedAt=Date.now()-86400_000;const adaptiveReviewId=randomUUID();
    const predicted=scheduleCard(adaptive,'EASY','FSRS',.93,reviewedAt);
    const firstAdaptive=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:adaptiveReviewId,reviewedAt});
    assert.deepEqual(firstAdaptive.fsrs,predicted.fsrs);assert.equal(firstAdaptive.nextReviewAt,predicted.nextReviewAt);assert.equal(firstAdaptive.fsrs.reps,1);
    const replay=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:adaptiveReviewId,reviewedAt});assert.deepEqual(replay.fsrs,firstAdaptive.fsrs);
    await call('student','cards/review','POST',{cardId:adaptive.id,rating:'GOOD',reviewId:randomUUID(),reviewedAt:Date.now()+301_000},400);
    await call('student','cards/review','POST',{cardId:adaptive.id,rating:'GOOD',reviewId:randomUUID(),reviewedAt:Date.now()-31*86400_000},400);
    await call('student','cards/review','POST',{cardId:adaptive.id,rating:'GOOD',reviewId:randomUUID(),reviewedAt:reviewedAt-1},409);
    const secondAdaptive=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:randomUUID(),reviewedAt:reviewedAt+3*3600_000});assert.equal(secondAdaptive.bucket,'MASTERED');assert.equal(secondAdaptive.fsrs.reps,2);assert.equal(isDue(secondAdaptive,Date.parse(secondAdaptive.nextReviewAt)),true);
    const legacyQueue=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'GOOD',reviewId:randomUUID()});assert.equal(legacyQueue.fsrs.reps,3);
    assert.deepEqual((await call('student','bootstrap')).cards.find((item:{id:string})=>item.id===adaptive.id).fsrs,legacyQueue.fsrs);
    await call('student','profile','PATCH',{srsMode:'FIXED'});
    const fixedAt=Date.now();const fixedAgain=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'HARD',reviewId:randomUUID(),reviewedAt:fixedAt});assert.equal(fixedAgain.fsrs,null);assert.equal(fixedAgain.nextReviewAt,new Date(fixedAt+86400_000).toISOString());
    const eventAt=Date.now();const eventPrediction=scheduleCard(fixedAgain,'EASY','FSRS',.87,eventAt);
    const eventReplay=await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:randomUUID(),reviewedAt:eventAt,mode:'FSRS',retention:.87});
    assert.deepEqual(eventReplay.fsrs,eventPrediction.fsrs);assert.equal(eventReplay.nextReviewAt,eventPrediction.nextReviewAt);
    assert.equal((await call('student','bootstrap')).profile.srsMode,'FIXED');
    await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:randomUUID(),mode:'INVALID'},400);
    await call('student','cards/review','POST',{cardId:adaptive.id,rating:'EASY',reviewId:randomUUID(),retention:1.1},400);
    await call('student',`cards/${card.id}`,'PATCH',{deleted:true});await call('student','cards/review','POST',{cardId:card.id,rating:'GOOD',reviewId:randomUUID()},404);await call('student',`cards/${card.id}`,'PATCH',{deleted:false});
    const grade=await call('student','essay/submit','POST',{essayId:essay.id,answer:essay.modelAnswer});assert.equal(grade.score,100);
    const schedule=await call('student','schedules','POST',{title:'고정 일정',date:'2026-09-15',start:'18:00',end:'19:30',kind:'FIXED'},201);
    await call('student','schedules','POST',{title:'충돌',date:'2026-09-15',start:'18:30',end:'19:00',kind:'FLEXIBLE'},409);
    await call('student','schedules','POST',{title:'잘못된 날짜',date:'2026-02-30',start:'18:30',end:'19:00',kind:'FLEXIBLE'},400);
    const plans=await call('student','planner/suggest','POST',{date:'2026-09-15'});assert.equal(plans.plans.length,2);
    await call('student',`schedules/${schedule.id}`,'PATCH',{done:true});
    await call('other',`schedules/${schedule.id}`,'DELETE',undefined,404);
    const post=await call('student','posts','POST',{title:'검증 게시글',body:'본문',category:'자유',anonymous:false},201);
    await call('parent','posts?role=STUDENT','GET',undefined,403);
    await call('parent',`posts/${post.id}/comments`,'GET',undefined,403);
    await call('other',`posts/${post.id}/like`,'POST',{});await call('student',`posts/${post.id}/save`,'POST',{});
    const comment=await call('other',`posts/${post.id}/comments`,'POST',{body:'댓글'},201);
    const reply=await call('student',`posts/${post.id}/comments`,'POST',{body:'답글',parentId:comment.id},201);
    await call('student',`posts/${post.id}/comments`,'POST',{body:'잘못된 깊이',parentId:reply.id},400);
    const report=await call('other','reports','POST',{postId:post.id,reason:'검증 신고'});
    await call('student','admin','GET',undefined,403);
    await call('admin',`admin/reports/${report.id}`,'PATCH',{status:'RESOLVED'});
    await call('student','follow','POST',{userId:ids.other});await call('student','messages','POST',{userId:ids.other,body:'안녕하세요'},201);
    const messages=await call('other',`messages?userId=${ids.student}`);assert.equal(messages.length,1);
    await call('parent','messages','POST',{userId:ids.student,body:'역할 침범'},404);
    await call('student','blocks','POST',{userId:ids.other});await call('other',`posts/${post.id}/comments`,'GET',undefined,404);await call('other','messages','POST',{userId:ids.student,body:'차단 침범'},403);
    await call('student',`blocks/${ids.other}`,'DELETE');
    const invite=await call('student','invite','POST',{});assert.match(invite.code,/^\d{6}$/);
    for(let i=0;i<5;i++)await call('parent','link','POST',{code:'000000'},i===4?429:400);
    await call('parent','link','POST',{code:invite.code},429);
    await db.user.update({where:{id:ids.parent},data:{linkLockedUntil:new Date(Date.now()-1000)}});
    await call('parent','link','POST',{code:invite.code});
    await call('parent','link','POST',{code:invite.code},400);
    await call('student','profile','PATCH',{privacy:{accuracy:false,time:false,wrongNotes:false}});
    const hidden=await call('parent','bootstrap');assert.equal(hidden.child.id,ids.student);assert.equal(hidden.stats.accuracy,0);assert.equal(hidden.stats.studyMinutes,0);assert.deepEqual(hidden.stats.weekly,[]);assert.deepEqual(hidden.attempts,[]);assert.deepEqual(hidden.questions,[]);assert.deepEqual(hidden.materials,[]);assert.deepEqual(hidden.cards,[]);assert.deepEqual(hidden.schedules,[]);
    assert.deepEqual((await call('parent','parent-stats')).subjectStats,[]);
    await call('student','profile','PATCH',{privacy:{accuracy:true,time:true,wrongNotes:true}});
    const visible=await call('parent','bootstrap');assert.equal(visible.attempts.length,3);assert.equal(visible.stats.accuracy,67);
    assert.equal((await call('parent','parent-stats')).subjectStats[0].count,2);
    await call('parent','cheers','POST',{message:'응원해',points:1100},400);
    const cheer=await call('parent','cheers','POST',{message:'응원해',points:100},201);await call('student',`cheers/${cheer.id}`,'PATCH',{thanked:true});
    assert.equal((await db.user.findUniqueOrThrow({where:{id:ids.parent}})).points,900);assert.equal((await db.user.findUniqueOrThrow({where:{id:ids.student}})).points,1100);
    const state=await call('student','bootstrap');assert.equal(state.materials[0].title,'수정한 자료');assert.equal(state.cards.find((item:{id:string})=>item.id===card.id).bucket,'MASTERED');assert.equal(state.attempts.length,3);
    const children=await call('parent','children');assert.equal(children.length,1);await call('parent','children/select','POST',{childId:ids.other},404);
    await call('parent',`children/${ids.student}`,'DELETE');assert.equal((await call('parent','bootstrap')).child,undefined);
    await call('admin',`admin/users/${ids.other}`,'PATCH',{suspended:true});await call('other','bootstrap','GET',undefined,403);
    await call('student','notifications','PATCH',{read:true});
    await call('student',`materials/${material.id}`,'DELETE');
    await call('student',`subjects/${subject.id}`,'DELETE');
    assert.equal((await call('student','bootstrap')).subjects.length,0);
    console.log(`BACKEND_INTEGRATION_OK ${assertions} HTTP outcome checks plus persistence, privacy, replay, lockout and ownership assertions`);
    console.log('FSRS_PERSISTENCE_OK fixed/adaptive mode, exact shared scheduling, retained state, timestamps and replay validated');
  } finally {
    await db.user.deleteMany({where:{id:{in:Object.values(ids)}}});
    for(const file of files)await unlink(path.join(process.cwd(),'.data','uploads',file)).catch(()=>{});
    await db.$disconnect();
  }
}

async function verifyProvider() {
  assert.ok(aiAvailable(),'OpenRouter configuration is required for this explicitly billable test');
  assert.equal(process.env.OPENROUTER_MODEL,'openai/gpt-5.6-luna');
  assert.equal(process.env.OPENROUTER_REASONING_EFFORT,'high');
  const source='메모리즈 실험에서는 식물에 빛을 비추면 광합성이 일어난다. 광합성은 빛 에너지를 이용하여 이산화탄소와 물로부터 포도당과 산소를 만드는 과정이다. 빛은 엽록체에서 흡수된다. 생성된 포도당은 식물의 에너지원으로 사용된다.';
  const {default:sharp}=await import('sharp');
  const png=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="180"><rect width="800" height="180" fill="white"/><text x="36" y="112" font-family="Arial" font-size="56" fill="black">MEMORYZ TEST 42</text></svg>')).png().toBuffer();
  const date='2026-09-15';
  const existing=[{date,start:'08:00',end:'16:00',title:'학교 수업'},{date,start:'18:00',end:'19:00',title:'학원'}];
  const subjects=[{id:'synthetic-biology',name:'생명과학',dueCards:12},{id:'synthetic-math',name:'수학',dueCards:0}];
  const checks=await captureProviderUsage(async()=>{
    const results=await Promise.allSettled([
      generateItems(source,'quiz',1),generateItems(source,'essay',1),generateItems(source,'cards',1),
      gradeWithAi({prompt:'광합성의 과정을 설명하세요.',keywords:['빛','엽록체','광합성','포도당'],modelAnswer:'빛이 엽록체에서 흡수되면 광합성이 일어나 이산화탄소와 물로부터 포도당과 산소가 만들어진다.',citation:'광합성은 빛 에너지를 이용하여 이산화탄소와 물로부터 포도당과 산소를 만드는 과정이다.',answer:'빛이 엽록체에서 흡수되면 광합성을 통해 이산화탄소와 물이 포도당과 산소로 바뀝니다.'}),
      planWithAi(date,existing,subjects),extractImageText(png,'image/png'),
    ]);
    const names=['quiz','essay','cards','grade','planner','ocr'];
    const failures=results.flatMap((result,index)=>result.status==='rejected'?[{name:names[index],error:result.reason instanceof Error?result.reason.message:'Unknown error'}]:[]);
    if(failures.length)throw new Error(`Provider validation failures: ${JSON.stringify(failures)}`);
    const values=results.map(result=>(result as PromiseFulfilledResult<unknown>).value);
    for(const value of values.slice(0,3)){const items=value as {citation:string}[];assert.equal(items.length,1);assert.equal(hasCitation(source,items[0].citation),true);}
    const grade=values[3] as {score:number;method:string;matched:string[]};assert.equal(grade.method,'AI');assert.ok(grade.score>=60);assert.ok(grade.matched.length>=3);
    const plans=values[4] as {plans:{blocks:unknown[]}[];method:string;dropped:number};assert.ok(['AI','AI+규칙'].includes(plans.method),`planner used the AI result (${plans.method}, dropped ${plans.dropped})`);assert.equal(plans.plans.length,2);assert.ok(plans.plans.every(plan=>plan.blocks.length>0));
    assert.match(values[5] as string,/MEMORYZ\s+TEST\s+42/i);
    return {quiz:1,essay:1,cards:1,gradeScore:grade.score,plans:2,planMethod:plans.method,planDropped:plans.dropped,ocr:'MEMORYZ TEST 42'};
  });
  assert.equal(checks.requests.length,6);
  assert.ok(checks.requests.every(request=>request.model.includes('gpt-5.6-luna')&&request.promptTokens>0&&request.completionTokens>0));
  const servedBy=checks.requests.map(request=>request.provider);
  assert.ok(servedBy.every(provider=>['Amazon Bedrock','OpenAI'].includes(provider)),`Only Bedrock us-east-1 or the openai/fast fallback may serve Luna: ${servedBy.join(', ')}`);
  const evidence={verifiedAt:new Date().toISOString(),model:process.env.OPENROUTER_MODEL,reasoning:'high',checks:checks.value,requests:checks.requests,totals:{promptTokens:checks.requests.reduce((sum,item)=>sum+item.promptTokens,0),completionTokens:checks.requests.reduce((sum,item)=>sum+item.completionTokens,0),cost:checks.requests.every(item=>item.cost!==null)?checks.requests.reduce((sum,item)=>sum+(item.cost??0),0):null}};
  await mkdir(path.join(process.cwd(),'.data'),{recursive:true});
  await writeFile(path.join(process.cwd(),'.data','openrouter-verification.json'),JSON.stringify(evidence,null,2));
  console.log(`OPENROUTER_VERIFIED ${JSON.stringify(evidence)}`);
  await db.$disconnect();
}

async function verifyHarness(){
  const prefix=`harness-${randomUUID()}`;const student=`${prefix}-student`;const other=`${prefix}-other`;
  const originalFetch=globalThis.fetch;
  let providerCalls=0;
  const source='나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다. 칼륨 이온이 세포 밖으로 나가면 재분극이 일어난다.';
  const item={prompt:'탈분극을 일으키는 이온의 이동은?',options:['나트륨 유입','나트륨 유출','칼륨 유입','칼륨 유출','이동 없음'],answer:0,explanation:'나트륨 이온이 세포 안으로 유입되어 탈분극이 발생해요.',citation:'나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.',past:'세포막',future:'막전위'};
  try{
    await db.user.createMany({data:[{id:student,name:'검증',nickname:student,role:'STUDENT'},{id:other,name:'검증',nickname:other,role:'STUDENT'}]});
    const cookie=(await createSession(student,new Request('http://127.0.0.1:3000'))).split(';')[0];
    const otherCookie=(await createSession(other,new Request('http://127.0.0.1:3000'))).split(';')[0];
    const call=async(route:string,method='GET',payload?:unknown,status=200,otherUser=false)=>{
      const response=await handleApi(new Request(`http://127.0.0.1:3000/api/${route}`,{method,headers:{cookie:otherUser?otherCookie:cookie,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})}));
      const result=await response.json();assert.equal(response.status,status,`${route}: ${JSON.stringify(result)}`);return result.data;
    };
    const subject=await db.subject.create({data:{userId:student,name:'하네스 검증'}});
    const material=await db.material.create({data:{userId:student,subjectId:subject.id,title:'합성 자료',type:'TXT',content:source}});
    const payload={materialId:material.id,count:1,mode:'quiz'};
    const requestId=randomUUID();
    let started!:()=>void;const startedModel=new Promise<void>(resolve=>{started=resolve;});
    let release!:()=>void;const providerBarrier=new Promise<void>(resolve=>{release=resolve;});
    process.env.OPENROUTER_API_KEY='synthetic-provider-key';process.env.OPENROUTER_MODEL='openai/gpt-5.6-luna';process.env.OPENROUTER_REASONING_EFFORT='high';
    globalThis.fetch=async()=>{providerCalls++;started();await providerBarrier;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[item]})}}]});};
    const first=call('generate','POST',{...payload,requestId},201);
    let startTimer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([startedModel,first.then(()=>{throw new Error('Request completed before provider stage');}),new Promise((_,reject)=>{startTimer=setTimeout(()=>reject(new Error('Provider stage was not reached')),60_000);})]);}finally{if(startTimer)clearTimeout(startTimer);}
    await call('generate','POST',{...payload,requestId},409);
    await call('generate','POST',{...payload,count:2,requestId},409);
    const running=await call(`ai-runs/${requestId}`);assert.equal(running.status,'RUNNING');assert.equal(running.steps.at(-1).stage,'GENERATE');
    await call(`ai-runs/${requestId}`,'GET',undefined,404,true);
    release();const created=await first;assert.equal(providerCalls,1);assert.equal(created.length,1);
    const replay=await call('generate','POST',{...payload,requestId},201);assert.deepEqual(replay,created);assert.equal(providerCalls,1);assert.equal(await db.question.count({where:{userId:student}}),1);
    const saved=await call(`ai-runs/${requestId}`);assert.equal(saved.status,'COMPLETED');assert.deepEqual(saved.result,created);assert.deepEqual(saved.steps.map((step:{stage:string})=>step.stage),['LOAD_CONTEXT','GENERATE','VALIDATE','COMMIT']);assert.ok(saved.steps.every((step:{status:string})=>step.status==='COMPLETED'));assert.equal(saved.skillVersion,'1.0.0');assert.equal(JSON.stringify(saved).includes('synthetic-provider-key'),false);
    const processCode=`import 'dotenv/config'; import {readAiRun} from './src/lib/server/ai-runs.ts'; import {db} from './src/lib/server/db.ts'; const run=await readAiRun(${JSON.stringify(student)},${JSON.stringify(requestId)}); if(run.status!=='COMPLETED'||run.result[0].id!==${JSON.stringify(created[0].id)})throw Error('Persisted result mismatch'); console.log('SAVED_RUN_RELOADED'); await db.$disconnect();`;
    const restarted=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',processCode],{cwd:process.cwd(),timeout:30000});assert.match(restarted.stdout,/SAVED_RUN_RELOADED/);
    globalThis.fetch=async()=>{providerCalls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{...item,citation:'원문에 없는 전혀 다른 출처 문장이에요.'}]})}}]});};
    const invalidId=randomUUID();await call('generate','POST',{...payload,requestId:invalidId},422);await call('generate','POST',{...payload,requestId:invalidId},422);assert.equal(providerCalls,2);assert.equal(await db.question.count({where:{userId:student}}),1);assert.equal((await call(`ai-runs/${invalidId}`)).status,'FAILED');
    delete process.env.OPENROUTER_API_KEY;
    const missingId=randomUUID();await call('generate','POST',{...payload,requestId:missingId},503);await call('generate','POST',{...payload,requestId:missingId},503);assert.equal(providerCalls,2);assert.equal((await call(`ai-runs/${missingId}`)).errorStatus,503);
    const staleId=randomUUID();await db.aiRun.create({data:{userId:student,requestId:staleId,kind:'quiz',inputHash:inputHash('quiz',payload),skillVersion:'1.0.0',model:'openai/gpt-5.6-luna',status:'RUNNING',updatedAt:new Date(Date.now()-6*60_000)}});
    assert.equal((await call(`ai-runs/${staleId}`)).status,'INTERRUPTED');await call('generate','POST',{...payload,requestId:staleId},409);assert.equal(providerCalls,2);
    const essay=await db.essay.create({data:{userId:student,subjectId:subject.id,materialId:material.id,prompt:'탈분극 과정을 설명하세요.',keywords:['자극','통로','유입','탈분극'],distractors:['항원','항체','호르몬','광합성'],modelAnswer:'자극으로 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.',citation:item.citation}});
    const gradeId=randomUUID();const gradePayload={essayId:essay.id,answer:essay.modelAnswer,requestId:gradeId};const grade=await call('essay/submit','POST',gradePayload);assert.deepEqual(await call('essay/submit','POST',gradePayload),grade);assert.equal(await db.attempt.count({where:{userId:student,essayId:essay.id}}),1);await call('essay/submit','POST',{...gradePayload,answer:'다른 답변'},409);
    const planId=randomUUID();const plan=await call('planner/suggest','POST',{date:'2026-09-15',requestId:planId});assert.deepEqual(await call('planner/suggest','POST',{date:'2026-09-15',requestId:planId}),plan);
    await call('planner/suggest','POST',{date:'2026-09-16',requestId:planId},409);await call('planner/suggest','POST',{date:'2026-09-15',requestId},409);
    console.log('AI_HARNESS_VERIFIED typed staged execution, atomic persistence, same-key replay, concurrent409, cross-user404, changed-input409, restart read, interrupted run and disabled-provider behavior');
  }finally{globalThis.fetch=originalFetch;delete process.env.OPENROUTER_API_KEY;await db.user.deleteMany({where:{id:{in:[student,other]}}});await db.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
