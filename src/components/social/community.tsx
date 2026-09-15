'use client';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Bookmark,
  Check,
  ChevronRight,
  Heart,
  MessageCircle,
  MoreHorizontal,
  PencilLine,
  Search,
  Send,
  UserRound,
  X,
} from '@/components/icons';
import { api } from '@/lib/api';
import type { Comment, Post, ScreenProps } from '@/lib/contracts';
import { Button, EmptyState, IconButton, ScreenHeader, SectionTitle, Sheet } from '@/components/ui';
import { relativeTime, selectPosts } from './helpers';
import SocialHub from './social-hub';

const categories = ['전체', '질문', '자유', '수시', '정시', '공부 팁'];
export default function Community(props: ScreenProps) {
  const { data, refresh, toast, path } = props;
  const parent = data.profile.role === 'PARENT';
  const allowed = parent
    ? path.startsWith('/parent-boards')
    : data.profile.role === 'STUDENT' && path.startsWith('/community');
  const commentedOnly = path.includes('commented=1');
  const postQuery = `/posts?role=${data.profile.role}${commentedOnly ? '&commented=1' : ''}`;
  const [category, setCategory] = useState('전체');
  const [sort, setSort] = useState<'latest' | 'popular'>('latest');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(path.includes('mine=1'));
  const [posts, setPosts] = useState<Post[]>(data.posts);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Post | null>(null);
  const [composing, setComposing] = useState(false);
  const [hub, setHub] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    title: '',
    body: '',
    category: parent ? '자유' : '질문',
    anonymous: true,
  });
  const [error, setError] = useState('');
  async function reload() {
    setLoading(true);
    setLoadError('');
    try {
      setPosts(await api<Post[]>(postQuery));
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    if (!allowed) return;
    api<Post[]>(postQuery)
      .then((p) => {
        if (active) {
          setPosts(p);
          setLoadError('');
        }
      })
      .catch((e) => {
        if (active) setLoadError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [postQuery, allowed]);
  const shown = useMemo(
    () =>
      selectPosts(posts, data.profile.role, {
        category,
        query,
        sort,
        saved: savedOnly,
        mine: mineOnly ? data.profile.id : undefined,
      }),
    [posts, data.profile.role, data.profile.id, category, query, sort, savedOnly, mineOnly],
  );
  const unanswered = posts
    .filter((p) => p.role === data.profile.role && p.category === '질문' && p.commentCount === 0)
    .slice(0, 3);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.title.trim() || !draft.body.trim()) {
      setError('제목과 내용을 모두 적어 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/posts', { ...draft, title: draft.title.trim(), body: draft.body.trim() });
      await reload();
      await refresh();
      setDraft({ title: '', body: '', category: parent ? '자유' : '질문', anonymous: true });
      setComposing(false);
      toast('글을 올렸어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!allowed)
    return (
      <>
        <ScreenHeader title="커뮤니티" />
        <EmptyState
          title="우리끼리 편하게 이야기해요"
          description={
            parent
              ? '학생 게시판은 학생 계정으로 이용할 수 있어요.'
              : '학부모 게시판은 학부모 계정으로 이용할 수 있어요.'
          }
          action={
            <Button onClick={() => props.navigate(parent ? '/parent-boards' : '/community')}>
              내 커뮤니티로 가기
            </Button>
          }
        />
      </>
    );
  if (selected)
    return (
      <PostDetail
        {...props}
        post={posts.find((p) => p.id === selected.id) ?? selected}
        onBack={() => setSelected(null)}
        onChange={async () => {
          await reload();
          await refresh();
        }}
        onBlocked={async () => {
          setSelected(null);
          await reload();
          await refresh();
        }}
      />
    );
  return (
    <>
      <ScreenHeader
        title={commentedOnly ? '내가 댓글 남긴 글' : '커뮤니티'}
        back={commentedOnly ? () => props.navigate('/profile') : undefined}
        action={
          <div className="flex">
            <IconButton label="게시글 검색" onClick={() => setSearchOpen((v) => !v)}>
              <Search size={22} />
            </IconButton>
            <IconButton label="쪽지함" onClick={() => setHub(true)}>
              <Send size={21} />
            </IconButton>
          </div>
        }
      />
      <div className="page-inset pb-5">
        {parent ? (
          <div className="mb-5 flex items-center gap-2">
            <span className="rounded-xl bg-surface px-3 py-2 text-sm font-semibold text-secondary">
              {data.child?.grade ? `${data.child.grade} 학부모` : '학부모 공간'}
            </span>
            <p className="flex-1 text-[12px] leading-5 text-muted">
              경험을 나누고
              <br />
              도움 되는 정보를 모아요
            </p>
          </div>
        ) : (
          !commentedOnly &&
          !searchOpen &&
          !savedOnly &&
          !mineOnly &&
          unanswered.length > 0 && (
            <section className="mb-6">
              <SectionTitle
                title="첫 답변을 기다려요"
                action={
                  <span className="text-brand-text text-xs font-semibold">같이 풀어 볼까요?</span>
                }
              />
              <div className="flex gap-3 overflow-x-auto page-bleed page-inset pb-1 snap-x">
                {unanswered.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setSelected(p)}
                    className="w-[235px] shrink-0 rounded-[20px] bg-surface p-4 text-left snap-start"
                  >
                    <span className="text-[12px] font-semibold text-muted">
                      질문 · {relativeTime(p.createdAt)}
                    </span>
                    <span className="mt-2 block text-[15px] font-bold leading-[1.5] line-clamp-2 min-h-[45px]">
                      {p.title}
                    </span>
                    <span className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold text-muted">
                      <MessageCircle size={14} /> 첫 답변 남기기 <ChevronRight size={14} />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )
        )}
        {searchOpen && (
          <div className="relative mb-4">
            <Search className="absolute left-3.5 top-3.5 text-subtle" size={19} />
            <input
              autoFocus
              aria-label="게시글 검색어"
              className="field !pl-11 !pr-12"
              placeholder="궁금한 내용을 찾아보세요"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-0.5 top-0.5 size-11 flex items-center justify-center"
                aria-label="검색어 지우기"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}
        <div className="community-categories page-bleed page-inset" aria-label="게시판 선택">
          {categories
            .filter((c) => !parent || c !== '질문')
            .map((c) => (
              <button
                key={c}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                className="community-category"
              >
                {c}
              </button>
            ))}
        </div>
        <div className="flex items-center justify-between py-1 border-b border-surface">
          <div className="flex gap-3 text-[13px]">
            <button
              onClick={() => setSavedOnly((v) => !v)}
              aria-pressed={savedOnly}
              className={`min-h-11 flex items-center gap-1 ${savedOnly ? 'font-bold text-ink' : 'text-subtle'}`}
            >
              <Bookmark size={15} />
              저장
            </button>
            <button
              onClick={() => setMineOnly((v) => !v)}
              aria-pressed={mineOnly}
              className={`min-h-11 px-1 ${mineOnly ? 'font-bold' : 'text-subtle'}`}
            >
              내 글
            </button>
          </div>
          <select
            aria-label="게시글 정렬"
            value={sort}
            onChange={(e) => setSort(e.target.value as 'latest' | 'popular')}
            className="min-h-11 bg-white text-[13px] text-muted py-1"
          >
            <option value="latest">최신순</option>
            <option value="popular">공감순</option>
          </select>
        </div>
        {loadError && (
          <div role="alert" className="py-6 text-center text-sm">
            <p className="text-muted">{loadError}</p>
            <Button variant="ghost" onClick={reload}>
              다시 불러오기
            </Button>
          </div>
        )}
        {loading && !posts.length ? (
          <div role="status" className="py-14 text-center text-sm text-subtle">
            이야기를 가져오고 있어요…
          </div>
        ) : !shown.length && !loadError ? (
          <EmptyState
            title={
              mineOnly
                ? '아직 작성한 글이 없어요'
                : commentedOnly
                  ? '아직 댓글을 남기지 않았어요'
                  : savedOnly
                    ? '다시 보고 싶은 글을 저장해요'
                    : query
                      ? '찾는 글이 아직 없어요'
                      : '첫 이야기를 들려주세요'
            }
            description={
              mineOnly
                ? '첫 질문이나 공부 이야기를 남겨 보세요.'
                : commentedOnly
                  ? '댓글을 남긴 글은 여기에 모여요.'
                  : savedOnly
                    ? '글에서 저장 버튼을 누르면 여기에 모여요.'
                    : query
                      ? '다른 단어로 검색해 보세요.'
                      : '작은 질문도 괜찮아요. 함께 이야기해 봐요.'
            }
            action={
              query ? (
                <Button variant="ghost" onClick={() => setQuery('')}>
                  검색어 지우기
                </Button>
              ) : savedOnly || mineOnly || commentedOnly ? (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSavedOnly(false);
                    setMineOnly(false);
                    setCategory('전체');
                    if (commentedOnly) props.navigate(parent ? '/parent-boards' : '/community');
                  }}
                >
                  전체 글 둘러보기
                </Button>
              ) : undefined
            }
          />
        ) : (
          shown.map((post) => (
            <button key={post.id} onClick={() => setSelected(post)} className="community-post">
              <span className="community-post-top">
                <span className="row-badge">{post.category}</span>
                <span>{relativeTime(post.createdAt)}</span>
              </span>
              <span className="community-post-title">{post.title}</span>
              <span className="community-post-body">{post.body}</span>
              <span className="community-post-footer">
                <span className="community-post-author">{post.author}</span>
                <span className="flex items-center gap-1" aria-label={`공감 ${post.likes}개`}>
                  <Heart size={14} className={post.liked ? 'text-brand' : 'text-disabled'} />
                  {post.likes}
                </span>
                <span
                  className="flex items-center gap-1"
                  aria-label={`댓글 ${post.commentCount}개`}
                >
                  <MessageCircle size={14} />
                  {post.commentCount}
                </span>
                {post.saved && <Bookmark size={14} className="ml-auto" />}
              </span>
            </button>
          ))
        )}
        <div className="sticky bottom-[92px] mt-6 flex justify-end pointer-events-none">
          <Button
            className="!rounded-full pointer-events-auto"
            onClick={() => {
              setError('');
              setComposing(true);
            }}
          >
            <PencilLine size={19} />
            {parent ? '글쓰기' : '질문하기'}
          </Button>
        </div>
      </div>
      <Sheet
        open={composing}
        fullScreen
        onClose={() => !busy && setComposing(false)}
        title={parent ? '이야기 쓰기' : '질문하기'}
      >
        <form onSubmit={submit} className="community-composer">
          <div className="flex items-center justify-between gap-3">
            <select
              aria-label="작성 게시판"
              className="field !w-auto"
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              {categories
                .filter((c) => c !== '전체' && (!parent || c !== '질문'))
                .map((c) => (
                  <option key={c}>{c}</option>
                ))}
            </select>
            <label className="flex gap-2 items-center text-sm font-semibold">
              <input
                type="checkbox"
                checked={draft.anonymous}
                onChange={(e) => setDraft({ ...draft, anonymous: e.target.checked })}
                className="size-4 accent-ink"
              />
              익명으로
            </label>
          </div>
          <input
            aria-label="글 제목"
            autoFocus
            required
            maxLength={120}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            placeholder="제목을 적어 주세요"
            className="compose-title"
          />
          <textarea
            aria-label="글 내용"
            required
            minLength={2}
            maxLength={10000}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            placeholder={
              parent
                ? '다른 학부모님께 나누고 싶은 경험이 있나요?'
                : '어디까지 이해했고, 어떤 부분이 막혔나요? 아는 만큼 적어 주세요.'
            }
            className="compose-body"
          />
          <p className="text-[12px] leading-5 text-subtle">
            서로를 존중하는 말로 이야기해요. 익명 글도 신고가 접수되면 운영팀이 작성자를 확인할 수
            있어요.
          </p>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div
            className="flex justify-end -mt-2 text-[11px] tabular-nums text-subtle"
            aria-live="off"
          >
            {draft.body.length.toLocaleString()} / 10,000
          </div>
          <Button type="submit" disabled={busy || !draft.title.trim() || !draft.body.trim()}>
            {busy ? '올리고 있어요…' : '올리기'}
          </Button>
        </form>
      </Sheet>
      <Sheet open={hub} onClose={() => setHub(false)} title="친구와 쪽지">
        <SocialHub {...props} initialTab="messages" />
      </Sheet>
    </>
  );
}

function PostDetail({
  post,
  onBack,
  onChange,
  onBlocked,
  ...props
}: ScreenProps & {
  post: Post;
  onBack: () => void;
  onChange: () => Promise<void>;
  onBlocked: () => Promise<void>;
}) {
  const { data, toast } = props;
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [commentError, setCommentError] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState<Comment | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [report, setReport] = useState(false);
  const [reason, setReason] = useState('욕설·비방');
  const [hub, setHub] = useState(false);
  const [blockConfirm, setBlockConfirm] = useState(false);
  const [commentReload, setCommentReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setCommentError('');
    api<Comment[]>(`/posts/${post.id}/comments`)
      .then((c) => {
        if (active) setComments(c);
      })
      .catch((e) => {
        if (active) setCommentError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [post.id, commentReload]);
  async function action(kind: 'like' | 'save') {
    if (busy) return;
    setBusy(true);
    try {
      await api(`/posts/${post.id}/${kind}`, {});
      await onChange();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sendComment(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setCommentError('');
    try {
      await api(`/posts/${post.id}/comments`, { body: body.trim(), parentId: reply?.id });
      setBody('');
      setReply(null);
      setComments(await api<Comment[]>(`/posts/${post.id}/comments`));
      await onChange();
    } catch (e) {
      setCommentError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moderate(kind: 'report' | 'block') {
    setBusy(true);
    try {
      await api(
        kind === 'report' ? '/reports' : '/blocks',
        kind === 'report' ? { postId: post.id, reason } : { userId: post.authorId },
      );
      setMenu(false);
      setReport(false);
      setBlockConfirm(false);
      toast(
        kind === 'report' ? '신고를 접수했어요. 운영팀이 확인할게요.' : '이 사용자를 차단했어요',
      );
      if (kind === 'block') await onBlocked();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const renderComment = (comment: Comment, nested = false) => (
    <div key={comment.id} className={`flex gap-3 py-3 ${nested ? 'ml-10' : ''}`}>
      <span className="size-8 shrink-0 rounded-full bg-surface flex items-center justify-center text-xs font-bold">
        {comment.author.slice(0, 1)}
      </span>
      <div className="flex-1 min-w-0">
        <span className="text-[13px] font-bold">
          {comment.author}
          <span className="font-normal text-[11px] text-subtle ml-2">
            {relativeTime(comment.createdAt)}
          </span>
        </span>
        <p className="text-[15px] leading-6 mt-1 whitespace-pre-wrap break-words">{comment.body}</p>
        {!nested && (
          <button
            onClick={() => setReply(comment)}
            className="min-h-11 text-xs font-semibold text-muted py-2"
          >
            답글 달기
          </button>
        )}
      </div>
    </div>
  );
  return (
    <>
      <ScreenHeader
        title={post.category}
        back={onBack}
        action={
          <IconButton label="게시글 더 보기" onClick={() => setMenu(true)}>
            <MoreHorizontal size={22} />
          </IconButton>
        }
      />
      <article className="page-inset pb-5 community-detail">
        <div className="flex items-center gap-3 mt-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-surface">
            <UserRound size={21} />
          </span>
          <div>
            <button
              disabled={post.anonymous || post.authorId === data.profile.id}
              onClick={() => setHub(true)}
              className="text-[14px] font-bold"
            >
              {post.author}
            </button>
            <p className="text-xs text-subtle mt-0.5">{relativeTime(post.createdAt)}</p>
          </div>
        </div>
        <h1 className="mt-6 text-[23px] font-bold tracking-[-0.025em] leading-[1.4] break-words">
          {post.title}
        </h1>
        <p className="mt-4 text-[16px] leading-[1.85] whitespace-pre-wrap break-words">
          {post.body}
        </p>
        <div className="grid grid-cols-2 gap-2 mt-7">
          <button
            onClick={() => action('like')}
            disabled={busy}
            aria-pressed={post.liked}
            className={`flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold ${post.liked ? 'bg-ink text-white' : 'bg-surface text-secondary'}`}
          >
            <Heart size={18} />
            공감 {post.likes}
          </button>
          <button
            onClick={() => action('save')}
            disabled={busy}
            aria-pressed={post.saved}
            className={`flex items-center justify-center gap-2 rounded-xl py-3.5 text-sm font-semibold ${post.saved ? 'bg-ink text-white' : 'bg-surface text-secondary'}`}
          >
            <Bookmark size={18} />
            {post.saved ? '저장했어요' : '저장하기'}
          </button>
        </div>
        {data.profile.role === 'PARENT' && (
          <p className="rounded-2xl bg-canvas p-4 text-[12px] leading-5 text-muted mt-5">
            학부모님들이 나눈 경험이에요. 학교마다 기준이 다를 수 있으니 정확한 내용은 학교에 확인해
            주세요.
          </p>
        )}
        <section className="mt-8">
          <SectionTitle title={`댓글 ${comments.length}`} />
          {loading ? (
            <p role="status" className="py-4 text-sm text-subtle">
              댓글을 가져오고 있어요…
            </p>
          ) : commentError && !comments.length ? (
            <div className="py-4 text-[14px] text-muted">
              <p role="alert">{commentError}</p>
              <Button variant="ghost" onClick={() => setCommentReload((v) => v + 1)}>
                댓글 다시 불러오기
              </Button>
            </div>
          ) : !comments.length ? (
            <p className="py-5 text-[14px] text-subtle">아는 만큼만 답해줘도 큰 도움이 돼요.</p>
          ) : (
            comments
              .filter((c) => !c.parentId)
              .map((c) => (
                <div key={c.id}>
                  {renderComment(c)}
                  {comments.filter((r) => r.parentId === c.id).map((r) => renderComment(r, true))}
                </div>
              ))
          )}
        </section>
        <form onSubmit={sendComment} className="mt-5 rounded-2xl bg-surface p-3">
          {reply && (
            <div className="flex items-center justify-between text-[12px] text-muted mb-2 px-1">
              {reply.author}님에게 답글
              <button
                type="button"
                aria-label="답글 취소"
                className="size-11 -my-2 flex items-center justify-center"
                onClick={() => setReply(null)}
              >
                <X size={17} />
              </button>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <textarea
              aria-label={reply ? '답글 내용' : '댓글 내용'}
              placeholder="아는 만큼만 답해줘도 돼요"
              rows={2}
              maxLength={2000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="flex-1 min-w-0 resize-none outline-none bg-transparent p-1 text-[15px] leading-6"
            />
            <button
              aria-label="댓글 보내기"
              type="submit"
              disabled={busy || !body.trim()}
              className="bg-primary text-white size-10 rounded-full flex items-center justify-center disabled:opacity-40 shrink-0"
            >
              <Send size={17} />
            </button>
          </div>
        </form>
        {commentError && comments.length > 0 && (
          <p role="alert" className="text-sm text-danger mt-2">
            {commentError}
          </p>
        )}
      </article>
      <Sheet open={menu} onClose={() => setMenu(false)} title="게시글 관리">
        <div className="flex flex-col gap-2">
          {post.authorId !== data.profile.id && (
            <>
              {!post.anonymous && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setMenu(false);
                    setHub(true);
                  }}
                >
                  <Send size={18} />
                  쪽지 보내기
                </Button>
              )}
              <Button
                variant="secondary"
                onClick={() => {
                  setMenu(false);
                  setReport(true);
                }}
              >
                게시글 신고
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setMenu(false);
                  setBlockConfirm(true);
                }}
              >
                작성자 차단
              </Button>
            </>
          )}
          <p className="text-sm text-subtle leading-6 mt-3">
            익명 게시글도 운영팀이 확인할 수 있어요. 차단하면 서로의 글과 쪽지가 보이지 않아요.
          </p>
        </div>
      </Sheet>
      <Sheet open={report} onClose={() => setReport(false)} title="신고 이유를 알려주세요">
        <div className="flex flex-col gap-2">
          {['욕설·비방', '광고·홍보', '개인정보 노출', '부적절한 내용', '잘못된 정보'].map((r) => (
            <button
              className={`rounded-xl p-4 text-left text-[15px] flex justify-between ${reason === r ? 'bg-ink text-white' : 'bg-surface'}`}
              onClick={() => setReason(r)}
              key={r}
            >
              {r}
              {reason === r && <Check size={19} />}
            </button>
          ))}
          <Button className="mt-3" onClick={() => moderate('report')} disabled={busy}>
            신고 접수하기
          </Button>
        </div>
      </Sheet>
      <Sheet
        open={blockConfirm}
        onClose={() => setBlockConfirm(false)}
        title="작성자를 차단할까요?"
      >
        <p className="text-[15px] text-muted leading-6 mb-5">
          서로의 게시글과 쪽지가 보이지 않아요. 마이페이지의 친구 관리에서 해제할 수 있어요.
        </p>
        <Button className="w-full" onClick={() => moderate('block')} disabled={busy}>
          차단하기
        </Button>
      </Sheet>
      <Sheet open={hub} onClose={() => setHub(false)} title={`${post.author}님과 이야기`}>
        <SocialHub {...props} initialUser={{ id: post.authorId, nickname: post.author }} />
      </Sheet>
    </>
  );
}
