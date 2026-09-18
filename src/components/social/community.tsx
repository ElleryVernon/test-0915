'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Heart,
  MessageCircle,
  MoreHorizontal,
  PencilLine,
  Plus,
  Search,
  X,
} from '@/components/icons';
import { api } from '@/lib/api';
import type { Comment, Post, ScreenProps } from '@/lib/contracts';
import type { CommunityBlock } from '@/lib/community-types';
import { communityGroup, readCommunityDraft } from '@/lib/community-draft';
import {
  longTitles,
  markFollowed,
  markFollowSuggested,
  maySuggestFollow,
  recordPostVisit,
} from '@/lib/community-nudges';
import { Button, EmptyState, IconButton, ScreenHeader, Sheet } from '@/components/ui';
import { OptionField } from '@/components/ui-choice';
import { relativeTime } from './helpers';
import { useJourneyState } from '../journey';
import { useLiveRefresh, useScreenRefresh } from '../refresh';
import { CommunityHeader, communityBase } from './community-navigation';
import { CommunityComposer } from './community-composer';
import { BlockView } from './community-blocks';
import { CommunityComments, type CommentThreadHandle } from './community-comments';
import styles from './community-v3.module.css';
import { SchoolJoin } from './school-join';
const names: Record<string, string> = {
  QUESTION: '문제',
  CARD: '카드',
  MATERIAL: '자료',
  PHOTO: '사진',
  ESSAY: '서술형',
  POLL: '투표',
  SCHEDULE: '시간표',
  MATH: '수식',
};
function attachments(post: Post) {
  const counts = new Map<string, number>();
  for (const b of post.blocks || []) counts.set(b.type, (counts.get(b.type) || 0) + 1);
  return [...counts].map(([type, n]) => `${names[type]} ${n}`).join(' · ');
}
function PostRow({ post, onClick }: { post: Post; onClick: () => void }) {
  const photo = post.blocks?.find((b) => b.type === 'PHOTO');
  return (
    <button className={styles.postRow} onClick={onClick}>
      <span className={styles.postCopy}>
        <span className={`${styles.postTitle}${longTitles() ? ` ${styles.postTitleLong}` : ''}`}>
          {post.solvedAt && <span className={styles.solved}>해결됨</span>}
          {post.title}
        </span>
        {post.body.trim() && (
          <span className={styles.postExcerpt}>{post.body.replace(/\s+/g, ' ').trim()}</span>
        )}
        <span className={styles.postContext}>
          <span>
            {post.category}
            {post.tags?.subjectName ? ` · ${post.tags.subjectName}` : ''}
          </span>
          {attachments(post) && <span className={styles.attachmentMeta}>{attachments(post)}</span>}
        </span>
        <span className={styles.postMeta}>
          <span className={styles.postByline}>
            {post.author} · {relativeTime(post.createdAt)}
            {post.editedAt ? ' · 수정' : ''}
          </span>
          <span className={styles.postCounts}>
            <span aria-label={`공감 ${post.likes}`}>
              <Heart size={13} />
              {post.likes}
            </span>
            <span aria-label={`댓글 ${post.commentCount}`}>
              <MessageCircle size={13} />
              {post.commentCount}
            </span>
          </span>
        </span>
      </span>
      {photo && (
        <img className={styles.thumbnail} src={photo.payload.image} alt="첨부 사진 미리보기" />
      )}
    </button>
  );
}
export default function Community(props: ScreenProps) {
  const { data, path } = props;
  const parent = data.profile.role === 'PARENT';
  const base = communityBase(props);
  const params = new URLSearchParams(path.split('?')[1]);
  const school = params.get('space') === 'school';
  const missing = school && !data.profile.school.trim();
  const mine = params.get('mine') === '1',
    saved = params.get('saved') === '1',
    commented = params.get('commented') === '1';
  const activity = mine || saved || commented;
  const selectedId = params.get('post');
  const [group, setGroup] = useJourneyState(
    `community.feed.category.${school ? 'school' : 'all'}`,
    '전체',
  );
  const [sort, setSort] = useJourneyState('community.v3.sort', 'latest');
  const [query, setQuery] = useJourneyState('community.v3.query', '');
  const [searchOpen, setSearchOpen] = useJourneyState('community.searchOpen', false);
  const [subject, setSubject] = useJourneyState('community.v3.subject', '');
  const [unansweredOnly, setUnansweredOnly] = useJourneyState('community.v3.unanswered', false);
  const [posts, setPosts] = useState<Post[]>([]);
  const [following, setFollowing] = useState<Post[]>([]);
  const [followingCards, setFollowingCards] = useState<
    { block: CommunityBlock; authorId: string; author: string }[]
  >([]);
  const [detail, setDetail] = useState<Post | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [composing, setComposing] = useState<'new' | 'resume' | null>(null);
  const [schoolInfo, setSchoolInfo] = useState(false);
  const [pendingFeed, setPendingFeed] = useState<{
    posts: Post[];
    following: Post[];
    cards: typeof followingCards;
  } | null>(null);
  const liveSequence = useRef(0);
  const draft = readCommunityDraft(data.profile.id);
  const allowed =
    (parent && path.startsWith('/parent-boards')) ||
    (!parent && data.profile.role === 'STUDENT' && path.startsWith('/community'));
  const postQuery = `/posts?role=${data.profile.role}${school ? '&scope=school' : ''}${mine ? '&mine=1' : ''}${saved ? '&saved=1' : ''}${commented ? '&commented=1' : ''}`;
  const readLatest = async (signal?: AbortSignal, apply = false) => {
    const sequence = ++liveSequence.current;
    if (selectedId) {
      const next = await api<Post>(`/posts/${encodeURIComponent(selectedId)}`, undefined, 'GET', {
        signal,
      });
      if (!signal?.aborted && sequence === liveSequence.current) {
        setDetail(next);
        setError('');
        setLoading(false);
      }
      return;
    }
    const [next, followed] = await Promise.all([
      api<Post[]>(postQuery, undefined, 'GET', { signal }),
      !parent && !activity && !school
        ? api<{ posts: Post[]; cards: typeof followingCards }>(
            '/community/following',
            undefined,
            'GET',
            { signal },
          )
        : Promise.resolve({ posts: [], cards: [] }),
    ]);
    if (signal?.aborted || sequence !== liveSequence.current) return;
    setError('');
    setLoading(false);
    if (apply || !posts.length) {
      setPosts(next);
      setFollowing(followed.posts);
      setFollowingCards(followed.cards);
      setPendingFeed(null);
    } else if (
      JSON.stringify([next, followed.posts, followed.cards]) !==
      JSON.stringify([posts, following, followingCards])
    ) {
      setPendingFeed({ posts: next, following: followed.posts, cards: followed.cards });
    } else setPendingFeed(null);
  };
  const pullLatest = async (signal?: AbortSignal) => readLatest(signal, true);
  useScreenRefresh(pullLatest, allowed && !missing && !composing);
  useLiveRefresh(readLatest, {
    interval: selectedId ? 15_000 : 30_000,
    enabled: allowed && !missing && !composing,
    resource: `${postQuery}:${selectedId}`,
  });
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    if (!allowed || missing) {
      setLoading(false);
      return;
    }
    (selectedId
      ? api<Post>(`/posts/${encodeURIComponent(selectedId)}`).then((p) => {
          if (active) setDetail(p);
        })
      : api<Post[]>(postQuery).then((p) => {
          if (active) setPosts(p);
        })
    )
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [postQuery, selectedId, reloadKey, allowed, missing]);
  useEffect(() => {
    let active = true;
    if (!parent && !activity && !school)
      api<{ posts: Post[]; cards: { block: CommunityBlock; authorId: string; author: string }[] }>(
        '/community/following',
      )
        .then((p) => {
          if (active) {
            setFollowing(p.posts);
            setFollowingCards(p.cards);
          }
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [parent, activity, school, reloadKey]);
  // A visit that ends in under 3 s means the row didn't say enough; five in a row widen titles.
  const openedAt = useRef(0);
  useEffect(() => {
    if (selectedId) {
      openedAt.current = Date.now();
    } else if (openedAt.current) {
      recordPostVisit(Date.now() - openedAt.current);
      openedAt.current = 0;
    }
  }, [selectedId]);
  const subjects = new Set(data.subjects.map((s) => s.name));
  const unanswered = posts.filter(
    (p) =>
      p.category === '질문' &&
      !p.solvedAt &&
      !p.commentCount &&
      subjects.has(p.tags?.subjectName || '') &&
      Date.now() - Date.parse(p.createdAt) < 86400000,
  );
  const visible = useMemo(
    () =>
      (group === '팔로잉' && !activity ? following : posts)
        .filter(
          (p) =>
            (activity ||
              group === '전체' ||
              group === '팔로잉' ||
              p.category === group ||
              (group === '입시' && communityGroup(p.category) === '입시')) &&
            (activity || !subject || p.tags?.subjectName === subject) &&
            (activity || !unansweredOnly || unanswered.some((u) => u.id === p.id)) &&
            (!query ||
              `${p.title} ${p.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
        )
        .sort((a, b) =>
          sort === 'popular'
            ? b.likes - a.likes
            : Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
    [
      posts,
      following,
      activity,
      group,
      subject,
      unansweredOnly,
      query,
      sort,
      unanswered.map((p) => p.id).join(','),
    ],
  );
  const openPost = (post: Post) => {
    const p = new URLSearchParams(path.split('?')[1]);
    p.set('post', post.id);
    props.navigate(`${base}?${p}`);
  };
  const listPath = () => {
    const p = new URLSearchParams(path.split('?')[1]);
    p.delete('post');
    return `${base}${p.size ? '?' + p : ''}`;
  };
  const reload = async () => {
    await readLatest(undefined, true);
  };
  if (!allowed)
    return (
      <>
        <ScreenHeader title="커뮤니티" />
        <EmptyState
          title="이 계정의 커뮤니티로 이동해 주세요"
          description="학생과 학부모의 커뮤니티는 따로 운영돼요."
          action={<Button onClick={() => props.navigate(base)}>내 커뮤니티</Button>}
        />
      </>
    );
  if (selectedId && missing)
    return (
      <>
        <ScreenHeader title="학교 커뮤니티" back={() => props.back(base)} />
        <EmptyState
          title="학교 정보를 먼저 등록해 주세요"
          description="이 학교 글을 보려면 해당 학교가 프로필에 등록되어 있어야 해요."
          action={<Button onClick={() => props.navigate('/profile')}>학교 정보 등록하기</Button>}
        />
      </>
    );
  if (selectedId)
    return detail && !loading ? (
      <CommunityPostDetail
        {...props}
        post={detail}
        onBack={() => props.back(listPath())}
        onChange={reload}
        onRemoved={() => props.navigate(listPath(), { replace: true })}
      />
    ) : (
      <>
        <ScreenHeader title="게시글" back={() => props.back(listPath())} />
        {error ? (
          <EmptyState
            title="글을 열 수 없어요"
            description={error}
            action={
              <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                다시 불러오기
              </Button>
            }
          />
        ) : (
          <div className="page-inset py-4" aria-busy="true" aria-label="글을 불러오고 있어요">
            <div className={styles.skeletonRow}>
              <span className={styles.skeletonLine} style={{ width: '32%' }} />
              <span className={`${styles.skeletonLine} ${styles.skeletonTitle}`} />
              <span
                className={`${styles.skeletonLine} ${styles.skeletonTitle}`}
                style={{ width: '74%' }}
              />
              <span className={styles.skeletonLine} style={{ width: '46%' }} />
            </div>
          </div>
        )}
      </>
    );
  return (
    <>
      {activity ? (
        <ScreenHeader
          title={mine ? '내가 쓴 글' : saved ? '저장한 글' : '내가 댓글 남긴 글'}
          back={() => props.back(`${base}/me`)}
          action={
            <IconButton label="게시글 검색" onClick={() => setSearchOpen((v) => !v)}>
              <Search size={20} />
            </IconButton>
          }
        />
      ) : (
        <CommunityHeader
          {...props}
          active={school ? 'school' : 'all'}
          onSearch={() => setSearchOpen((v) => !v)}
        />
      )}
      {missing ? (
        <SchoolJoin refresh={props.refresh} />
      ) : (
        <div className={`page-inset ${styles.feed}`}>
          {pendingFeed && (
            <button
              className={styles.newUpdates}
              onClick={() => {
                setPosts(pendingFeed.posts);
                setFollowing(pendingFeed.following);
                setFollowingCards(pendingFeed.cards);
                setPendingFeed(null);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            >
              새 소식 보기
            </button>
          )}
          {searchOpen && (
            <div className={styles.search}>
              <Search size={18} />
              <input
                autoFocus
                aria-label="게시글 검색어"
                placeholder="제목과 내용에서 찾기"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <IconButton
                label="검색 닫기"
                onClick={() => {
                  setSearchOpen(false);
                  setQuery('');
                }}
              >
                <X size={18} />
              </IconButton>
            </div>
          )}
          {!activity && (
            <nav className={styles.categories} aria-label="게시판 종류">
              {[
                '전체',
                ...(!parent ? ['질문'] : []),
                '자유',
                '공부 팁',
                '입시',
                ...(!parent && !school ? ['팔로잉'] : []),
              ].map((category) => (
                <button
                  key={category}
                  type="button"
                  aria-pressed={group === category}
                  onClick={() => {
                    setGroup(category);
                    setUnansweredOnly(false);
                    setSubject('');
                  }}
                >
                  {category}
                </button>
              ))}
            </nav>
          )}
          <div className="community-feed-toolbar">
            {school ? (
              <button
                className="community-school-context"
                aria-haspopup="dialog"
                onClick={() => setSchoolInfo(true)}
              >
                <span>{data.profile.school}</span>
                <ChevronDown size={14} />
              </button>
            ) : (
              <span className="community-feed-context">{activity ? '내 활동' : '모든 학교'}</span>
            )}
            <div className={styles.feedTools}>
              {!activity && !parent && group === '질문' && (
                <OptionField
                  compact
                  label="과목 필터"
                  name="feed-subject"
                  value={subject}
                  onChange={setSubject}
                  options={[
                    { value: '', label: '모든 과목' },
                    ...data.subjects.map((s) => ({ value: s.name, label: s.name })),
                  ]}
                />
              )}
              <OptionField
                compact
                label="게시글 정렬"
                name="feed-sort"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'latest', label: '최신순' },
                  { value: 'popular', label: '인기순' },
                ]}
              />
            </div>
          </div>
          {!!draft && !activity && (
            <button className={styles.summaryRow} onClick={() => setComposing('resume')}>
              <span>
                작성하던 글이 있어요
                <span className={styles.summaryMeta}>{draft.title || '제목 없는 글'}</span>
              </span>
              <span>
                이어서 쓰기
                <ChevronRight size={16} />
              </span>
            </button>
          )}
          {!activity && group === '질문' && !!unanswered.length && (
            <button
              className={styles.summaryRow}
              aria-pressed={unansweredOnly}
              onClick={() => {
                setGroup('질문');
                setSubject('');
                setUnansweredOnly((v) => !v);
              }}
            >
              <span>답변 기다리는 내 과목 질문 · {unanswered.length}</span>
              <span>
                {unansweredOnly ? '전체 질문' : '보기'}
                <ChevronRight size={16} />
              </span>
            </button>
          )}
          {error ? (
            <EmptyState
              title="글을 불러오지 못했어요"
              description={error}
              action={
                <Button variant="secondary" onClick={() => setReloadKey((k) => k + 1)}>
                  다시 불러오기
                </Button>
              }
            />
          ) : loading ? (
            <div aria-busy="true" aria-label="이야기를 가져오고 있어요">
              {[0, 1, 2].map((i) => (
                <div key={i} className={styles.skeletonRow}>
                  <span className={styles.skeletonLine} style={{ width: '34%' }} />
                  <span className={`${styles.skeletonLine} ${styles.skeletonTitle}`} />
                  <span className={styles.skeletonLine} style={{ width: '58%' }} />
                </div>
              ))}
            </div>
          ) : !visible.length ? (
            <EmptyState
              title={
                query
                  ? '검색 결과가 없어요'
                  : activity
                    ? '아직 모인 글이 없어요'
                    : group === '팔로잉'
                      ? '팔로우한 사람의 새 글이 여기에 모여요'
                      : group === '질문'
                        ? '첫 질문을 남겨 보세요'
                        : '첫 이야기를 들려주세요'
              }
              description={
                subject || query || unansweredOnly
                  ? '필터를 바꾸거나 검색어를 지워 보세요.'
                  : '문제나 카드를 붙이면 더 쉽게 이야기할 수 있어요.'
              }
              action={
                subject || query || unansweredOnly ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSubject('');
                      setQuery('');
                      setUnansweredOnly(false);
                    }}
                  >
                    필터 초기화
                  </Button>
                ) : undefined
              }
            />
          ) : (
            visible.map((p) => <PostRow key={p.id} post={p} onClick={() => openPost(p)} />)
          )}
          {!activity && group === '팔로잉' && !school && !parent && (
            <section className={styles.following} aria-label="팔로잉의 공개 카드">
              {!following.length && !followingCards.length && (
                <p className={styles.followingEmpty}>
                  도움이 된 답변이나 카드에서 팔로우하면 여기 모여요
                </p>
              )}
              {followingCards.slice(0, 5).map((c) => (
                <button
                  key={c.block.id}
                  className={styles.postRow}
                  onClick={() =>
                    props.navigate(`/community/profile?user=${encodeURIComponent(c.authorId)}`)
                  }
                >
                  <span className={styles.postCopy}>
                    <span className={styles.postTitle}>
                      {String(c.block.payload.front || '공개 학습 카드')}
                    </span>
                    <span className={styles.postMeta}>{c.author} · 공개 카드 보기</span>
                  </span>
                  <ChevronRight size={18} />
                </button>
              ))}
            </section>
          )}
          <div className={styles.fab}>
            <Button onClick={() => setComposing('new')}>
              <PencilLine size={18} />
              글쓰기
            </Button>
          </div>
        </div>
      )}
      {composing && (
        <CommunityComposer
          {...props}
          autoResume={composing === 'resume'}
          scope={school ? 'school' : 'all'}
          initial={{
            category: ['질문', '자유', '공부 팁'].includes(group)
              ? group
              : group === '입시'
                ? '수시'
                : '자유',
          }}
          onClose={() => setComposing(null)}
          onPublished={(post) => {
            setReloadKey((k) => k + 1);
            props.navigate(
              `${base}?${post.school ? 'space=school&' : ''}post=${encodeURIComponent(post.id)}`,
            );
          }}
        />
      )}
      <Sheet open={schoolInfo} onClose={() => setSchoolInfo(false)} title="학교 커뮤니티 안내">
        <div className="layout-section">
          <h3 className="text-lg font-bold break-words">{data.profile.school}</h3>
          <p className="text-sm text-muted">
            프로필에 같은 학교를 등록한 {parent ? '학부모' : '학생'}들과 이야기하는 공간이에요.
          </p>
          <Button variant="outline" onClick={() => props.navigate('/profile')}>
            내 학교 정보 수정
          </Button>
        </div>
      </Sheet>
    </>
  );
}

export function CommunityPostDetail({
  post,
  onBack,
  onChange,
  onRemoved,
  embedded = false,
  ...props
}: ScreenProps & {
  post: Post;
  onBack: () => void;
  onChange: () => Promise<void>;
  onRemoved: () => void;
  embedded?: boolean;
}) {
  const { data, toast } = props;
  const own = post.isMine || post.authorId === data.profile.id;
  const base = communityBase(props);
  const commentThread = useRef<CommentThreadHandle>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false),
    [report, setReport] = useState(false),
    [reason, setReason] = useState('욕설·비방'),
    [blockConfirm, setBlockConfirm] = useState(false),
    [remove, setRemove] = useState(false),
    [editing, setEditing] = useState(false),
    [accept, setAccept] = useState<Comment | null>(null);
  const [cloneAccepted, setCloneAccepted] = useState(false);
  const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const refreshComments = async () => {
    await commentThread.current?.reload();
    await onChange();
  };
  const profile = (id: string) =>
    props.navigate(`/community/profile?user=${encodeURIComponent(id)}`);
  const focusReply = () => commentThread.current?.focus();
  return (
    <>
      {!embedded && (
        <ScreenHeader
          title={post.category}
          back={onBack}
          action={
            <IconButton label="게시글 더 보기" onClick={() => setMenu(true)}>
              <MoreHorizontal size={22} />
            </IconButton>
          }
        />
      )}
      <article className={`page-inset ${styles.detail}`}>
        <div className={styles.detailMeta}>
          {post.anonymous || data.profile.role === 'PARENT' ? (
            <span>{post.author}</span>
          ) : (
            <button onClick={() => profile(post.authorId)}>
              {post.author}
              <ChevronRight size={14} />
            </button>
          )}
          <span>
            {[
              post.tags?.grade,
              post.tags?.subjectName,
              relativeTime(post.createdAt),
              post.editedAt ? '수정됨' : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <h1 className={styles.detailTitle}>{post.title}</h1>
        {post.solvedAt && <span className={styles.solved}>해결됨 · 답변 채택 완료</span>}
        {post.body && <p className={styles.detailBody}>{post.body}</p>}
        <div className="layout-section">
          {post.blocks?.map((b) => (
            <BlockView
              key={b.id}
              block={b}
              postId={post.id}
              data={data}
              navigate={props.navigate}
              toast={toast}
              onChanged={onChange}
              onFeedback={() => focusReply()}
              postAuthor={{ id: post.authorId, name: post.author }}
            />
          ))}
        </div>
        <div className={styles.postActions}>
          <button
            disabled={busy}
            aria-pressed={post.liked}
            onClick={() =>
              run(async () => {
                await api(`/posts/${post.id}/like`, {});
                await onChange();
              })
            }
          >
            <Heart size={18} />
            공감 {post.likes}
          </button>
          <button onClick={() => focusReply()}>
            <MessageCircle size={18} />
            댓글 {post.commentCount}
          </button>
          <button
            disabled={busy}
            aria-pressed={post.saved}
            onClick={() =>
              run(async () => {
                await api(`/posts/${post.id}/save`, {});
                await onChange();
              })
            }
          >
            <Bookmark size={18} />
            {post.saved ? '저장됨' : '저장'}
          </button>
          <button
            onClick={() =>
              run(async () => {
                await navigator.clipboard.writeText(
                  `${post.title}\n${post.body}\n${location.origin}${base}?${post.school ? 'space=school&' : ''}post=${encodeURIComponent(post.id)}`,
                );
                toast('글 링크를 복사했어요');
              })
            }
          >
            <Copy size={18} />
            복사
          </button>
        </div>
        <CommunityComments
          ref={commentThread}
          key={post.id}
          {...props}
          data={data}
          post={post}
          embedded={embedded}
          onChange={onChange}
          onAccept={(comment) => {
            setAccept(comment);
            setCloneAccepted(false);
          }}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </article>
      {editing && (
        <CommunityComposer
          {...props}
          editing={post}
          onClose={() => setEditing(false)}
          onPublished={() => {
            onChange().catch(() => setError('수정한 글을 다시 불러와 주세요.'));
          }}
        />
      )}
      <Sheet open={!!accept} onClose={() => !busy && setAccept(null)} title="이 답으로 해결됐나요?">
        <div className="layout-section">
          <p className="text-sm text-muted">
            글에 해결됨이 표시되고 이 답변을 먼저 보여 줘요. 답변자에게 50P가 한 번 지급돼요. 나중에
            다른 답변으로 바꿀 수 있어요.
          </p>
          <blockquote className={styles.draftPreview}>{accept?.body}</blockquote>
          {accept?.block?.type === 'CARD' && (
            <button
              className={styles.choiceRow}
              aria-pressed={cloneAccepted}
              onClick={() => setCloneAccepted((v) => !v)}
            >
              <span>붙어 있는 카드도 내 보관함에 담기</span>
              {cloneAccepted ? <Check size={18} /> : <Plus size={18} />}
            </button>
          )}
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                if (!accept) return;
                await api(`/posts/${post.id}/accept`, { commentId: accept.id });
                let resultMessage = '해결된 질문으로 표시했어요';
                if (cloneAccepted && accept.block) {
                  try {
                    await api(`/posts/${post.id}/blocks/${accept.block.id}/clone`, {});
                  } catch (e) {
                    resultMessage = `채택은 완료됐어요. 카드 담기: ${(e as Error).message}`;
                  }
                }
                setAccept(null);
                await refreshComments();
                const answerer = accept.authorId;
                if (answerer && !accept.isMine && maySuggestFollow(answerer)) {
                  markFollowSuggested(answerer);
                  toast(`${accept.author}님이 해결을 도왔어요 · 팔로우하면 새 카드를 받아요`, {
                    label: '팔로우',
                    onClick: () =>
                      api('/follow', { userId: answerer, following: true })
                        .then(() => {
                          markFollowed(answerer, true);
                          toast(`${accept.author}님의 새 카드 알림을 받아요`);
                        })
                        .catch((e) => toast((e as Error).message)),
                  });
                } else {
                  toast(resultMessage);
                }
                props.refresh().catch(() => {});
              })
            }
          >
            해결됐어요 · 채택
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setAccept(null)}>
            아직요
          </Button>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      </Sheet>
      <Sheet open={menu} onClose={() => setMenu(false)} title="게시글 관리">
        <div className="layout-group">
          {own ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setMenu(false);
                  setEditing(true);
                }}
              >
                글 수정
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setMenu(false);
                  setRemove(true);
                }}
              >
                글 삭제
              </Button>
            </>
          ) : (
            <>
              {!post.anonymous && (
                <Button
                  variant="secondary"
                  onClick={() =>
                    props.navigate(
                      `${base}?space=messages&peer=${encodeURIComponent(post.authorId)}`,
                    )
                  }
                >
                  쪽지 보내기
                </Button>
              )}
              <Button
                variant="outline"
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
        </div>
      </Sheet>
      <Sheet open={report} onClose={() => !busy && setReport(false)} title="신고 이유를 알려주세요">
        <div className="layout-group">
          {['욕설·비방', '광고·홍보', '개인정보 노출', '부적절한 내용', '잘못된 정보'].map((r) => (
            <button
              key={r}
              className={styles.choiceRow}
              aria-pressed={reason === r}
              onClick={() => setReason(r)}
            >
              {r}
              {reason === r && <Check size={18} />}
            </button>
          ))}
          <p className="text-xs text-muted">익명 글도 신고되면 운영팀이 확인해요.</p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('/reports', { postId: post.id, reason });
                setReport(false);
                toast('신고를 접수했어요');
              })
            }
          >
            신고 접수하기
          </Button>
          {error && <p role="alert">{error}</p>}
        </div>
      </Sheet>
      <Sheet
        open={blockConfirm}
        onClose={() => !busy && setBlockConfirm(false)}
        title="작성자를 차단할까요?"
      >
        <div className="layout-section">
          <p>서로의 글·프로필·쪽지가 보이지 않고 팔로우도 풀려요. 이미 담은 카드는 유지돼요.</p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api('/blocks', { postId: post.id });
                setBlockConfirm(false);
                onRemoved();
                toast('작성자를 차단했어요');
              })
            }
          >
            차단하기
          </Button>
          {error && <p role="alert">{error}</p>}
        </div>
      </Sheet>
      <Sheet open={remove} onClose={() => !busy && setRemove(false)} title="이 글을 삭제할까요?">
        <div className="layout-section">
          <p>
            {post.solvedAt
              ? '채택한 답변이 있어요. 글과 댓글은 더 이상 보이지 않지만, 답변자의 포인트와 이미 담은 카드는 유지돼요.'
              : '글과 댓글이 목록에서 사라져요. 이미 담은 학습 카드는 유지돼요.'}
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api(`/posts/${post.id}`, {}, 'DELETE');
                setRemove(false);
                onRemoved();
                toast('글을 삭제했어요');
              })
            }
          >
            삭제하기
          </Button>
          {error && <p role="alert">{error}</p>}
        </div>
      </Sheet>
    </>
  );
}
