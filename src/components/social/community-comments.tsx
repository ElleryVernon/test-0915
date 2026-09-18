'use client';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  BookOpen,
  Check,
  Copy,
  ChevronDown,
  Heart,
  ImageIcon,
  Layers,
  MessageCircle,
  MoreHorizontal,
  PencilLine,
  Sigma,
  Trash2,
  X,
} from '@/components/icons';
import { Button, IconButton } from '@/components/ui';
import { useJourneyState } from '@/components/journey';
import { useLiveRefresh, useScreenRefresh } from '@/components/refresh';
import { api } from '@/lib/api';
import type { Comment, Post, ScreenProps } from '@/lib/contracts';
import type { CommunityBlock, CommunityBlockType } from '@/lib/community-types';
import { commentThreads, readCommentDraft, saveCommentDraft } from '@/lib/community-comments';
import { AttachmentSheet } from './attachment-sheet';
import { BlockPicker, BlockView, blockPreviewText, BLOCK_LABELS } from './community-blocks';
import { relativeTime } from './helpers';
import styles from './community-comments.module.css';

export interface CommentThreadHandle {
  focus: () => void;
  reload: () => Promise<void>;
}
export const CommunityComments = forwardRef<
  CommentThreadHandle,
  ScreenProps & {
    post: Post;
    embedded?: boolean;
    onChange: () => Promise<void>;
    onAccept: (comment: Comment) => void;
  }
