import { db } from './db';
import type { User } from './generated/client';
import type { AppData, Profile, Card, Mask } from '../contracts';
import { aiAvailable } from './provider';

export function profile(user: User): Profile {
  const value = user.privacy as Record<string,unknown>;
  return {id:user.id,name:user.name,nickname:user.nickname,role:user.role,school:user.school,grade:user.grade,streak:user.streak,points:user.points,privacy:{accuracy:value.accuracy===true,time:value.time===true,wrongNotes:value.wrongNotes===true},completedSubjects:user.completedSubjects,srsMode:user.srsMode==='FSRS'?'FSRS':'FIXED',desiredRetention:user.desiredRetention};
}
export function asCard({_count,...card}: {id:string;subjectId:string;front:string;back:string;type:Card['type'];bucket:Card['bucket'];consecutiveEasy:number;nextReviewAt:Date;deleted:boolean;image:string|null;masks:unknown;fsrs?:unknown;_count?:{reviews:number}}):Card {
  return {...card,nextReviewAt:card.nextReviewAt.toISOString(),image:card.image??undefined,masks:card.masks as Mask[],fsrs:(card.fsrs??null) as Card['fsrs'],...(_count?{reviewCount:_count.reviews}:{})};
}
export async function selectedChild(parent: User) {
  const link = await db.parentLink.findFirst({where:{parentId:parent.id,...(parent.selectedChildId?{studentId:parent.selectedChildId}:{})},include:{student:true},orderBy:{createdAt:'asc'}});
  return link?.student??null;
}
export async function postsFor(user:User,commented=false) {
  const posts = await db.post.findMany({where:{role:user.role,...(commented?{comments:{some:{userId:user.id}}}:{}),user:{suspended:false,blockedBy:{none:{userId:user.id}},blocks:{none:{blockedId:user.id}}}},include:{user:{select:{nickname:true}},likes:{where:{userId:user.id}},saves:{where:{userId:user.id}},_count:{select:{likes:true,comments:true}}},orderBy:{createdAt:'desc'},take:100});
  return posts.map(post=>({id:post.id,author:post.anonymous?'익명':post.user.nickname,authorId:post.anonymous?'':post.userId,role:post.role,category:post.category,title:post.title,body:post.body,anonymous:post.anonymous,likes:post._count.likes,liked:post.likes.length>0,saved:post.saves.length>0,commentCount:post._count.comments,createdAt:post.createdAt.toISOString()}));
}
export async function bootstrap(user: User): Promise<AppData> {
  const child = user.role==='PARENT' ? await selectedChild(user) : null;
  const learner = user.role==='STUDENT'?user:child;
  const userId = learner?.id??'no-linked-student';
  const filter = {userId,subject:{deleted:false}};
  const [subjects,materials,questions,essays,cards,attempts,schedules,posts,cheers,notifications,reviews] = await Promise.all([
    db.subject.findMany({where:{userId,deleted:false},include:{_count:{select:{materials:true,questions:true,cards:{where:{deleted:false}}}}},orderBy:{createdAt:'asc'}}),
    db.material.findMany({where:filter,orderBy:{createdAt:'desc'}}),db.question.findMany({where:filter}),db.essay.findMany({where:filter}),
    db.card.findMany({where:filter,orderBy:{createdAt:'asc'},include:{_count:{select:{reviews:true}}}}),db.attempt.findMany({where:{userId},orderBy:{createdAt:'desc'},take:1000}),db.schedule.findMany({where:{userId},orderBy:[{date:'asc'},{start:'asc'}]}),
    postsFor(user),db.cheer.findMany({where:user.role==='PARENT'?{senderId:user.id}:{recipientId:user.id},include:{sender:{select:{nickname:true}}},orderBy:{createdAt:'desc'},take:100}),
    db.notification.findMany({where:{userId:user.id},orderBy:{createdAt:'desc'},take:100}),db.cardReview.findMany({where:{userId,createdAt:{gte:new Date(Date.now()-7*86400_000)}},orderBy:{createdAt:'desc'}}),
  ]);
  const dateKey = (date:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(date);
  const today = dateKey(new Date());
  const todayAttempts = attempts.filter(attempt=>dateKey(attempt.createdAt)===today);
  const parent = user.role==='PARENT';
  const privacy = learner?profile(learner).privacy:{accuracy:false,time:false,wrongNotes:false};
  const mayAccuracy = !parent||privacy.accuracy;
  const mayNotes = !parent||(privacy.wrongNotes&&privacy.accuracy);
  const mayTime = !parent||privacy.time;
  const studied = await db.$queryRaw<{day:string}[]>`SELECT DISTINCT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day FROM "Attempt" WHERE "userId"=${userId} UNION SELECT DISTINCT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS day FROM "CardReview" WHERE "userId"=${userId}`;
  const days=new Set(studied.map(item=>item.day));
  let streak=0;
  const start=days.has(today)?0:1;
  for(let offset=start;days.has(dateKey(new Date(Date.now()-offset*86400_000)));offset++)streak++;
  const wrongIds=new Set(attempts.filter(attempt=>!attempt.correct&&attempt.questionId).map(attempt=>attempt.questionId));
  const weekly = Array.from({length:7},(_,index)=>{
    const date = dateKey(new Date(Date.now()-(6-index)*86400_000));
    return attempts.filter(attempt=>dateKey(attempt.createdAt)===date).length+reviews.filter(review=>dateKey(review.createdAt)===date).length;
  });
  return {
    profile:{...profile(user),...(user.role==='STUDENT'?{streak}:{})}, child:child?{...profile(child),streak:mayTime?streak:0}:undefined,
    subjects:subjects.map(subject=>({id:subject.id,name:subject.name,icon:subject.icon,semester:subject.semester,color:subject.color,materialCount:subject._count.materials,questionCount:subject._count.questions,cardCount:subject._count.cards,...(subject.examDate?{examDate:subject.examDate,examName:subject.examName??'시험'}:{})})),
    materials:parent?[]:materials.map(material=>({...material,url:material.url??undefined,createdAt:material.createdAt.toISOString()})),
    questions:mayNotes?(parent?questions.filter(question=>wrongIds.has(question.id)):questions):[],essays:parent?[]:essays,cards:parent?[]:cards.map(asCard),
    attempts:mayNotes?attempts.map(attempt=>({...attempt,questionId:attempt.questionId??undefined,essayId:attempt.essayId??undefined,createdAt:attempt.createdAt.toISOString()})):[],
    schedules:mayTime?schedules.map(schedule=>({...schedule,subjectId:schedule.subjectId??undefined})):[],posts,
    cheers:cheers.map(({sender,...cheer})=>({...cheer,senderName:sender.nickname,createdAt:cheer.createdAt.toISOString()})),notifications:notifications.map(item=>({...item,createdAt:item.createdAt.toISOString()})),
    stats:{yesterdayCards:mayTime?reviews.filter(review=>dateKey(review.createdAt)===dateKey(new Date(Date.now()-86400_000))).length:0,todayCards:reviews.filter(review=>dateKey(review.createdAt)===today).length,todayQuestions:todayAttempts.filter(attempt=>attempt.questionId).length,accuracy:mayAccuracy&&attempts.length?Math.round(attempts.filter(attempt=>attempt.correct).length/attempts.length*100):0,studyMinutes:mayTime?schedules.filter(schedule=>schedule.date===today&&schedule.done).reduce((sum,schedule)=>{const start=schedule.start.split(':').map(Number);const end=schedule.end.split(':').map(Number);return sum+(end[0]*60+end[1])-(start[0]*60+start[1]);},0):0,weekly:mayTime?weekly:[]},
    aiAvailable:aiAvailable(),demo:process.env.DEMO_MODE==='true',
  };
}
