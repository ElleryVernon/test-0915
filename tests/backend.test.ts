import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conflict,gradeEssay,hasCitation,nextReview,proposePlans,validDate } from '../src/lib/server/algorithms';
import { validateAiGrade, validateAiPlans } from '../src/lib/server/ai';
import { scheduleCard, isDue } from '../src/lib/srs';
import type { Card } from '../src/lib/contracts';
import { strictSchema,providerJson } from '../src/lib/server/provider';
import { z } from 'zod';
import { SkillRuntime } from '../src/lib/server/skill-runtime';
import { SKILLS } from '../src/lib/server/skills';

test('SRS uses exact review intervals and two consecutive easy grades master a card',()=>{
  const now=new Date('2026-09-15T00:00:00Z');
  for(const [rating,minutes] of [['AGAIN',10],['HARD',1440],['GOOD',4320],['EASY',10080]] as const){const result=nextReview(0,rating,now);assert.equal(result.nextReviewAt.getTime()-now.getTime(),minutes*60_000);assert.equal(result.bucket,rating);}
  assert.equal(nextReview(1,'EASY',now).bucket,'MASTERED');
  assert.equal(nextReview(5,'HARD',now).consecutiveEasy,0);
  assert.equal(nextReview(5,'AGAIN',now).bucket,'AGAIN');
  assert.throws(()=>nextReview(0,'MASTERED' as 'EASY',now));
});
test('citation guard accepts real text and rejects hallucination, short and empty citations',()=>{
  const source='나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.';
  assert.equal(hasCitation(source,'나트륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.'),true);
  assert.equal(hasCitation(source,'나트륨  이온이\n세포 안으로 유입되어 탈분극이 일어난다.'),true);
  assert.equal(hasCitation(source,'칼륨 이온이 세포 안으로 유입되어 탈분극이 일어난다.'),false);
  assert.equal(hasCitation(source,''),false);
  assert.equal(hasCitation(source,'나트륨'),false);
});
test('rubric explicitly discloses deterministic practice grading and detects missing or reversed terms',()=>{
  const keywords=['자극','통로','유입','탈분극'];
  const model='역치 이상의 자극으로 나트륨 이온 통로가 열리고 나트륨 이온이 세포 안으로 유입되어 막전위가 상승하는 탈분극이 일어난다.';
  const result=gradeEssay(model,keywords,model);
  assert.equal(result.score,100);assert.deepEqual(result.missing,[]);assert.match(result.feedback,/AI 의미 평가가 아닙니다/);
  assert.equal(gradeEssay('탈분극 유입 통로 자극',keywords,model).score,60);
  assert.equal(gradeEssay('',keywords,model).score,0);
  assert.deepEqual(gradeEssay('자극이 오면 통로가 열린다.',keywords,model).missing,['유입','탈분극']);
});
test('schedule boundary allows touching endpoints and rejects containment and partial overlap',()=>{
  const fixed={date:'2026-09-15',start:'18:00',end:'19:30'};
  assert.equal(conflict(fixed,{...fixed,start:'19:30',end:'20:00'}),false);
  assert.equal(conflict(fixed,{...fixed,start:'17:00',end:'18:00'}),false);
  assert.equal(conflict(fixed,{...fixed,start:'18:15',end:'18:30'}),true);
  assert.equal(conflict(fixed,{...fixed,start:'17:00',end:'20:00'}),true);
  assert.equal(conflict(fixed,{...fixed,date:'2026-09-16'}),false);
});
test('both planner proposals preserve occupied blocks, contain no internal overlaps and fit study hours',()=>{
  const date='2026-09-15';
  const occupied=[{date,start:'16:00',end:'17:30'},{date,start:'18:00',end:'19:30'},{date,start:'20:00',end:'20:30'}];
  const result=proposePlans(date,occupied,[{id:'bio',name:'생명과학'},{id:'math',name:'수학'}]);
  assert.equal(result.plans.length,2);
  for(const plan of result.plans){assert.ok(plan.blocks.length>0);for(const [index,block] of plan.blocks.entries()){assert.ok(block.start>='16:00'&&block.end<='22:00');assert.equal(occupied.some(other=>conflict(block,other)),false);assert.equal(plan.blocks.slice(index+1).some(other=>conflict(block,other)),false);}}
  assert.equal(proposePlans(date,[{date,start:'00:00',end:'23:59'}],[]).plans[0].blocks.length,0);
});
test('date validation rejects normalized impossible calendar dates',()=>{
  assert.equal(validDate('2026-09-15'),true);assert.equal(validDate('2024-02-29'),true);assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2026-13-01'),false);assert.equal(validDate('9/15/2026'),false);
});