>(function CommunityComments({ post, embedded = false, onChange, onAccept, ...props }, ref) {
  const { data, toast } = props;
  const [saved] = useState(() => readCommentDraft(data.profile.id, post.id));
  const [body, setBody] = useJourneyState(`community.comment.${post.id}`, saved?.body || '');
  const [block, setBlock] = useJourneyState<CommunityBlock | null>(
    `community.commentBlock.${post.id}`,
    saved?.block || null,
  );
  const [reply, setReply] = useJourneyState<Comment | null>(
    `community.reply.${post.id}`,
    saved?.reply || null,
  );
  const [requestId, setRequestId] = useJourneyState(
    `community.commentRequest.${post.id}`,
    () => saved?.requestId || crypto.randomUUID(),
  );
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [sendError, setSendError] = useState('');
  const [busy, setBusy] = useState(false);
  const [storageFailed, setStorageFailed] = useState(false);
  const [sort, setSort] = useJourneyState<'oldest' | 'newest'>(
    `community.commentSort.${post.id}`,
    'oldest',
  );
  const [expanded, setExpanded] = useJourneyState<string[]>(
    `community.commentExpanded.${post.id}`,
    [],
  );
  const [picker, setPicker] = useState<CommunityBlockType | null>(null);
  const [preview, setPreview] = useState(false);
  const [action, setAction] = useState<Comment | null>(null);
  const [edit, setEdit] = useState<Comment | null>(null);
  const [editBody, setEditBody] = useState('');
  const [remove, setRemove] = useState<Comment | null>(null);
  const [actionError, setActionError] = useState('');
  const [pendingLike, setPendingLike] = useState<string[]>([]);
  const likeLock = useRef(new Set<string>());
  const sendLock = useRef(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  const requestSequence = useRef(0);
  const section = useRef<HTMLElement>(null);
  const readingAnchor = useRef<{ id: string; top: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState(112);
  const [keyboardBottom, setKeyboardBottom] = useState<number>();
  const ownPost = post.isMine || post.authorId === data.profile.id;
  const authorLabel = ownPost && post.anonymous ? '익명 · 글쓴이' : data.profile.nickname;
  const changeId = () => {
    setRequestId(crypto.randomUUID());
    setSendError('');
  };
  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const sequence = ++requestSequence.current;
      const next = await api<Comment[]>(`/posts/${post.id}/comments`, undefined, 'GET', { signal });
      if (mounted.current && sequence === requestSequence.current && !signal?.aborted) {
        const anchor =
          window.scrollY > 0 &&
          Array.from(section.current?.querySelectorAll<HTMLElement>('article[id]') || []).find(
            (node) =>
              node.getBoundingClientRect().bottom > 80 &&
              node.getBoundingClientRect().top < window.innerHeight - 150,
          );
        readingAnchor.current = anchor
          ? { id: anchor.id, top: anchor.getBoundingClientRect().top }
          : null;
        setComments(next);
        setLoadError('');
      }
    },
    [post.id],
  );
  useLayoutEffect(() => {
    const anchor = readingAnchor.current;
    readingAnchor.current = null;
    if (!anchor) return;
    const element = document.getElementById(anchor.id);
    if (element)
      window.scrollBy({
        top: element.getBoundingClientRect().top - anchor.top,
        behavior: 'instant',
      });
  }, [comments]);
  const liveReload = useLiveRefresh(reload, { interval: 6000, resource: post.id });
  useScreenRefresh(liveReload);
  useEffect(() => {
    mounted.current = true;
    setLoading(true);
    reload()
      .catch((e) => {
        if (mounted.current) setLoadError(e.message);
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      requestSequence.current++;
    };
  }, [reload]);
  useEffect(() => {
    setStorageFailed(
      !saveCommentDraft(data.profile.id, post.id, {
        body,
        block,
        reply,
        requestId,
        updatedAt: Date.now(),
      }),
    );
  }, [body, block, reply, requestId, data.profile.id, post.id]);
  useLayoutEffect(() => {
    if (!composer.current) return;
    const observer = new ResizeObserver(() =>
      setComposerHeight(composer.current?.offsetHeight || 112),
    );
    observer.observe(composer.current);
    const viewport = window.visualViewport;
    const resize = () => {
      const offset = viewport ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
      setKeyboardBottom(offset > 100 ? offset : undefined);
    };
    resize();
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    return () => {
      observer.disconnect();
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
    };
  }, []);
  useImperativeHandle(
    ref,
    () => ({
      focus() {
        textarea.current?.focus();
      },
      reload,
    }),
    [reload],
  );
  const focusReply = (c: Comment) => {
    if (busy) return;
    const target = comments.find((r) => r.id === c.parentId) || c;
    setReply(target);
    if (c.parentId && !body.trim()) setBody(`@${c.author} `);
    setExpanded((prev) => [...new Set([...prev, target.id])]);
    changeId();
    textarea.current?.focus();
  };
  const refreshAfterAction = async () => {
    try {
      await reload();
      await onChange();
    } catch {
      setLoadError('변경은 저장됐어요. 연결되면 댓글을 다시 확인할게요.');
    }
  };
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (sendLock.current || (!body.trim() && !block)) return;
    sendLock.current = true;
    setBusy(true);
    setSendError('');
    const parentId = reply?.id;
    try {
      const receipt = await api<{ id: string }>(`/posts/${post.id}/comments`, {
        body: body.trim(),
        parentId,
        block,
        requestId,
      });
      setBody('');
      setBlock(null);
      setReply(null);
      setRequestId(crypto.randomUUID());
      if (parentId) setExpanded((prev) => [...new Set([...prev, parentId])]);
      toast(parentId ? '답글을 남겼어요' : '댓글을 남겼어요');
      await refreshAfterAction();
      requestAnimationFrame(() =>
        document
          .getElementById(`comment-${receipt.id}`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
      );
    } catch (e) {
      setSendError((e as Error).message);
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  async function like(c: Comment) {
    if (likeLock.current.has(c.id)) return;
    likeLock.current.add(c.id);
    setPendingLike([...likeLock.current]);
    try {
      const result = await api<{ likes: number; liked: boolean }>(
        `/posts/${post.id}/comments/${c.id}/like`,
        { liked: !c.liked },
      );
      requestSequence.current++;
      setComments((prev) => prev.map((item) => (item.id === c.id ? { ...item, ...result } : item)));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      likeLock.current.delete(c.id);
      setPendingLike([...likeLock.current]);
    }
  }
  async function mutate(kind: 'edit' | 'delete') {
    const target = kind === 'edit' ? edit : remove;
    if (!target || sendLock.current) return;
    sendLock.current = true;
    setBusy(true);
    setActionError('');
    try {
      await api(
        `/posts/${post.id}/comments/${target.id}`,
        kind === 'edit' ? { body: editBody.trim() } : {},
        kind === 'edit' ? 'PATCH' : 'DELETE',
      );
      setEdit(null);
      setRemove(null);
      toast(kind === 'edit' ? '댓글을 수정했어요' : '댓글을 삭제했어요');
      await refreshAfterAction();
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      sendLock.current = false;
      setBusy(false);
    }
  }
  const commentNode = (c: Comment, nested = false) => (
    <article
      key={c.id}
      id={`comment-${c.id}`}
      className={`${styles.comment} ${nested ? styles.nested : ''}`}
      data-reply-target={reply?.id === c.id || undefined}
      aria-label={`${c.deleted ? '삭제된' : c.author + '님의'} 댓글`}
    >
      <div className={styles.avatar} aria-hidden>
        {c.deleted ? <MessageCircle size={15} /> : (c.author || '?').slice(0, 1)}
      </div>
      <div className={styles.commentContent}>
        <div className={styles.meta}>
          {c.authorId && data.profile.role === 'STUDENT' && !c.deleted ? (
            <button
              className={styles.author}
              onClick={() =>
                props.navigate(`/community/profile?user=${encodeURIComponent(c.authorId!)}`)
              }
            >
              {c.author}
            </button>
          ) : (
            <strong>{c.deleted ? '삭제된 댓글' : c.author}</strong>
          )}
          {c.isPostAuthor && !c.deleted && !c.author.includes('글쓴이') && (
            <span className={styles.badge}>글쓴이</span>
          )}
          {c.isMine && <span className={styles.badge}>나</span>}
          <span className={styles.time}>
            {relativeTime(c.createdAt)}
            {c.editedAt ? ' · 수정' : ''}
          </span>
          {!c.deleted && (
            <IconButton
              className={styles.more}
              label={`${c.author}님 댓글 메뉴`}
              onClick={() => {
                setActionError('');
                setAction(c);
              }}
            >
              <MoreHorizontal size={18} />
            </IconButton>
          )}
        </div>
        {c.accepted && (
          <span className={styles.accepted}>
            <Check size={13} />
            채택된 답변
          </span>
        )}
        <p className={`${styles.commentBody} ${c.deleted ? styles.deleted : ''}`}>
          {c.deleted ? '작성자가 삭제한 댓글이에요.' : c.body}
        </p>
        {!c.deleted && c.block && (
          <div className={styles.attached}>
            <BlockView
              block={c.block}
              postId={post.id}
              data={data}
              navigate={props.navigate}
              toast={toast}
              onChanged={onChange}
            />
          </div>
        )}
        <div className={styles.actions}>
          <button
            disabled={busy}
            aria-label={`${c.deleted ? '이 대화' : c.author + '님'}에게 답글`}
            aria-pressed={reply?.id === c.id}
            onClick={() => focusReply(c)}
          >
            답글
          </button>
          {!c.deleted && (
            <button
              aria-label={`${c.author}님 댓글 공감 ${c.likes || 0}`}
              aria-pressed={!!c.liked}
              disabled={pendingLike.includes(c.id)}
              onClick={() => like(c)}
            >
              <Heart size={14} />
              {c.likes || '공감'}
            </button>
          )}
          {!c.deleted &&
            ownPost &&
            post.category === '질문' &&
            !c.isMine &&
            c.authorId !== data.profile.id && (
              <button disabled={busy || c.accepted} onClick={() => onAccept(c)}>
                {c.accepted ? '채택 완료' : '답변 채택'}
              </button>
            )}
        </div>
      </div>
    </article>
  );
  return (
    <>
      <section ref={section} className={styles.section} aria-label="댓글">
        <div className={styles.heading}>
          <h2>
            댓글 <span>{comments.length}</span>
          </h2>
          <div className={styles.sort}>
            <button aria-pressed={sort === 'oldest'} onClick={() => setSort('oldest')}>
              등록순
            </button>
            <button aria-pressed={sort === 'newest'} onClick={() => setSort('newest')}>
              최신순
            </button>
          </div>
        </div>
        {loadError && (
          <div role="alert" className={styles.error}>
            {loadError}
            <button
              onClick={() => {
                setLoading(true);
                reload()
                  .catch((e) => setLoadError(e.message))
                  .finally(() => setLoading(false));
              }}
            >
              다시 연결
            </button>
          </div>
        )}
        {loading && !comments.length ? (
          <p className={styles.empty} role="status">
            댓글을 불러오고 있어요…
          </p>
        ) : !comments.length && !loadError ? (
          <div className={styles.empty}>
            <MessageCircle size={26} />
            <strong>첫 댓글을 남겨보세요</strong>
            <p>생각을 나누거나 문제·카드를 함께 보낼 수 있어요.</p>
            <button onClick={() => textarea.current?.focus()}>댓글 쓰기</button>
          </div>
        ) : (
          commentThreads(comments, sort === 'newest').map(({ root, replies }) => (
            <div className={styles.thread} key={root.id}>
              {commentNode(root)}
              {expanded.includes(root.id) && replies.map((c) => commentNode(c, true))}
              {!!replies.length && (
                <button
                  className={styles.expand}
                  aria-expanded={expanded.includes(root.id)}
                  onClick={() =>
                    setExpanded((prev) =>
                      prev.includes(root.id)
                        ? prev.filter((id) => id !== root.id)
                        : [...prev, root.id],
                    )
                  }
                >
                  <span />
                  {expanded.includes(root.id) ? '답글 접기' : `답글 ${replies.length}개 보기`}
                  {!expanded.includes(root.id) && replies.some((c) => c.accepted)
                    ? ' · 채택 답변'
                    : ''}
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
          ))
        )}
      </section>
      {!embedded && <div aria-hidden style={{ height: composerHeight }} />}
      <form
        ref={composer}
        onSubmit={submit}
        className={`${styles.composer} ${embedded ? styles.embedded : ''}`}
        style={keyboardBottom === undefined || embedded ? undefined : { bottom: keyboardBottom }}
        aria-label="댓글 작성"
        aria-busy={busy}
      >
        {reply && (
          <div className={styles.context}>
            <div>
              <strong>{reply.deleted ? '댓글 대화' : `${reply.author}님`}에게 답글</strong>
              <p>
                {reply.deleted
                  ? '이 대화에 답글을 남겨요'
                  : reply.body || (reply.block ? blockPreviewText(reply.block) : '')}
              </p>
            </div>
            <IconButton
              label="답글 취소"
              disabled={busy}
              onClick={() => {
                setReply(null);
                changeId();
              }}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {block && (
          <div className={styles.draftAttachment}>
            <button type="button" onClick={() => setPreview(true)}>
              <span>{BLOCK_LABELS[block.type]} · 미리보기</span>
              <strong>{blockPreviewText(block)}</strong>
            </button>
            <IconButton
              label="댓글 첨부 제거"
              disabled={busy}
              onClick={() => {
                setBlock(null);
                changeId();
              }}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className={styles.inputRow}>
          <textarea
            ref={textarea}
            disabled={busy}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              changeId();
            }}
            rows={1}
            maxLength={2000}
            aria-label={reply ? '답글 내용' : '댓글 내용'}
            placeholder={reply ? '답글을 남겨주세요' : '댓글을 남겨주세요'}
          />
          <button
            type="submit"
            className={styles.send}
            aria-label={
              busy ? '전송 중' : sendError ? '전송 재시도' : reply ? '답글 등록' : '댓글 등록'
            }
            disabled={busy || (!body.trim() && !block)}
          >
            {busy ? '전송 중' : sendError ? '재시도' : '등록'}
          </button>
        </div>
        <div className={styles.tools} aria-label="댓글 첨부 도구">
          {(
            [
              ['PHOTO', '사진', ImageIcon],
              ['QUESTION', '문제', BookOpen],
              ['CARD', '카드', Layers],
              ['MATH', '수식', Sigma],
            ] as const
          )
            .filter(([type]) => data.profile.role !== 'PARENT' || type === 'PHOTO')
            .map(([type, label, Icon]) => (
              <button
                key={type}
                type="button"
                disabled={busy || !!block}
                onClick={() => setPicker(type)}
                aria-label={`댓글에 ${label} 첨부`}
              >
                <Icon size={17} />
                <span>{label}</span>
              </button>
            ))}
          <span
            className={styles.identity}
            aria-label={`작성자 ${authorLabel}`}
            title={`작성자 ${authorLabel}`}
          >
            {body.length > 1800 ? `${body.length}/2,000` : block ? '첨부 1/1' : authorLabel}
          </span>
        </div>
        {sendError && (
          <p role="alert" className={styles.error}>
            {sendError} 내용은 그대로 있어요. 재시도를 눌러주세요.
          </p>
        )}
        {storageFailed && (
          <p role="status" className={styles.error}>
            기기에 초안을 저장하지 못했어요. 이 화면을 유지해 주세요.
          </p>
        )}
      </form>
      <BlockPicker
        open={!!picker}
        initialType={picker || undefined}
        data={data}
        comment
        remaining={block ? 0 : 1}
        onClose={() => setPicker(null)}
        onAdd={(b) => {
          setBlock(b);
          changeId();
          setPicker(null);
          requestAnimationFrame(() => textarea.current?.focus());
        }}
      />
      <AttachmentSheet
        open={preview && !!block}
        title="첨부 미리보기"
        onClose={() => setPreview(false)}
      >
        {block && (
          <BlockView block={block} data={data} navigate={() => {}} toast={() => {}} preview />
        )}
      </AttachmentSheet>
      <AttachmentSheet open={!!action} title="댓글 메뉴" onClose={() => setAction(null)}>
        <div className={styles.menu}>
          <button
            onClick={async () => {
              if (!action) return;
              try {
                await navigator.clipboard.writeText(
                  [action.body, action.block ? blockPreviewText(action.block) : '']
                    .filter(Boolean)
                    .join('\n'),
                );
                toast('댓글 내용을 복사했어요');
                setAction(null);
              } catch {
                toast('복사하지 못했어요. 다시 시도해 주세요.');
              }
            }}
          >
            <Copy size={19} />
            내용 복사
          </button>
          {action?.isMine ? (
            <>
              <button
                onClick={() => {
                  setEdit(action);
                  setEditBody(action.body);
                  setAction(null);
                }}
              >
                <PencilLine size={19} />
                수정하기
              </button>
              <button
                onClick={() => {
                  setRemove(action);
                  setAction(null);
                }}
              >
                <Trash2 size={19} />
                삭제하기
              </button>
            </>
          ) : (
            <button
              onClick={() => {
                if (action) focusReply(action);
                setAction(null);
              }}
            >
              <MessageCircle size={19} />
              답글 달기
            </button>
          )}
        </div>
      </AttachmentSheet>
      <AttachmentSheet
        open={!!edit}
        title="댓글 수정"
        onClose={() => !busy && setEdit(null)}
        footer={
          <Button
            disabled={busy || (!editBody.trim() && !edit?.block) || editBody.trim() === edit?.body}
            onClick={() => mutate('edit')}
          >
            {busy ? '저장 중' : '수정 완료'}
          </Button>
        }
      >
        <textarea
          className={styles.editInput}
          aria-label="댓글 수정 내용"
          value={editBody}
          maxLength={2000}
          onChange={(e) => setEditBody(e.target.value)}
          disabled={busy}
        />
        {edit?.block && <p className={styles.help}>첨부한 내용은 그대로 유지돼요.</p>}
        {actionError && (
          <p role="alert" className={styles.error}>
            {actionError}
          </p>
        )}
      </AttachmentSheet>
      <AttachmentSheet
        open={!!remove}
        title="댓글을 삭제할까요?"
        onClose={() => !busy && setRemove(null)}
        footer={
          <Button disabled={busy} onClick={() => mutate('delete')}>
            {busy ? '삭제 중' : '댓글 삭제'}
          </Button>
        }
      >
        <p className={styles.help}>
          댓글 내용과 첨부가 지워져요. 다른 사람이 남긴 답글은 유지돼요.
          {remove?.accepted ? ' 채택 기록과 이미 받은 포인트도 유지돼요.' : ''}
        </p>
        {actionError && (
          <p role="alert" className={styles.error}>
            {actionError}
          </p>
        )}
      </AttachmentSheet>
    </>
  );
});
