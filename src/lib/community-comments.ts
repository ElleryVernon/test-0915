import type { Comment } from './contracts';
import type { CommunityBlock } from './community-types';

export interface CommentDraft {
  body: string;
  block: CommunityBlock | null;
  reply: Comment | null;
  requestId: string;
  updatedAt: number;
}
const key = (user: string, post: string) => `memoryz.comment.draft.${user}.${post}`;
export function readCommentDraft(user: string, post: string): CommentDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key(user, post)) || 'null');
    if (
      !d ||
      typeof d.body !== 'string' ||
      d.body.length > 2000 ||
      typeof d.requestId !== 'string' ||
      !d.requestId ||
      !Number.isFinite(d.updatedAt) ||
      Date.now() - d.updatedAt > 7 * 86400000 ||
      (d.block &&
        (!['PHOTO', 'QUESTION', 'CARD', 'MATH'].includes(d.block.type) ||
          !d.block.id ||
          !d.block.payload)) ||
      (d.reply && (typeof d.reply.id !== 'string' || d.reply.postId !== post))
    )
      return null;
    return d;
  } catch {
    return null;
  }
}
export function saveCommentDraft(user: string, post: string, draft: CommentDraft): boolean {
  try {
    if (!draft.body && !draft.block && !draft.reply) localStorage.removeItem(key(user, post));
    else localStorage.setItem(key(user, post), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}
/** Keep orphan replies visible when moderation or a blocked author removes their parent. */
export function commentThreads(comments: Comment[], newest = false) {
  const ids = new Set(comments.map((c) => c.id));
  return comments
    .filter((c) => !c.parentId || !ids.has(c.parentId))
    .map((root) => ({
      root,
      replies: comments
        .filter((c) => c.parentId === root.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }))
    .sort((a, b) =>
      newest
        ? b.root.createdAt.localeCompare(a.root.createdAt)
        : a.root.createdAt.localeCompare(b.root.createdAt),
    );
}