test('AI semantic grading validates the full keyword partition and rejects contradictory or out-of-range scores',()=>{
  const keywords=['자극','유입'];
  const good={score:75,matched:['자극'],missing:['유입'],feedback:'자극을 설명했어요. 이온 유입 과정도 연결해 보세요.'};
  assert.equal(validateAiGrade(good,keywords).method,'AI');
  assert.throws(()=>validateAiGrade({...good,score:101},keywords));
  assert.throws(()=>validateAiGrade({...good,score:100},keywords));
  assert.throws(()=>validateAiGrade({...good,matched:['없는 키워드']},keywords));
  assert.throws(()=>validateAiGrade({...good,matched:['자극','자극']},keywords));
});
test('AI planner rejects invented subjects, occupied times, invalid dates and unsafe hour bounds',()=>{
  const date='2026-09-15';const subjects=[{id:'bio',name:'생명과학',dueCards:4}];
  const existing=[{date,start:'18:00',end:'19:30'}];
  const block={date,title:'개념 복습',start:'20:00',end:'20:30',kind:'FLEXIBLE' as const,subjectId:'bio',done:false as const};
  const payload=(candidate:typeof block)=>({plans:[{name:'A',reason:'근거',blocks:[candidate]},{name:'B',reason:'근거',blocks:[block]}]});
  const valid=validateAiPlans(payload(block),date,existing,subjects);
  assert.equal(valid.method,'AI');assert.equal(valid.dropped,0);assert.deepEqual(valid.plans.map(plan=>plan.name),['A','B']);
  for(const bad of [{...block,start:'18:30',end:'19:00'},{...block,subjectId:'unknown'},{...block,date:'2026-09-16'},{...block,start:'02:00',end:'03:00'},{...block,start:'20:00',end:'20:20'},{...block,start:'20:00',end:'21:10'}]){
    const result=validateAiPlans(payload(bad),date,existing,subjects);
    assert.equal(result.dropped,1,`dropped ${JSON.stringify(bad)}`);
    assert.equal(result.method,'AI+규칙','the emptied plan is replaced by the rule-based one, the valid AI plan stays');
    assert.equal(result.plans[1].name,'B');
    assert.equal(result.plans[0].name,'복습 우선');
    assert.ok(result.plans.flatMap(plan=>plan.blocks).every(item=>!existing.some(other=>conflict(item,other))&&item.date===date&&item.start>='06:00'));
  }
  const twice=validateAiPlans({plans:[{name:'A',reason:'근거',blocks:[block,block]},{name:'B',reason:'근거',blocks:[block]}]},date,existing,subjects);
  assert.equal(twice.plans[0].blocks.length,1,'an overlapping duplicate is removed, the rest of the plan is kept');assert.equal(twice.method,'AI');
  const none=validateAiPlans({plans:[{name:'A',reason:'근거',blocks:[{...block,start:'20:00',end:'20:15'}]},{name:'B',reason:'근거',blocks:[{...block,subjectId:'x'}]}]},date,existing,subjects);
  assert.equal(none.method,'규칙 기반 일정 추천');assert.equal(none.dropped,2);assert.ok(none.plans.every(plan=>plan.blocks.length>0));
  assert.throws(()=>validateAiPlans({plans:[{name:'A',blocks:[block]},{name:'B',blocks:[block]}]},date,existing,subjects),'a plan without a stated reason is rejected');
  assert.equal(validateAiPlans(payload(block),date,existing,subjects,'19:55').plans[0].reason,'근거');
  assert.equal(validateAiPlans(payload(block),date,existing,subjects,'20:05').plans[0].name,'복습 우선','a block starting before the current time is removed');
});

test('shared scheduler preserves fixed intervals and initializes FSRS without inventing previous repetitions',()=>{
  const now=new Date('2026-09-15T00:00:00Z');
  const card:Card={id:'card',subjectId:'biology',front:'앞면',back:'뒷면',type:'CONCEPT',bucket:'EASY',consecutiveEasy:1,nextReviewAt:now.toISOString(),deleted:false};
  const fixed=scheduleCard(card,'EASY','FIXED',.9,now);
  assert.equal(fixed.nextReviewAt,new Date(now.getTime()+7*86400_000).toISOString());
  assert.equal(fixed.fsrs,null);assert.equal(fixed.bucket,'MASTERED');assert.equal(isDue(fixed,Date.parse(fixed.nextReviewAt)),false);
  const adaptive=scheduleCard(card,'EASY','FSRS',.9,now);
  assert.equal(adaptive.fsrs?.reps,1);assert.equal(adaptive.fsrs?.last_review,now.toISOString());assert.equal(adaptive.bucket,'MASTERED');
  assert.equal(isDue(adaptive,Date.parse(adaptive.nextReviewAt)),true);
  assert.throws(()=>scheduleCard(adaptive,'GOOD','FSRS',.9,now.getTime()-1));
  assert.throws(()=>scheduleCard(card,'GOOD','FSRS',.99,now));
});

