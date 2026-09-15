export type Role = 'STUDENT' | 'PARENT' | 'ADMIN';
export type Bucket = 'AGAIN' | 'HARD' | 'GOOD' | 'EASY' | 'MASTERED';
export type CardType = 'CONCEPT' | 'RELATION' | 'COMPARISON' | 'BLIND';
export interface Profile {
  srsMode?: 'FIXED' | 'FSRS';
  desiredRetention?: number;
  id: string;
  name: string;
  nickname: string;
  role: Role;
  school: string;
  grade: string;
  streak: number;
  points: number;
  privacy: { accuracy: boolean; time: boolean; wrongNotes: boolean };
  completedSubjects: string[];
}
export interface Subject {
  id: string;
  name: string;
  icon: string;
  semester: string;
  color: string;
  materialCount: number;
  questionCount: number;
  cardCount: number;
  examName?: string;
  /** YYYY-MM-DD on the Seoul calendar, the same representation as Schedule.date. */
  examDate?: string;
}
export interface Material {
  id: string;
  subjectId: string;
  title: string;
  content: string;
  type: string;
  url?: string;
  createdAt: string;
}
export interface Question {
  id: string;
  subjectId: string;
  materialId: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
  citation: string;
  past: string;
  future: string;
}
export interface Essay {
  id: string;
  subjectId: string;
  materialId: string;
  prompt: string;
  keywords: string[];
  distractors: string[];
  modelAnswer: string;
  citation: string;
}
export interface Mask {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SerializedFsrs {
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3;
  last_review?: string;
}
export interface Card {
  fsrs?: SerializedFsrs | null;
  id: string;
  subjectId: string;
  front: string;
  back: string;
  type: CardType;
  bucket: Bucket;
  consecutiveEasy: number;
  nextReviewAt: string;
  deleted: boolean;
  image?: string;
  masks?: Mask[];
  /** Completed reviews recorded on the server; absent in review responses. */
  reviewCount?: number;
}
export interface StudyAttempt {
  id: string;
  questionId?: string;
  essayId?: string;
  correct: boolean;
  score: number;
  answer: string;
  createdAt: string;
}
export interface Schedule {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  kind: 'FIXED' | 'FLEXIBLE';
  subjectId?: string;
  done: boolean;
}
export interface Post {
  id: string;
  author: string;
  authorId: string;
  role: Role;
  category: string;
  title: string;
  body: string;
  anonymous: boolean;
  likes: number;
  liked: boolean;
  saved: boolean;
  commentCount: number;
  createdAt: string;
}
export interface Comment {
  id: string;
  postId: string;
  author: string;
  body: string;
  parentId?: string;
  createdAt: string;
}
export interface Cheer {
  senderName?: string;
  id: string;
  message: string;
  points: number;
  thanked: boolean;
  createdAt: string;
}
export interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  href: string;
  createdAt: string;
}
export interface AppData {
  profile: Profile;
  subjects: Subject[];
  materials: Material[];
  questions: Question[];
  essays: Essay[];
  cards: Card[];
  attempts: StudyAttempt[];
  schedules: Schedule[];
  posts: Post[];
  cheers: Cheer[];
  notifications: Notification[];
  stats: {
    todayCards: number;
    yesterdayCards?: number;
    todayQuestions: number;
    accuracy: number;
    studyMinutes: number;
    weekly: number[];
  };
  child?: Profile;
  aiAvailable: boolean;
  demo: boolean;
}
export type Navigate = (path: string) => void;
export interface ScreenProps {
  data: AppData;
  refresh: () => Promise<void>;
  navigate: Navigate;
  toast: (message: string) => void;
  path: string;
}
// All mutation endpoints use { ...payload }, return JSON { data: T } or { error: string }, HTTP 4xx/5xx on failures.
// GET /api/bootstrap; POST /api/session {role}; POST /api/logout.
// POST /api/subjects {name,examName?,examDate?}; PATCH /api/subjects/:id {name?,examName?,examDate?:'YYYY-MM-DD'|null} (examDate null clears the exam); DELETE soft-deletes.
// POST /api/materials {subjectId,title,content,type,url?}; POST /api/generate {materialId,count:1..10,mode:'quiz'|'essay'|'cards'}.
// POST /api/quiz/answer {questionId,answer:number} => {correct,explanation,citation}; POST /api/essay/submit {essayId,answer} => {score,matched:string[],missing:string[],feedback}.
// POST /api/cards {subjectId,front,back,type,image?,masks?}; PATCH /api/cards/:id {deleted?:boolean,front?,back?}; POST /api/cards/review {cardId,rating:'EASY'|'GOOD'|'HARD'|'AGAIN',reviewId:uuid} => Card; POST /api/wrong-notes/cards {questionIds:string[]}.
// POST /api/schedules {title,date,start,end,kind,subjectId?}; PATCH /api/schedules/:id {done?,title?,start?,end?}; DELETE /api/schedules/:id; POST /api/planner/suggest {date,after?:'HH:MM'} => {plans:{name:string,reason?:string,blocks:Omit<Schedule,'id'>[]}[],method:string}.
// GET /api/posts?role=STUDENT|PARENT; POST /api/posts {title,body,category,anonymous}; POST /api/posts/:id/like; POST /api/posts/:id/save; GET/POST /api/posts/:id/comments {body,parentId?}; POST /api/reports {postId,reason}; POST /api/blocks {userId}.
// PATCH /api/profile {name?,nickname?,school?,grade?,privacy?,completedSubjects?}; POST /api/invite => {code,expiresAt}; POST /api/link {code}; POST /api/cheers {message,points}; PATCH /api/cheers/:id {thanked:true}; PATCH /api/notifications {read:true}; GET /api/admin.
