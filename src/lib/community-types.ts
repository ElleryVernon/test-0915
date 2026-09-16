import type { Post } from './contracts';
export type CommunityBlockType =
  'QUESTION' | 'CARD' | 'MATERIAL' | 'PHOTO' | 'ESSAY' | 'POLL' | 'SCHEDULE' | 'MATH';
export interface CommunityBlock {
  id: string;
  type: CommunityBlockType;
  refId?: string;
  hidden: boolean;
  payload: Record<string, any>;
  stats?: { attempts: number; correct: number; votes?: number[]; voted?: number };
  sourceDeleted?: boolean;
}
export interface CommunityTags {
  grade?: string;
  subjectId?: string;
  subjectName?: string;
  examDday?: number;
}
export interface CommunitySourceRef {
  kind: 'EXPLAIN' | 'WRONGNOTE' | 'CARD' | 'ESSAY';
  questionId?: string;
  cardId?: string;
  essayId?: string;
  nodeId?: string;
}
export interface CommunityVisibility {
  grade: boolean;
  subjects: boolean;
  followerCount: boolean;
  cardsDefault: boolean;
  whoCanFollow: 'ALL' | 'SAME_GRADE' | 'NONE';
}
export interface CommunityProfileData {
  id: string;
  nickname: string;
  grade?: string;
  subjects: string[];
  joinedAt: string;
  following: boolean;
  isMine: boolean;
  visibility: CommunityVisibility;
  stats: { accepted: number; cardsCloned: number; helpedUsers: number; answers: number };
  followers?: number;
  followingCount: number;
  posts: Post[];
  answers: { postId: string; postTitle: string; body: string; accepted: boolean }[];
  cards: CommunityBlock[];
}
export interface CommunityDraft {
  requestId: string;
  title: string;
  body: string;
  category: string;
  anonymous: boolean;
  blocks: CommunityBlock[];
  tags: CommunityTags;
  scope: 'all' | 'school';
  sourceRef?: CommunitySourceRef;
  updatedAt: string;
}
