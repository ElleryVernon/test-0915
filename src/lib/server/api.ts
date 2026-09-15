import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { db } from './db';
import { ApiError } from './errors';
import { createSession,currentUser,protectMutation,readSessionToken,requireRole,SESSION_COOKIE,tokenHash } from './auth';
import { asCard,bootstrap,postsFor,profile,selectedChild } from './bootstrap';
import { conflict,gradeEssay,proposePlans,validDate } from './algorithms';
import { generateItems,gradeWithAi,planWithAi } from './ai';
import { seedDemo,DEMO_STUDENT,DEMO_PARENT,DEMO_ADMIN } from '../../../prisma/seed';
import { Prisma, type User } from './generated/client';
import { handleUpload, readUpload } from './uploads';
import { configuredProviders } from '../oauth';
import { scheduleCard } from '../srs';
import { aiAvailable } from './provider';
import { executeAiRun,readAiRun } from './ai-runs';
import { runTypedSkill } from './skill-runtime';

const id=z.string().min(1).max(100);
const text=(max=2000)=>z.string().trim().min(1,'내용을 입력해 주세요.').max(max);
const date=z.string().refine(validDate,'올바른 날짜를 입력해 주세요.');
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/,'시간 형식을 확인해 주세요.');
const privacySchema=z.object({accuracy:z.boolean(),time:z.boolean(),wrongNotes:z.boolean()});
const jsonHeaders={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const ok=(data:unknown,status=200,headers:Record<string,string>={})=>Response.json({data},{status,headers:{...jsonHeaders,...headers}});
async function body<T>(request:Request,schema:z.ZodType<T>):Promise<T> {
  if (Number(request.headers.get('content-length')??0)>3_000_000) throw new ApiError(413,'입력 내용이 너무 커요.');
  let value:unknown;
  const raw=await request.text();
  if(raw.length>3_000_000)throw new ApiError(413,'입력 내용이 너무 커요.');
  try { value=JSON.parse(raw); } catch { throw new ApiError(400,'요청 내용을 읽을 수 없어요.'); }
  const result=schema.safeParse(value);
  if (!result.success) throw new ApiError(400,result.error.issues[0]?.message??'입력값을 확인해 주세요.');
  return result.data;
}
async function ownedSubject(user:User,subjectId:string) {
  const subject=await db.subject.findFirst({where:{id:subjectId,userId:user.id,deleted:false}});
  if(!subject)throw new ApiError(404,'과목을 찾을 수 없어요.');return subject;
}
async function accessiblePost(user:User,postId:string) {
  const post=await db.post.findUnique({where:{id:postId},include:{user:true}});
  if(!post)throw new ApiError(404,'게시글을 찾을 수 없어요.');
  requireRole(user,post.role);
  if(post.user.suspended||await db.block.findFirst({where:{OR:[{userId:user.id,blockedId:post.userId},{userId:post.userId,blockedId:user.id}]}}))throw new ApiError(404,'게시글을 찾을 수 없어요.');
  return post;
}
async function peer(user:User,userId:string) {
  const other=await db.user.findUnique({where:{id:userId}});
  if(!other||other.role!==user.role||other.suspended||userId===user.id)throw new ApiError(404,'사용자를 찾을 수 없어요.');
  if(await db.block.findFirst({where:{OR:[{userId:user.id,blockedId:userId},{userId,blockedId:user.id}]}}))throw new ApiError(403,'차단된 사용자와 소통할 수 없어요.');
  return other;
}
async function locked<T>(userId:string,fn:(tx:Prisma.TransactionClient)=>Promise<T>) {
  return db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId} FOR UPDATE`;return fn(tx);},{timeout:15_000});
}
function providers() {
  return configuredProviders();
}

export async function handleApi(request:Request) {
  try {
    protectMutation(request);
    const url=new URL(request.url);
    const parts=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean);
    const [resource,resourceId,action]=parts;
    const method=request.method;
    if(resource==='health'&&method==='GET') {
      try {await db.$queryRaw`SELECT 1`;return ok({status:'ok',database:'connected'});}catch{return Response.json({error:'데이터베이스에 연결하지 못했어요.'},{status:503,headers:jsonHeaders});}
    }
    if(resource==='config'&&method==='GET')return ok({demo:process.env.DEMO_MODE==='true',providers:providers()});
    if(resource==='session'&&method==='POST') {
      if(process.env.DEMO_MODE!=='true')throw new ApiError(403,'데모 로그인이 비활성화되어 있어요. 소셜 로그인을 이용해 주세요.');
      const {role}=await body(request,z.object({role:z.enum(['STUDENT','PARENT','ADMIN'])}));
      if(role==='ADMIN'&&process.env.DEMO_ADMIN!=='true')throw new ApiError(403,'관리자 데모 로그인이 비활성화되어 있어요.');
      await seedDemo();
      const userId=role==='PARENT'?DEMO_PARENT:role==='ADMIN'?DEMO_ADMIN:DEMO_STUDENT;
      const user=await db.user.findUniqueOrThrow({where:{id:userId}});
      if(user.suspended)throw new ApiError(403,'이용이 제한된 계정이에요.');
      const previous=readSessionToken(request);
      if(previous)await db.session.deleteMany({where:{id:tokenHash(previous)}});
      return ok(profile(user),200,{'Set-Cookie':await createSession(userId,request)});
    }
    if(resource==='logout'&&method==='POST') {
      const token=readSessionToken(request);
      if(token)await db.session.deleteMany({where:{id:tokenHash(token)}});
      return ok({loggedOut:true},200,{'Set-Cookie':`${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`});
    }
    const user=await currentUser(request);
    if(resource==='ai-runs'&&resourceId&&method==='GET')return ok(await readAiRun(user.id,resourceId));
    if(resource==='bootstrap'&&method==='GET')return ok(await bootstrap(user));
    if(resource==='upload'&&method==='POST') { requireRole(user,'STUDENT');return ok(await handleUpload(request,user)); }
    if(resource==='uploads'&&resourceId&&method==='GET')return await readUpload(resourceId,user);
    if(resource==='subjects') {
      requireRole(user,'STUDENT');
      if(method==='POST') {
        const input=await body(request,z.object({name:text(60),examName:z.string().trim().max(20).nullable().optional(),examDate:date.nullable().optional()}));
        return ok(await db.subject.create({data:{name:input.name,...(input.examDate?{examDate:input.examDate,examName:input.examName||null}:{}),userId:user.id}}),201);
      }
      if(resourceId) {
        await ownedSubject(user,resourceId);
        if(method==='PATCH') {
          const input=await body(request,z.object({name:text(60).optional(),examName:z.string().trim().max(20).nullable().optional(),examDate:date.nullable().optional()}).refine(value=>Object.values(value).some(field=>field!==undefined),'바꿀 내용을 입력해 주세요.'));
          // An empty name keeps the date and falls back to "시험" when read; a null date clears both.
          const exam=input.examDate===null?{examDate:null,examName:null}:{...(input.examDate?{examDate:input.examDate}:{}),...(input.examName!==undefined?{examName:input.examName||null}:{})};
          return ok(await db.subject.update({where:{id:resourceId},data:{...(input.name?{name:input.name}:{}),...exam}}));
        }
        if(method==='DELETE')return ok(await db.subject.update({where:{id:resourceId},data:{deleted:true}}));
      }
    }
    if(resource==='materials') {
      requireRole(user,'STUDENT');
      if(method==='POST') {
        const input=await body(request,z.object({subjectId:id,title:text(200),content:z.string().max(200_000),type:z.enum(['TXT','PDF','IMAGE','txt','pdf','image']),url:z.string().max(2000).optional()}));
        await ownedSubject(user,input.subjectId);
        if(input.url&&!input.url.startsWith('/api/uploads/'))throw new ApiError(400,'이 앱에 업로드한 자료만 연결할 수 있어요.');
        if(input.url&&!await db.upload.findFirst({where:{id:input.url.split('/').pop(),userId:user.id}}))throw new ApiError(404,'업로드한 자료를 찾을 수 없어요.');
        return ok(await db.material.create({data:{...input,type:input.type.toUpperCase(),userId:user.id}}),201);
      }
      const material=resourceId?await db.material.findFirst({where:{id:resourceId,userId:user.id,subject:{deleted:false}}}):null;
      if(!material)throw new ApiError(404,'자료를 찾을 수 없어요.');
      if(method==='PATCH')return ok(await db.material.update({where:{id:material.id},data:await body(request,z.object({title:text(200).optional(),content:z.string().max(200_000).optional()}))}));
      if(method==='DELETE'){await db.material.delete({where:{id:material.id}});return ok({deleted:true});}
    }
    if(resource==='generate'&&method==='POST') {
      requireRole(user,'STUDENT');
      const schema=z.object({materialId:id,count:z.number().int().min(1).max(10),mode:z.enum(['quiz','essay','cards'])});
      const {requestId,...input}=await body(request,schema.extend({requestId:z.string().uuid().optional()}));
      const run=await executeAiRun({userId:user.id,requestId,kind:input.mode,input},async execution=>{
        const material=await execution.runtime.tool('LOAD_CONTEXT',input,schema,async value=>{
          const material=await db.material.findFirst({where:{id:value.materialId,userId:user.id,subject:{deleted:false}}});
          if(!material)throw new ApiError(404,'자료를 찾을 수 없어요.');
          if(material.content.trim().length<20)throw new ApiError(400,'학습 자료에 본문을 20자 이상 추가해 주세요.');
          return material;
        });
        const items=await generateItems(material.content,input.mode,input.count);
        return execution.commit(async tx=>{
        const currentMaterial=await tx.material.findFirst({where:{id:material.id,userId:user.id,subject:{deleted:false}},select:{content:true,subjectId:true}});
        if(!currentMaterial||currentMaterial.content!==material.content||currentMaterial.subjectId!==material.subjectId)throw new ApiError(409,'생성 중 학습 자료가 변경됐어요. 최신 자료를 확인하고 다시 시도해 주세요.');
        const created=[];
        for(const item of items) {
          const base={userId:user.id,subjectId:material.subjectId,materialId:material.id};
          if('options' in item)created.push(await tx.question.create({data:{...base,...item}}));
          else if('keywords' in item)created.push(await tx.essay.create({data:{...base,...item}}));
          else created.push(await tx.card.create({data:{userId:user.id,subjectId:material.subjectId,front:item.front,back:`${item.back}\n\n근거: ${item.citation}`,type:item.type}}));
        }
        return created;
        });
      });
      return ok(run.result,201,{'X-AI-Request-Id':run.requestId});
    }
    if(resource==='quiz'&&resourceId==='answer'&&method==='POST') {
      requireRole(user,'STUDENT');
      const input=await body(request,z.object({questionId:id,answer:z.number().int().min(-1).max(4)}));
      const question=await db.question.findFirst({where:{id:input.questionId,userId:user.id,subject:{deleted:false}}});
      if(!question)throw new ApiError(404,'문제를 찾을 수 없어요.');
      const correct=input.answer===question.answer;
      await db.attempt.create({data:{userId:user.id,questionId:question.id,answer:String(input.answer),correct,score:correct?100:0}});
      return ok({correct,explanation:question.explanation,citation:question.citation});
    }
    if(resource==='essay'&&resourceId==='submit'&&method==='POST') {
      requireRole(user,'STUDENT');
      const schema=z.object({essayId:id,answer:text(10_000)});
      const {requestId,...input}=await body(request,schema.extend({requestId:z.string().uuid().optional()}));
      const run=await executeAiRun({userId:user.id,requestId,kind:'grade',input},async execution=>{
        const essay=await execution.runtime.tool('LOAD_CONTEXT',input,schema,async value=>{
          const essay=await db.essay.findFirst({where:{id:value.essayId,userId:user.id,subject:{deleted:false}}});
          if(!essay)throw new ApiError(404,'문제를 찾을 수 없어요.');return essay;
        });
        const result=aiAvailable()?await gradeWithAi({prompt:essay.prompt,keywords:essay.keywords,modelAnswer:essay.modelAnswer,citation:essay.citation,answer:input.answer}):await runTypedSkill('grade',input,schema,()=>({...gradeEssay(input.answer,essay.keywords,essay.modelAnswer),method:'키워드·순서 기반 연습 채점'}),value=>z.object({score:z.number().int().min(0).max(100),matched:z.array(z.string()),missing:z.array(z.string()),feedback:z.string(),method:z.string()}).parse(value));
        return execution.commit(async tx=>{
          await tx.attempt.create({data:{userId:user.id,essayId:essay.id,answer:input.answer,correct:result.score===100,score:result.score}});
          return result;
        });
      });
      return ok(run.result,200,{'X-AI-Request-Id':run.requestId});
    }
    if(resource==='cards') {
      requireRole(user,'STUDENT');
      if(resourceId==='review'&&method==='POST') {
        const input=await body(request,z.object({cardId:id,rating:z.enum(['EASY','GOOD','HARD','AGAIN']),reviewId:z.string().uuid(),reviewedAt:z.number().int().positive().optional(),mode:z.enum(['FIXED','FSRS']).optional(),retention:z.number().min(.8).max(.97).optional()}));
        const result=await locked(user.id,async tx=>{
          const previous=await tx.cardReview.findUnique({where:{id:input.reviewId}});
          if(previous){if(previous.userId!==user.id||previous.cardId!==input.cardId||previous.rating!==input.rating)throw new ApiError(409,'이미 다른 복습에 사용된 요청이에요.');return previous.result;}
          const card=await tx.card.findFirst({where:{id:input.cardId,userId:user.id,deleted:false,subject:{deleted:false}}});
          if(!card)throw new ApiError(404,'카드를 찾을 수 없어요.');
          const now=Date.now();
          const reviewedAt=input.reviewedAt??now;
          if(reviewedAt>now+300_000||reviewedAt<now-30*86400_000)throw new ApiError(400,'복습 시간이 유효하지 않아요. 30일 이내 기록만 동기화할 수 있어요.');
          const current=asCard(card);
          if(current.fsrs?.last_review&&reviewedAt<Date.parse(current.fsrs.last_review))throw new ApiError(409,'이미 동기화된 복습보다 이전 기록이에요. 최신 카드를 확인해 주세요.');
          const lastEvent=await tx.cardReview.findFirst({where:{cardId:card.id,userId:user.id},orderBy:{createdAt:'desc'},select:{createdAt:true}});
          if(lastEvent&&reviewedAt<lastEvent.createdAt.getTime())throw new ApiError(409,'이미 동기화된 복습보다 이전 기록이에요. 최신 카드를 확인해 주세요.');
          const preferences=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{srsMode:true,desiredRetention:true}});
          const scheduled=scheduleCard(current,input.rating,input.mode??(preferences.srsMode==='FSRS'?'FSRS':'FIXED'),input.retention??preferences.desiredRetention,reviewedAt);
          const next=await tx.card.update({where:{id:card.id},data:{bucket:scheduled.bucket,consecutiveEasy:scheduled.consecutiveEasy,nextReviewAt:new Date(scheduled.nextReviewAt),fsrs:scheduled.fsrs?JSON.parse(JSON.stringify(scheduled.fsrs)):Prisma.DbNull}});
          const result=asCard(next);
          await tx.cardReview.create({data:{id:input.reviewId,userId:user.id,cardId:card.id,rating:input.rating,result:JSON.parse(JSON.stringify(result)),createdAt:new Date(reviewedAt)}});
          return result;
        });
        return ok(result);
      }
      if(method==='POST'&&!resourceId) {
        const input=await body(request,z.object({subjectId:id,front:text(2000),back:text(4000),type:z.enum(['CONCEPT','RELATION','COMPARISON','BLIND']),image:z.string().max(2_000_000).optional(),masks:z.array(z.object({x:z.number().min(0).max(100),y:z.number().min(0).max(100),width:z.number().positive().max(100),height:z.number().positive().max(100)}).refine(mask=>mask.x+mask.width<=100.1&&mask.y+mask.height<=100.1)).max(100).optional()}));
        await ownedSubject(user,input.subjectId);
        if(input.image&&!/^data:image\/(png|jpeg|webp);base64,/.test(input.image)&&!input.image.startsWith('/api/uploads/'))throw new ApiError(400,'허용되지 않는 이미지 형식이에요.');
        if(input.image?.startsWith('/api/uploads/')&&!await db.upload.findFirst({where:{id:input.image.split('/').pop(),userId:user.id,mime:{startsWith:'image/'}}}))throw new ApiError(404,'업로드한 이미지를 찾을 수 없어요.');
        if(input.type==='BLIND'&&(!input.image||!input.masks?.length))throw new ApiError(400,'이미지와 가림막을 추가해 주세요.');
        return ok(asCard(await db.card.create({data:{...input,userId:user.id}})),201);
      }
      if(resourceId&&method==='PATCH') {
        const input=await body(request,z.object({deleted:z.boolean().optional(),front:text(2000).optional(),back:text(4000).optional()}));
        const card=await db.card.findFirst({where:{id:resourceId,userId:user.id,subject:{deleted:false}}});
        if(!card)throw new ApiError(404,'카드를 찾을 수 없어요.');
        return ok(asCard(await db.card.update({where:{id:resourceId},data:input})));
      }
    }
    if(resource==='wrong-notes'&&resourceId==='cards'&&method==='POST') {
      requireRole(user,'STUDENT');
      const input=await body(request,z.object({questionIds:z.array(id).min(1).max(100)}));
      const uniqueIds=[...new Set(input.questionIds)];
      const questions=await db.question.findMany({where:{id:{in:uniqueIds},userId:user.id,subject:{deleted:false},attempts:{some:{userId:user.id,correct:false}}}});
      if(questions.length!==uniqueIds.length)throw new ApiError(404,'복습할 오답을 찾을 수 없어요.');
      return ok(await db.$transaction(questions.map(question=>db.card.upsert({where:{userId_sourceQuestionId:{userId:user.id,sourceQuestionId:question.id}},create:{userId:user.id,subjectId:question.subjectId,front:question.prompt,back:`${question.options[question.answer]}\n\n${question.explanation}`,sourceQuestionId:question.id},update:{deleted:false}}))));
    }
    if(resource==='schedules') {
      requireRole(user,'STUDENT');
      if(method==='DELETE'&&resourceId){const result=await db.schedule.deleteMany({where:{id:resourceId,userId:user.id}});if(!result.count)throw new ApiError(404,'일정을 찾을 수 없어요.');return ok({deleted:true});}
      if(method==='POST'||method==='PATCH') {
        const schema=z.object({title:text(100),date,start:time,end:time,kind:z.enum(['FIXED','FLEXIBLE']),subjectId:id.optional(),done:z.boolean().optional()});
        const input=await body(request,method==='PATCH'?schema.partial():schema);
        if(input.subjectId)await ownedSubject(user,input.subjectId);
        const result=await locked(user.id,async tx=>{
          const existing=resourceId?await tx.schedule.findFirst({where:{id:resourceId,userId:user.id}}):null;
          if(method==='PATCH'&&!existing)throw new ApiError(404,'일정을 찾을 수 없어요.');
          const merged={...existing,...input,userId:user.id};
          if(!merged.title||!merged.date||!merged.start||!merged.end||!merged.kind)throw new ApiError(400,'일정 정보를 모두 입력해 주세요.');
          if(merged.start>=merged.end)throw new ApiError(400,'종료 시간은 시작 시간 이후여야 해요.');
          const others=await tx.schedule.findMany({where:{userId:user.id,date:merged.date,...(resourceId?{id:{not:resourceId}}:{})}});
          if(others.some(other=>conflict({date:merged.date!,start:merged.start!,end:merged.end!},other)))throw new ApiError(409,'기존 일정과 시간이 겹쳐요. 다른 시간을 골라 주세요.');
          const data={title:merged.title,date:merged.date,start:merged.start,end:merged.end,kind:merged.kind,subjectId:merged.subjectId,done:merged.done??false};
          return existing?tx.schedule.update({where:{id:existing.id},data}):tx.schedule.create({data:{...data,userId:user.id}});
        });
        return ok(result,method==='POST'?201:200);
      }
    }
    if(resource==='planner'&&resourceId==='suggest'&&method==='POST') {
      requireRole(user,'STUDENT');
      const schema=z.object({date});
      const {requestId,...input}=await body(request,schema.extend({requestId:z.string().uuid().optional()}));
      const run=await executeAiRun({userId:user.id,requestId,kind:'planner',input},async execution=>{
        const [schedules,subjects]=await execution.runtime.tool('LOAD_CONTEXT',input,schema,()=>Promise.all([db.schedule.findMany({where:{userId:user.id,date:input.date}}),db.subject.findMany({where:{userId:user.id,deleted:false}})]));
        const result=aiAvailable()?await planWithAi(input.date,schedules,subjects):await runTypedSkill('planner',input,schema,()=>({...proposePlans(input.date,schedules,subjects),method:'규칙 기반 일정 추천'}),value=>z.object({plans:z.array(z.object({name:z.string(),blocks:z.array(z.object({title:z.string(),date,start:time,end:time,kind:z.enum(['FIXED','FLEXIBLE']),subjectId:id.optional(),done:z.boolean()}))})),method:z.string()}).parse(value));
        return execution.commit(async()=>result);
      });
      return ok(run.result,200,{'X-AI-Request-Id':run.requestId});
    }
    if(resource==='posts') {
      requireRole(user,'STUDENT','PARENT');
      if(method==='GET'&&!resourceId){const role=url.searchParams.get('role');if(role&&role!==user.role)throw new ApiError(403,'다른 역할의 커뮤니티에 접근할 수 없어요.');return ok(await postsFor(user,url.searchParams.get('commented')==='1'));}
      if(method==='POST'&&!resourceId){const input=await body(request,z.object({title:text(120),body:text(10_000),category:text(30),anonymous:z.boolean()}));return ok(await db.post.create({data:{...input,userId:user.id,role:user.role}}),201);}
      if(resourceId) {
        await accessiblePost(user,resourceId);
        if((action==='like'||action==='save')&&method==='POST') {
          const key={userId:user.id,postId:resourceId};
          const result=await locked(user.id,async tx=>{
            if(action==='like'){const prior=await tx.postLike.findUnique({where:{userId_postId:key}});if(prior)await tx.postLike.delete({where:{userId_postId:key}});else await tx.postLike.create({data:key});return {liked:!prior};}
            const prior=await tx.postSave.findUnique({where:{userId_postId:key}});if(prior)await tx.postSave.delete({where:{userId_postId:key}});else await tx.postSave.create({data:key});return {saved:!prior};
          });return ok(result);
        }
        if(action==='comments') {
          if(method==='GET'){const comments=await db.comment.findMany({where:{postId:resourceId,user:{suspended:false,blockedBy:{none:{userId:user.id}},blocks:{none:{blockedId:user.id}}}},include:{user:{select:{nickname:true}}},orderBy:{createdAt:'asc'},take:500});return ok(comments.map(comment=>({id:comment.id,postId:comment.postId,author:comment.user.nickname,body:comment.body,parentId:comment.parentId??undefined,createdAt:comment.createdAt.toISOString()})));}
          if(method==='POST') {
            const input=await body(request,z.object({body:text(2000),parentId:id.optional()}));
            if(input.parentId&&!await db.comment.findFirst({where:{id:input.parentId,postId:resourceId,parentId:null}}))throw new ApiError(400,'댓글은 한 단계까지만 답글을 달 수 있어요.');
            return ok(await db.comment.create({data:{...input,postId:resourceId,userId:user.id}}),201);
          }
        }
      }
    }
    if(resource==='reports'&&method==='POST') {
      const input=await body(request,z.object({postId:id,reason:text(1000)}));await accessiblePost(user,input.postId);
      return ok(await db.report.upsert({where:{userId_postId:{userId:user.id,postId:input.postId}},create:{...input,userId:user.id},update:{reason:input.reason,status:'OPEN'}}));
    }
    if(resource==='blocks') {
      requireRole(user,'STUDENT','PARENT');
      if(method==='POST'){const input=await body(request,z.object({userId:id}));await peer(user,input.userId);await db.block.upsert({where:{userId_blockedId:{userId:user.id,blockedId:input.userId}},create:{userId:user.id,blockedId:input.userId},update:{}});return ok({blocked:true});}
      if(method==='DELETE'&&resourceId){await db.block.deleteMany({where:{userId:user.id,blockedId:resourceId}});return ok({blocked:false});}
    }
    if(resource==='profile'&&method==='PATCH') {
      const input=await body(request,z.object({name:text(50).optional(),nickname:text(30).optional(),school:z.string().max(100).optional(),grade:z.enum(['고1','고2','고3','N수/기타','기타','']).optional(),privacy:privacySchema.optional(),completedSubjects:z.array(text(60)).max(100).optional(),srsMode:z.enum(['FIXED','FSRS']).optional(),desiredRetention:z.number().min(.8).max(.97).optional()}));
      return ok(profile(await db.user.update({where:{id:user.id},data:input})));
    }
    if(resource==='invite'&&method==='POST') {
      requireRole(user,'STUDENT');
      const result=await locked(user.id,async tx=>{
        await tx.invite.deleteMany({where:{OR:[{studentId:user.id},{expiresAt:{lt:new Date()}}]}});
        let code=String(randomInt(100000,1000000));
        while(await tx.invite.findUnique({where:{code}}))code=String(randomInt(100000,1000000));
        const expiresAt=new Date(Date.now()+600_000);
        await tx.invite.create({data:{code,studentId:user.id,expiresAt}});return {code,expiresAt:expiresAt.toISOString()};
      });return ok(result);
    }
    if(resource==='link'&&method==='POST') {
      requireRole(user,'PARENT');const input=await body(request,z.object({code:z.string().regex(/^\d{6}$/,'6자리 숫자를 입력해 주세요.')}));
      const result=await locked(user.id,async tx=>{
        const parent=await tx.user.findUniqueOrThrow({where:{id:user.id}});
        if(parent.linkLockedUntil&&parent.linkLockedUntil>new Date())return {error:'5회 확인에 실패했어요. 30분 후 다시 시도해 주세요.',status:429};
        const invite=await tx.invite.findUnique({where:{code:input.code},include:{student:true}});
        if(!invite||invite.expiresAt<=new Date()||invite.student.suspended) {
          const failures=(parent.linkLockedUntil?0:parent.linkFailures)+1;
          await tx.user.update({where:{id:user.id},data:{linkFailures:failures,linkLockedUntil:failures>=5?new Date(Date.now()+1800_000):null}});
          return {error:failures>=5?'5회 확인에 실패했어요. 30분 후 다시 시도해 주세요.':'유효하지 않거나 만료된 코드예요.',status:failures>=5?429:400};
        }
        const consumed=await tx.invite.deleteMany({where:{code:input.code,expiresAt:{gt:new Date()}}});
        if(!consumed.count)return {error:'이미 사용된 코드예요.',status:400};
        await tx.parentLink.upsert({where:{parentId_studentId:{parentId:user.id,studentId:invite.studentId}},create:{parentId:user.id,studentId:invite.studentId},update:{}});
        await tx.user.update({where:{id:user.id},data:{linkFailures:0,linkLockedUntil:null,selectedChildId:invite.studentId}});
        return {child:profile(invite.student)};
      });
      if('error' in result)throw new ApiError(result.status!,result.error!);return ok(result);
    }
    if(resource==='children') {
      requireRole(user,'PARENT');
      if(method==='GET'){const links=await db.parentLink.findMany({where:{parentId:user.id},include:{student:true},orderBy:{createdAt:'asc'}});return ok(links.map((link,index)=>({...profile(link.student),selected:user.selectedChildId?user.selectedChildId===link.studentId:index===0})));}
      if(method==='POST'&&resourceId==='select'){const input=await body(request,z.object({childId:id}));if(!await db.parentLink.findUnique({where:{parentId_studentId:{parentId:user.id,studentId:input.childId}}}))throw new ApiError(404,'연결된 자녀를 찾을 수 없어요.');await db.user.update({where:{id:user.id},data:{selectedChildId:input.childId}});return ok({selected:true});}
      if(method==='DELETE'&&resourceId){await db.parentLink.deleteMany({where:{parentId:user.id,studentId:resourceId}});if(user.selectedChildId===resourceId)await db.user.update({where:{id:user.id},data:{selectedChildId:null}});return ok({deleted:true});}
    }
    if(resource==='parent-stats'&&method==='GET') {
      requireRole(user,'PARENT');const child=await selectedChild(user);
      if(!child)return ok({subjectStats:[],masteredCards:0,weeklyQuestions:0,studyDays:0});
      const now=new Date();const kstDate=new Date(now.getTime()+9*3600_000);const weekday=kstDate.getUTCDay();
      const weekStart=new Date(Date.UTC(kstDate.getUTCFullYear(),kstDate.getUTCMonth(),kstDate.getUTCDate()-(weekday+6)%7)-9*3600_000);
      const [masteredCards,weekAttempts,weekReviews]=await Promise.all([db.card.count({where:{userId:child.id,bucket:'MASTERED',deleted:false,subject:{deleted:false}}}),db.attempt.findMany({where:{userId:child.id,createdAt:{gte:weekStart}},select:{createdAt:true,questionId:true}}),db.cardReview.findMany({where:{userId:child.id,createdAt:{gte:weekStart}},select:{createdAt:true}})]);
      const summary={masteredCards,weeklyQuestions:weekAttempts.filter(attempt=>attempt.questionId).length,studyDays:profile(child).privacy.time?new Set([...weekAttempts,...weekReviews].map(item=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(item.createdAt))).size:0};
      if(!profile(child).privacy.accuracy)return ok({subjectStats:[],...summary});
      const subjects=await db.subject.findMany({where:{userId:child.id,deleted:false},include:{questions:{include:{attempts:{where:{userId:child.id}}}}}});
      return ok({...summary,subjectStats:subjects.map(subject=>{const attempts=subject.questions.flatMap(question=>question.attempts);return {id:subject.id,name:subject.name,count:attempts.length,accuracy:attempts.length?Math.round(attempts.filter(attempt=>attempt.correct).length/attempts.length*100):0};})});
    }
    if(resource==='cheers') {
      if(method==='POST') {
        requireRole(user,'PARENT');const input=await body(request,z.object({message:text(500),points:z.number().int().min(0).max(10000)}));
        const child=await selectedChild(user);if(!child)throw new ApiError(400,'먼저 자녀를 연결해 주세요.');
        const result=await locked(user.id,async tx=>{
          const parent=await tx.user.findUniqueOrThrow({where:{id:user.id}});
          if(parent.points<input.points)throw new ApiError(400,'보유 포인트가 부족해요.');
          await tx.user.update({where:{id:user.id},data:{points:{decrement:input.points}}});
          await tx.user.update({where:{id:child.id},data:{points:{increment:input.points}}});
          await tx.notification.create({data:{userId:child.id,title:'응원이 도착했어요 🧡',body:input.message,href:'/cheer'}});
          return tx.cheer.create({data:{...input,senderId:user.id,recipientId:child.id}});
        });return ok(result,201);
      }
      if(method==='PATCH'&&resourceId){requireRole(user,'STUDENT');await body(request,z.object({thanked:z.literal(true)}));const updated=await db.cheer.updateMany({where:{id:resourceId,recipientId:user.id},data:{thanked:true}});if(!updated.count)throw new ApiError(404,'응원을 찾을 수 없어요.');return ok({thanked:true});}
    }
    if(resource==='notifications'&&method==='PATCH'){await body(request,z.object({read:z.literal(true)}));await db.notification.updateMany({where:{userId:user.id},data:{read:true}});return ok({read:true});}
    if(resource==='social'&&method==='GET') {
      requireRole(user,'STUDENT','PARENT');
      const fields={id:true,nickname:true};
      const [followers,following,users,blocked,posts,comments]=await Promise.all([db.follow.findMany({where:{followingId:user.id},include:{follower:{select:fields}}}),db.follow.findMany({where:{followerId:user.id},include:{following:{select:fields}}}),db.user.findMany({where:{role:user.role,id:{not:user.id},suspended:false,blockedBy:{none:{userId:user.id}},blocks:{none:{blockedId:user.id}}},select:fields,take:100}),db.block.findMany({where:{userId:user.id},include:{blocked:{select:fields}}}),db.post.count({where:{userId:user.id}}),db.comment.count({where:{userId:user.id}})]);
      return ok({followers:followers.map(item=>item.follower),following:following.map(item=>item.following),users,blocked:blocked.map(item=>item.blocked),counts:{posts,comments,followers:followers.length,following:following.length}});
    }
    if(resource==='follow'&&method==='POST') {
      const input=await body(request,z.object({userId:id}));await peer(user,input.userId);
      return ok(await locked(user.id,async tx=>{const key={followerId:user.id,followingId:input.userId};const previous=await tx.follow.findUnique({where:{followerId_followingId:key}});if(previous)await tx.follow.delete({where:{followerId_followingId:key}});else await tx.follow.create({data:key});return {following:!previous};}));
    }
    if(resource==='messages') {
      requireRole(user,'STUDENT','PARENT');
      if(method==='GET'){const userId=url.searchParams.get('userId')??'';await peer(user,userId);return ok(await db.message.findMany({where:{OR:[{senderId:user.id,recipientId:userId},{senderId:userId,recipientId:user.id}]},orderBy:{createdAt:'asc'},take:200}));}
      if(method==='POST'){const input=await body(request,z.object({userId:id,body:text(3000)}));await peer(user,input.userId);return ok(await db.message.create({data:{senderId:user.id,recipientId:input.userId,body:input.body}}),201);}
    }
    if(resource==='schools'&&method==='GET')return ok(await db.school.findMany({where:{name:{contains:(url.searchParams.get('q')??'').slice(0,100),mode:'insensitive'}},orderBy:{name:'asc'},take:30}));
    if(resource==='admin') {
      requireRole(user,'ADMIN');
      if(method==='GET'&&!resourceId){const [users,reports,schools]=await Promise.all([db.user.findMany({select:{id:true,name:true,nickname:true,role:true,suspended:true},orderBy:{createdAt:'desc'},take:500}),db.report.findMany({include:{post:{select:{title:true}}},orderBy:{createdAt:'desc'},take:500}),db.school.findMany({orderBy:{name:'asc'},take:1000})]);return ok({users,reports:reports.map(report=>({...report,postTitle:report.post.title,createdAt:report.createdAt.toISOString()})),schools});}
      if(resourceId==='reports'&&action&&method==='PATCH')return ok(await db.report.update({where:{id:action},data:await body(request,z.object({status:z.enum(['OPEN','RESOLVED','DISMISSED'])}))}));
      if(resourceId==='users'&&action&&method==='PATCH'){if(action===user.id)throw new ApiError(400,'자신의 계정은 제한할 수 없어요.');const input=await body(request,z.object({suspended:z.boolean()}));return ok(await db.user.update({where:{id:action},data:input,select:{id:true,suspended:true}}));}
      if(resourceId==='schools'&&method==='POST')return ok(await db.school.create({data:await body(request,z.object({name:text(100)}))}),201);
    }
    throw new ApiError(404,'요청한 기능을 찾을 수 없어요.');
  } catch(error) {
    if(error instanceof ApiError)return Response.json({error:error.message},{status:error.status,headers:jsonHeaders});
    if(error instanceof Error&&'code' in error){const code=(error as {code:string}).code;if(code==='P2002')return Response.json({error:'이미 사용 중인 값이에요.'},{status:409,headers:jsonHeaders});if(code==='P2025')return Response.json({error:'대상을 찾을 수 없어요.'},{status:404,headers:jsonHeaders});}
    console.error('[memoryz-api]',error instanceof Error?error.name:'UnknownError');
    return Response.json({error:'요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.'},{status:500,headers:jsonHeaders});
  }
}