test('OpenRouter strict schemas require every nested property and represent optional values with null',()=>{
  const original=z.toJSONSchema(z.object({title:z.string(),optional:z.string().optional(),items:z.array(z.object({id:z.string(),caption:z.string().optional()}))}));
  const schema=strictSchema(original);
  const inspect=(value:unknown)=>{if(Array.isArray(value)){value.forEach(inspect);return;}if(!value||typeof value!=='object')return;const node=value as Record<string,unknown>;if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual((node.required as string[]).sort(),Object.keys(node.properties as object).sort());}Object.values(node).forEach(inspect);};
  inspect(schema);assert.equal(schema.$schema,undefined);assert.ok(original.$schema);
  const optional=(schema.properties as Record<string,{anyOf:unknown[]}>).optional;
  assert.deepEqual(optional.anyOf[1],{type:'null'});
  assert.throws(()=>strictSchema('invalid'));
});

test('OpenRouter adapter sends exact high-reasoning structured request without temperature and rejects invalid responses',async()=>{
  const previousFetch=globalThis.fetch;
  const keys=['OPENROUTER_API_KEY','OPENROUTER_MODEL','OPENROUTER_REASONING_EFFORT','OPENROUTER_PROVIDER_ORDER'] as const;
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  process.env.OPENROUTER_API_KEY='synthetic-test-key';process.env.OPENROUTER_MODEL='openai/gpt-5.6-luna';process.env.OPENROUTER_REASONING_EFFORT='high';delete process.env.OPENROUTER_PROVIDER_ORDER;
  try {
    globalThis.fetch=async(input,init)=>{
      assert.equal(input,'https://openrouter.ai/api/v1/chat/completions');
      const payload=JSON.parse(init?.body as string);
      assert.equal(payload.model,'openai/gpt-5.6-luna');assert.deepEqual(payload.reasoning,{effort:'high',exclude:true});assert.equal('temperature' in payload,false);assert.equal(payload.provider.require_parameters,true);assert.ok(payload.max_tokens>=8192);
      assert.deepEqual(payload.provider.order,['amazon-bedrock/us-east-1','openai/fast'],'Bedrock us-east-1 first, only openai/fast as fallback');assert.equal(payload.provider.allow_fallbacks,false);
      assert.equal('response_format' in payload,false,'Bedrock rejects response_format');assert.equal(payload.tools[0].function.name,'test');assert.equal(payload.tools[0].function.strict,true);assert.deepEqual(payload.tool_choice,{type:'function',function:{name:'test'}});assert.equal(payload.tools[0].function.parameters.additionalProperties,false);
      return Response.json({model:payload.model,provider:'Amazon Bedrock',choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{type:'function',function:{name:'test',arguments:'{"text":"validated"}'}}]}}]});
    };
    assert.deepEqual(await providerJson('Synthetic prompt',z.toJSONSchema(z.object({text:z.string()})),'test'),{text:'validated'});
    globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'{"text":"content fallback"}'}}]});
    assert.deepEqual(await providerJson('Synthetic',{},'test'),{text:'content fallback'},'a plain JSON message is still accepted');
    process.env.OPENROUTER_PROVIDER_ORDER='openai/fast';
    globalThis.fetch=async(_input,init)=>{assert.deepEqual(JSON.parse(init?.body as string).provider.order,['openai/fast']);return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{function:{name:'test',arguments:'{"text":"override"}'}}]}}]});};
    assert.deepEqual(await providerJson('Synthetic',{},'test'),{text:'override'});
    process.env.OPENROUTER_PROVIDER_ORDER='bad slug!';
    await assert.rejects(()=>providerJson('Synthetic',{},'test'),/공급자 설정/);
    delete process.env.OPENROUTER_PROVIDER_ORDER;
    globalThis.fetch=async()=>Response.json({error:{message:'rate limited'}},{status:429});
    await assert.rejects(()=>providerJson('Synthetic',{},'test'),(error:unknown)=>Boolean(error&&typeof error==='object'&&'status' in error&&error.status===429));
    globalThis.fetch=async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{"text":"partial"}'}}]});
    await assert.rejects(()=>providerJson('Synthetic',{},'test'),/완성되지/);
  }finally{globalThis.fetch=previousFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test('all six versioned skills enforce stage order and validate arguments before executing tools',async()=>{
  assert.deepEqual(Object.keys(SKILLS).sort(),['cards','essay','grade','ocr','planner','quiz']);
  for(const skill of Object.values(SKILLS)){assert.match(skill.version,/^\d+\.\d+\.\d+$/);assert.ok(skill.instructions.length>20);}
  const runtime=new SkillRuntime('quiz');let executions=0;
  await assert.rejects(()=>runtime.tool('GENERATE',{},z.object({}),()=>{executions++;}),/허용되지/);
  await assert.rejects(()=>runtime.tool('LOAD_CONTEXT',{id:3},z.object({id:z.string()}),()=>{executions++;}),/입력 형식/);
  assert.equal(executions,0);assert.equal(runtime.steps.length,0);
  await runtime.tool('LOAD_CONTEXT',{id:'source'},z.object({id:z.string()}),()=>{executions++;return 'source';});
  await assert.rejects(()=>runtime.tool('COMMIT',{},z.object({}),()=>{}),/허용되지/);
  await runtime.tool('GENERATE',{},z.object({}),()=>({text:'valid'}));
  await runtime.tool('VALIDATE',{text:'valid'},z.object({text:z.string()}),value=>value);
  await runtime.tool('COMMIT',{},z.object({}),()=>true);
  assert.equal(executions,1);assert.equal(runtime.steps.length,4);assert.ok(runtime.steps.every(step=>step.status==='COMPLETED'));
});

test('rule-based planner fills the timetable gaps, skips passed time and names both intents with reasons',()=>{
  const date='2026-09-15';
  const occupied=[{date,start:'09:10',end:'13:30'},{date,start:'13:30',end:'14:30'},{date,start:'17:00',end:'19:00'},{date,start:'20:00',end:'22:10'}];
  const subjects=[{id:'math',name:'수학II',dueCards:0},{id:'bio',name:'생명과학',dueCards:18},{id:'history',name:'한국사',dueCards:4}];
  const result=proposePlans(date,occupied,subjects);
  assert.deepEqual(result.plans.map(plan=>plan.name),['복습 우선','골고루']);
  assert.equal(result.plans[0].reason,'생명과학 복습 카드 18장이 가장 많이 기다려요');
  assert.match(result.plans[1].reason,/과목 3개를 25분씩/);
  const inGaps=(block:{start:string;end:string})=>(block.start>='14:30'&&block.end<='17:00')||(block.start>='19:00'&&block.end<='20:00');
  for(const plan of result.plans){
    assert.ok(plan.blocks.length>0&&plan.blocks.length<=4);
    assert.ok(plan.blocks.every(inGaps),'blocks stay inside the gaps the timetable shows');
    assert.equal(plan.blocks.some(block=>occupied.some(other=>conflict(block,other))),false);
    const sorted=[...plan.blocks].sort((a,b)=>a.start.localeCompare(b.start));
    assert.ok(sorted.every((block,i)=>i===0||Number(block.start.slice(0,2))*60+Number(block.start.slice(3))-(Number(sorted[i-1].end.slice(0,2))*60+Number(sorted[i-1].end.slice(3)))>=10),'at least 10 minutes rest');
  }
  assert.deepEqual(result.plans[0].blocks.slice(0,2).map(block=>block.subjectId),['bio','history'],'most due cards first');
  assert.equal(result.plans[0].blocks[0].title,'생명과학 복습 카드');
  const later=proposePlans(date,occupied,subjects,'15:40');
  for(const plan of later.plans)assert.ok(plan.blocks.every(block=>block.start>='15:40'),'no block starts before the given time');
  const none=proposePlans(date,occupied,[{id:'bio',name:'생명과학',dueCards:0}]);
  assert.equal(none.plans[0].reason,'복습할 카드가 없어서 개념 정리부터 담았어요');
  assert.equal(proposePlans(date,occupied,[{id:'bio',name:'생명과학',dueCards:3}]).plans[0].reason,'생명과학 복습 카드 3장이 기다려요');
  const bare=proposePlans(date,[],[]);
  assert.ok(bare.plans[1].blocks.every(block=>block.title==='자율 학습'&&block.subjectId===undefined&&block.start>='16:00'&&block.end<='22:00'),'without gaps the evening is used');
  const afterSchool=proposePlans(date,[{date,start:'08:30',end:'16:00'}],subjects);
  for(const plan of afterSchool.plans)assert.ok(plan.blocks.length>0&&plan.blocks.every(block=>block.start>='16:00'&&block.end<='22:00'),'the evening after the last schedule is used');
  const evening=proposePlans(date,[{date,start:'08:30',end:'16:00'},{date,start:'18:00',end:'20:00'}],subjects,'18:30');
  for(const plan of evening.plans)assert.ok(plan.blocks.every(block=>block.start>='20:00'&&block.end<='22:00'),'passed windows are skipped and only the evening remains');
  console.log('schedule review planner verified');
});
