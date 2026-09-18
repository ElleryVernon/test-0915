import type { LearningDiagram, LearningReflection } from './explanation-types';
import type { CommunityBlock, CommunityTags, CommunitySourceRef } from './community-types';
export type Role = 'STUDENT' | 'PARENT' | 'ADMIN';
export type Bucket = 'AGAIN' | 'HARD' | 'GOOD' | 'EASY' | 'MASTERED';
export type CardType = 'CONCEPT' | 'RELATION' | 'COMPARISON' | 'BLIND';
export interface Profile {
  /** Only new OAuth accounts require setup; older and demo accounts retain access. */
  onboardingRequired?: boolean;
  avatarUrl?: string;
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
  /** Present on create/edit responses and on the detail; absent from bootstrap (see MaterialDetail). */
  content?: string;
  /** Length of the trimmed body — decides whether questions can be generated (>= 20). */
  contentLength: number;
  /** The first 160 characters of the body, whitespace collapsed. */
  excerpt: string;
  /** sha256 (hex) of the stored body's UTF-8 bytes; changes with every edit, so it keys the detail cache. */
  contentHash: string;
  type: string;
  url?: string;
  /** The uploaded file; its bytes and images are served under /api/uploads/:uploadId. */
  uploadId?: string;
  /** Offsets in content where each page starts; empty once the text was edited. */
  pageBreaks?: number[];
  /** pdf-text, pdf-ocr, pdf-mixed, text, image-ocr, manual or combined (immutable source snapshot). */
  extraction?: string;
  pages?: number;
  imageCount?: number;
  createdAt: string;
}
/** GET /api/materials/:id — the material with its body, page count and extracted images. */
export interface MaterialDetail extends Material {
  content: string;
  pages?: number;
  images: MaterialImage[];
}
/** An image found in an uploaded PDF, with the page and paragraph it appeared after. */
export interface MaterialImage {
  id: string;
  url: string;
  page: number;
  order: number;
  /** Global paragraph index in the extracted text; -1 before any text. */
  paragraph: number;
  /** Offset in the extracted text where it belongs. */
  anchor: number;
  box: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
  /** Start of the paragraph it follows. */
  context: string;
}
export interface Question {
  savedToNotes?: boolean;
  communityPostId?: string;
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
  sourceKind?: string;
  diagram?: LearningDiagram;
  maskedNodeIds?: string[];
  sourceQuestionId?: string;
  sourceDiagramId?: string;
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
  /** The material an AI generation made this card from; null for hand-made and wrong-note cards. */
  materialId?: string | null;
}
export interface StudyAttempt extends LearningReflection {
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
  blocks?: CommunityBlock[];
  tags?: CommunityTags;
  sourceRef?: CommunitySourceRef;
  isMine?: boolean;
  solvedAt?: string;
  acceptedCommentId?: string;
  status?: string;
  editedAt?: string;
  school?: string;
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
  deleted?: boolean;
  editedAt?: string;
  likes?: number;
  liked?: boolean;
  isPostAuthor?: boolean;
  authorId?: string;
  isMine?: boolean;
  accepted?: boolean;
  block?: CommunityBlock;
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
  kind?: string;
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
  /** The quick keyword verdict (POST /api/essay/judge) may be requested while a grade is pending. */
  judgeAvailable?: boolean;
  demo: boolean;
}
/** Goes to path; `replace` swaps the current history entry (for one-shot intents like home's camera link). */
/**
 * Moves to path. replace swaps the history entry instead of pushing one. keepScreen updates the
 * address without remounting the current screen (screens are keyed by their path): a screen that
 * has consumed a one-shot intent from its query tidies the address this way and keeps its state.
 */
export type Navigate = (
  path: string,
  options?: { replace?: boolean; keepScreen?: boolean; restore?: boolean },
) => void;
/** A toast carries at most one follow-up action — "보기", "카드 열기", "만든 사람 팔로우". */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export interface ScreenProps {
  data: AppData;
  refresh: () => Promise<void>;
  navigate: Navigate;
  back: (fallback?: string) => void;
  toast: (message: string, action?: ToastAction) => void;
  path: string;
}
// All mutation endpoints use { ...payload }, return JSON { data: T } or { error: string }, HTTP 4xx/5xx on failures.
// GET /api/bootstrap; POST /api/session {role}; POST /api/logout.
// POST /api/subjects {name,examName?,examDate?}; PATCH /api/subjects/:id {name?,examName?,examDate?:'YYYY-MM-DD'|null} (examDate null clears the exam); DELETE soft-deletes.
// POST /api/materials {subjectId,title,content,type,url?}; POST /api/materials/sample {} => {material,questions,essays,created} (201 once, then 200); POST /api/generate {materialId OR materialIds:1..5,subjectId?,topic?,count:1..10,mode:'quiz'|'essay'|'cards'}.
// POST /api/quiz/answer {questionId,answer:number} => {correct,explanation,citation}; POST /api/essay/submit {essayId,answer} => {score,matched:string[],missing:string[],feedback}.
// POST /api/cards {subjectId,front,back,type,image?,masks?}; PATCH /api/cards/:id {deleted?:boolean,front?,back?}; POST /api/cards/review {cardId,rating:'EASY'|'GOOD'|'HARD'|'AGAIN',reviewId:uuid} => Card; POST /api/wrong-notes/cards {questionIds:string[]}.
// POST /api/schedules {title,date,start,end,kind,subjectId?}; PATCH /api/schedules/:id {done?,title?,start?,end?}; DELETE /api/schedules/:id; POST /api/planner/suggest {date,after?:'HH:MM'} => {plans:{name:string,reason?:string,blocks:Omit<Schedule,'id'>[]}[],method:string}.
// GET /api/posts?role=STUDENT|PARENT; POST /api/posts {title,body,category,anonymous}; POST /api/posts/:id/like; POST /api/posts/:id/save; GET/POST /api/posts/:id/comments {body,parentId?}; POST /api/reports {postId,reason}; POST /api/blocks {userId}.
// PATCH /api/profile {name?,nickname?,school?,grade?,privacy?,completedSubjects?}; POST /api/invite => {code,expiresAt}; POST /api/link {code}; POST /api/cheers {message,points}; PATCH /api/cheers/:id {thanked:true}; PATCH /api/notifications {read:true}; GET /api/admin.
