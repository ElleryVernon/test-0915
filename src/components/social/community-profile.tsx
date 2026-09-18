'use client';
import { useEffect, useState } from 'react';
import type { ScreenProps } from '@/lib/contracts';
import type {
  CommunityBlock,
  CommunityProfileData,
  CommunityVisibility,
} from '@/lib/community-types';
import { api } from '@/lib/api';
import { markFollowed, nicknameCooldown, relationLine } from '@/lib/community-nudges';
import { Button, EmptyState, ScreenHeader, Sheet } from '@/components/ui';
import { Checkbox } from '@/components/ui-choice';
import { ChevronRight, UserRound } from '@/components/icons';
import { useJourneyState } from '../journey';
import { useLiveRefresh, useScreenRefresh } from '../refresh';
import { ExplanationDiagram } from '../study/explanation-diagram';
import styles from './community-profile.module.css';

export const communityProfileHref = (userId: string) =>
  `/community/profile?user=${encodeURIComponent(userId)}`;
export function profileIdentity(profile: CommunityProfileData) {
  return [
    profile.visibility.grade ? profile.grade : '',
    ...(profile.visibility.subjects ? profile.subjects : []),
  ]
    .filter(Boolean)
    .join(' · ');
}
export function profileFollowRestriction(profile: CommunityProfileData, viewerGrade: string) {
  if (profile.following || profile.isMine) return '';
  if (profile.visibility.whoCanFollow === 'NONE') return '이 사용자는 새 팔로우를 받지 않아요.';
  // A hidden grade is deliberately not inferred. The server makes the final access decision.
  if (
    profile.visibility.whoCanFollow === 'SAME_GRADE' &&
    profile.grade &&
    profile.grade !== viewerGrade
  )
    return '같은 학년에게만 팔로우를 허용하고 있어요.';
  return '';
}

export function ProfileIdentity({
  profile,
  navigate,
  onEditNickname,
}: {
  profile: CommunityProfileData;
  navigate: ScreenProps['navigate'];
  onEditNickname?: () => void;
}) {
  const identity = profileIdentity(profile);
  const joined = new Date(profile.joinedAt);
  const relation = relationLine(profile.relation);
  return (
    <section className={styles.identity} aria-label="커뮤니티 프로필">
      <div className={styles.person}>
        <span className={styles.avatar} aria-hidden="true">
          <UserRound size={24} />
        </span>
        <div>
          <h2>
            {profile.nickname}
            {profile.isMine && onEditNickname && (
              <button className={styles.textButton} onClick={onEditNickname}>
                닉네임 바꾸기
              </button>
            )}
          </h2>
          {identity && <p>{identity}</p>}
          {Number.isFinite(joined.valueOf()) && (
            <p>
              {joined.getFullYear()}년 {joined.getMonth() + 1}월부터 함께했어요
            </p>
          )}
        </div>
      </div>
      <dl className={styles.stats}>
        <div>
          <dt>채택된 답변</dt>
          <dd>{profile.stats.accepted}</dd>
        </div>
        <div>
          <dt>담긴 카드</dt>
          <dd>{profile.stats.cardsCloned}</dd>
        </div>
        <div>
          <dt>도움 준 사람</dt>
          <dd>{profile.stats.helpedUsers}</dd>
        </div>
      </dl>
      {relation && <p className={styles.relation}>{relation}</p>}
      <div className={styles.relationships}>
        {profile.isMine ? (
          <button className={styles.textButton} onClick={() => navigate('/following')}>
            팔로잉 {profile.followingCount}
            <ChevronRight size={14} />
          </button>
        ) : (
          <span>팔로잉 {profile.followingCount}</span>
        )}
        {profile.visibility.followerCount && profile.followers !== undefined ? (
          <span>팔로워 {profile.followers}</span>
        ) : (
          <span>팔로워 비공개</span>
        )}
      </div>
      {profile.isMine && (
        <button className={styles.textButton} onClick={() => navigate('/followers')}>
          나만 보는 팔로워 목록{profile.followers !== undefined ? ` · ${profile.followers}명` : ''}
          <ChevronRight size={14} />
        </button>
      )}
    </section>
  );
}

function ProfileCard({
  block,
  mine,
  props,
  onChanged,
}: {
  block: CommunityBlock;
  mine: boolean;
  props: ScreenProps;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const isPublic = block.payload.public === true;
  async function setPublic(value: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await api(
        `/community/cards/${encodeURIComponent(block.refId || block.id)}`,
        { public: value },
        'PATCH',
      );
      props.toast(value ? '프로필에 카드를 공개했어요' : '카드를 비공개로 바꿨어요');
      setPublishing(false);
      onChanged();
    } catch (e) {
      props.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function clone() {
    if (busy || saved) return;
    setBusy(true);
    try {
      await api(`/community/cards/${encodeURIComponent(block.refId || block.id)}/clone`, {});
      setSaved(true);
      props.toast('내 가림 카드에 담았어요');
      void props.refresh();
    } catch (e) {
      props.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={styles.card}>
      <div className={styles.cardMeta}>
        <span>{block.payload.subjectName || '학습 카드'}</span>
        {mine && <span>{isPublic ? '공개 중' : '나만 보기'}</span>}
      </div>
      <h3>{String(block.payload.front || '가림 카드')}</h3>
      {block.payload.diagram && (
        <ExplanationDiagram
          explanation={{
            version: 1,
            status: 'READY',
            questionId: block.id,
            citation: '',
            optionReasons: [],
            microChecks: [],
            source: 'rule',
            diagram: block.payload.diagram,
          }}
          maskedNodeIds={block.payload.maskedNodeIds ?? []}
          revealed={revealed}
          interactive={false}
          depth="FULL"
        />
      )}
      {typeof block.payload.image === 'string' && block.payload.image && (
        <div className="recall-image">
          <img src={block.payload.image} alt="학습 카드 이미지" draggable={false} />
          {!revealed &&
            Array.isArray(block.payload.masks) &&
            block.payload.masks.map(
              (mask: { x: number; y: number; width: number; height: number }, i: number) => (
                <span
                  key={i}
                  className="recall-mask"
                  style={{
                    left: `${mask.x}%`,
                    top: `${mask.y}%`,
                    width: `${mask.width}%`,
                    height: `${mask.height}%`,
                  }}
                />
              ),
            )}
        </div>
      )}
      <details className={styles.cardAnswer} onToggle={(e) => setRevealed(e.currentTarget.open)}>
        <summary>카드 뒷면 보기</summary>
        <p>{String(block.payload.back || '이미지·다이어그램의 가린 부분을 확인해 주세요.')}</p>
      </details>
      {mine ? (
        <Button
          variant="outline"
          size="compact"
          disabled={busy}
          onClick={() => (isPublic ? void setPublic(false) : setPublishing(true))}
        >
          {busy ? '변경 중…' : isPublic ? '비공개로 바꾸기' : '프로필에 공개'}
        </Button>
      ) : (
        <Button variant="outline" size="compact" disabled={busy || saved} onClick={clone}>
          {busy ? '담는 중…' : saved ? '내 카드에 담았어요' : '내 카드에 담기'}
        </Button>
      )}
      <Sheet
        open={publishing}
        onClose={() => {
          if (!busy) setPublishing(false);
        }}
        title="이 카드를 공개할까요?"
        description="앞면과 뒷면이 프로필에 보이고, 다른 학생이 자신의 학습 카드로 담을 수 있어요."
      >
        <div className={styles.stack}>
          <p className={styles.hint}>
            학교·실명 등 개인 정보가 없는지 확인해 주세요. 나중에 비공개로 바꿔도 이미 담긴 사본은
            남아요.
          </p>
          <Button className={styles.inkButton} disabled={busy} onClick={() => void setPublic(true)}>
            {busy ? '공개 중…' : '확인하고 공개'}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setPublishing(false)}>
            계속 나만 보기
          </Button>
        </div>
      </Sheet>
    </article>
  );
}

export function PublicCommunityProfile(props: ScreenProps & { userId: string }) {
  const [profile, setProfile] = useState<CommunityProfileData | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [unfollow, setUnfollow] = useState(false);
  const [nickOpen, setNickOpen] = useState(false);
  const [nickname, setNickname] = useState('');
  const [nickError, setNickError] = useState('');
  const [tab, setTab] = useJourneyState<'cards' | 'answers' | 'posts'>(
    'community.profile.tab',
    'cards',
  );
  const parent = props.data.profile.role === 'PARENT';
  const refreshProfile = useLiveRefresh(
    async (signal) => {
      const next = await api<CommunityProfileData>(
        `/community/profiles/${encodeURIComponent(props.userId)}`,
        undefined,
        'GET',
        { signal },
      );
      if (!signal?.aborted) {
        setProfile(next);
        setError('');
      }
    },
    { interval: 60_000, enabled: !parent, resource: props.userId },
  );
  useScreenRefresh(refreshProfile, !parent);
  useEffect(() => {
    if (parent) return;
    let active = true;
    setError('');
    api<CommunityProfileData>(`/community/profiles/${encodeURIComponent(props.userId)}`)
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch((e) => {
        if (active) {
          setProfile(null);
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [props.userId, reload, parent]);
  async function follow(value: boolean) {
    if (!profile || busy) return;
    setBusy(true);
    try {
      await api('/follow', { userId: profile.id, following: value });
      markFollowed(profile.id, value);
      setProfile((current) =>
        current
          ? {
              ...current,
              following: value,
              followers:
                current.followers === undefined
                  ? undefined
                  : Math.max(0, current.followers + (value ? 1 : -1)),
            }
          : current,
      );
      setUnfollow(false);
      props.toast(value ? '새 글과 공개 카드를 팔로잉에서 볼 수 있어요' : '팔로우를 해제했어요');
    } catch (e) {
      props.toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveNickname() {
    if (!profile || busy) return;
    const next = nickname.trim();
    if (!next || next === profile.nickname) return;
    setBusy(true);
    setNickError('');
    try {
      const result = await api<{ visibility: CommunityVisibility }>(
        '/community/profile',
        { nickname: next },
        'PATCH',
      );
      setProfile((current) =>
        current ? { ...current, nickname: next, visibility: result.visibility } : current,
      );
      setNickOpen(false);
      props.toast('닉네임을 바꿨어요. 다음 변경은 30일 뒤에 할 수 있어요.');
      props.refresh().catch(() => {});
    } catch (e) {
      setNickError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const restriction = profile ? profileFollowRestriction(profile, props.data.profile.grade) : '';
  const cooldown = nicknameCooldown(profile?.visibility.nicknameChangedAt);
  return (
    <>
      <ScreenHeader
        title={profile?.isMine ? '내 커뮤니티 프로필' : '커뮤니티 프로필'}
        back={() => props.back('/community')}
        action={
          profile?.isMine ? (
            <Button
              variant="ghost"
              size="compact"
              onClick={() => props.navigate('/community/privacy')}
            >
              공개 설정
            </Button>
          ) : undefined
        }
      />
      <div className={`page-inset ${styles.page}`}>
        {parent ? (
          <EmptyState
            title="학생의 학습 활동을 위한 프로필이에요"
            description="학부모 커뮤니티와 쪽지는 기존처럼 이용할 수 있어요."
            action={
              <Button variant="outline" onClick={() => props.navigate('/parent-boards')}>
                학부모 커뮤니티로
              </Button>
            }
          />
        ) : error ? (
          <EmptyState
            title="프로필을 열 수 없어요"
            description={error}
            action={
              <Button variant="outline" onClick={() => setReload((v) => v + 1)}>
                다시 확인
              </Button>
            }
          />
        ) : !profile ? (
          <p role="status" className={styles.hint}>
            프로필을 가져오고 있어요…
          </p>
        ) : (
          <>
            <ProfileIdentity
              profile={profile}
              navigate={props.navigate}
              onEditNickname={() => {
                setNickname(profile.nickname);
                setNickError('');
                setNickOpen(true);
              }}
            />
            {!profile.isMine && (
              <div className={styles.stack}>
                <div className={styles.actions}>
                  <Button
                    className={profile.following ? '' : styles.inkButton}
                    variant={profile.following ? 'outline' : 'primary'}
                    disabled={busy || !!restriction}
                    onClick={() => (profile.following ? setUnfollow(true) : void follow(true))}
                  >
                    {busy ? '변경 중…' : profile.following ? '팔로잉 · 새 활동 보기' : '팔로우'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      props.navigate(
                        `/community?space=messages&peer=${encodeURIComponent(profile.id)}`,
                      )
                    }
                  >
                    쪽지
                  </Button>
                </div>
                <p className={styles.hint}>
                  {restriction || '팔로우하면 새 글과 공개 카드를 모아 볼 수 있어요.'}
                </p>
              </div>
            )}
            {profile.isMine && (
              <p className={styles.hint}>
                익명 글과 학교 정보는 이 프로필에 표시하지 않아요. 비공개 카드는 나에게만 보여요.
              </p>
            )}
            <div className={styles.tabs} aria-label="프로필 활동">
              {(
                [
                  ['cards', '카드', profile.cards.length],
                  ['answers', '답변', profile.answers.length],
                  ['posts', '글', profile.posts.length],
                ] as const
              ).map(([id, label, count]) => (
                <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>
                  {label} <span>{count}</span>
                </button>
              ))}
            </div>
            <section
              className={styles.stack}
              aria-label={
                tab === 'cards' ? '학습 카드' : tab === 'answers' ? '작성한 답변' : '작성한 글'
              }
            >
              {tab === 'cards' ? (
                profile.cards.length ? (
                  profile.cards.map((card) => (
                    <ProfileCard
                      key={card.id}
                      block={card}
                      mine={profile.isMine}
                      props={props}
                      onChanged={() => setReload((v) => v + 1)}
                    />
                  ))
                ) : (
                  <EmptyState
                    title={profile.isMine ? '아직 학습 카드가 없어요' : '공개한 카드가 없어요'}
                    description={
                      profile.isMine
                        ? '학습하면서 만든 카드를 이곳에서 공개할 수 있어요.'
                        : '공개한 카드가 생기면 여기에 보여요.'
                    }
                  />
                )
              ) : tab === 'answers' ? (
                profile.answers.length ? (
                  profile.answers.map((answer, i) => (
                    <button
                      key={`${answer.postId}-${i}`}
                      className={styles.activity}
                      onClick={() =>
                        props.navigate(`/community?post=${encodeURIComponent(answer.postId)}`)
                      }
                    >
                      <span className={styles.cardMeta}>
                        {answer.accepted ? '채택된 답변' : '답변'}
                      </span>
                      <strong>{answer.postTitle}</strong>
                      <p>{answer.body}</p>
                      <span className={styles.openLabel}>
                        질문과 답변 보기 <ChevronRight size={16} />
                      </span>
                    </button>
                  ))
                ) : (
                  <EmptyState
                    title="아직 공개된 답변이 없어요"
                    description="익명으로 작성한 활동은 여기에 연결하지 않아요."
                  />
                )
              ) : profile.posts.length ? (
                profile.posts.map((post) => (
                  <button
                    key={post.id}
                    className={styles.activity}
                    onClick={() => props.navigate(`/community?post=${encodeURIComponent(post.id)}`)}
                  >
                    <strong>{post.title}</strong>
                    <p>{post.body}</p>
                    <span className={styles.openLabel}>
                      글 보기 <ChevronRight size={16} />
                    </span>
                  </button>
                ))
              ) : (
                <EmptyState
                  title="아직 공개된 글이 없어요"
                  description="익명 글은 여기에 표시하지 않아요."
                />
              )}
            </section>
          </>
        )}
      </div>
      <Sheet
        open={unfollow}
        onClose={() => {
          if (!busy) setUnfollow(false);
        }}
        title="팔로우를 그만할까요?"
        description="이 사람의 새 글과 공개 카드가 팔로잉에 모이지 않아요. 이미 담은 카드는 유지돼요."
      >
        <div className={styles.stack}>
          <Button variant="outline" disabled={busy} onClick={() => setUnfollow(false)}>
            계속 받아보기
          </Button>
          <Button className={styles.inkButton} disabled={busy} onClick={() => void follow(false)}>
            {busy ? '변경 중…' : '팔로우 해제'}
          </Button>
        </div>
      </Sheet>
      <Sheet
        open={nickOpen}
        onClose={() => {
          if (!busy) setNickOpen(false);
        }}
        title="닉네임 바꾸기"
        description="닉네임은 30일에 한 번 바꿀 수 있어요. 익명 글에는 어떤 닉네임도 표시되지 않아요."
      >
        <div className={styles.stack}>
          {cooldown.allowed ? (
            <>
              <input
                className={styles.nicknameInput}
                value={nickname}
                maxLength={24}
                onChange={(e) => setNickname(e.target.value)}
                aria-label="새 닉네임"
                placeholder="1~12자"
              />
              <Button
                className={styles.inkButton}
                disabled={busy || !nickname.trim() || nickname.trim() === profile?.nickname}
                onClick={() => void saveNickname()}
              >
                {busy ? '바꾸는 중…' : '닉네임 저장'}
              </Button>
            </>
          ) : (
            <p className={styles.hint}>{cooldown.daysLeft}일 뒤에 다시 바꿀 수 있어요.</p>
          )}
          {nickError && (
            <p role="alert" className="text-danger">
              {nickError}
            </p>
          )}
        </div>
      </Sheet>
    </>
  );
}

export function CommunityPrivacySettings(props: ScreenProps) {
  const [visibility, setVisibility] = useJourneyState<CommunityVisibility | null>(
    'community.privacy.draft',
    null,
  );
  const [saved, setSaved] = useState<CommunityVisibility | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [leave, setLeave] = useState(false);
  const parent = props.data.profile.role === 'PARENT';
  const dirty = !!saved && !!visibility && JSON.stringify(saved) !== JSON.stringify(visibility);
  useEffect(() => {
    if (parent) return;
    let active = true;
    setError('');
    api<CommunityProfileData>(`/community/profiles/${encodeURIComponent(props.data.profile.id)}`)
      .then((p) => {
        if (active) {
          setVisibility((current) => current ?? p.visibility);
          setSaved(p.visibility);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [props.data.profile.id, parent, reload]);
  async function save() {
    if (!visibility || busy || !dirty) return;
    setBusy(true);
    setError('');
    try {
      await api('/community/profile', { visibility }, 'PATCH');
      setSaved(visibility);
      props.toast('공개 설정을 저장했어요');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const goBack = () => props.back(communityProfileHref(props.data.profile.id));
  return (
    <>
      <ScreenHeader title="커뮤니티 공개 설정" back={() => (dirty ? setLeave(true) : goBack())} />
      <div className={`page-inset ${styles.page}`}>
        {parent ? (
          <EmptyState
            title="학생 프로필에서 사용하는 설정이에요"
            description="학부모의 개인 정보는 공개 프로필에 표시하지 않아요."
          />
        ) : !visibility ? (
          <>
            {error ? (
              <EmptyState
                title="설정을 가져오지 못했어요"
                description={error}
                action={
                  <Button variant="outline" onClick={() => setReload((v) => v + 1)}>
                    다시 불러오기
                  </Button>
                }
              />
            ) : (
              <p role="status">설정을 가져오고 있어요…</p>
            )}
          </>
        ) : (
          <>
            <section className={styles.stack}>
              <h2>프로필에 보이는 정보</h2>
              <p className={styles.hint}>
                실명·학교·생년월일은 공개하지 않아요. 학년과 과목은 학습 설정에 등록한 정보를
                사용해요.
              </p>
              {(
                [
                  ['grade', '학년 공개', '내 학년을 프로필에 표시해요'],
                  ['subjects', '과목 공개', '공부하는 과목을 프로필에 표시해요'],
                  ['followerCount', '팔로워 수 공개', '꺼두면 나만 팔로워 수를 볼 수 있어요'],
                  [
                    'cardsDefault',
                    '새 카드 기본 공개',
                    '켜면 앞으로 만드는 카드가 프로필에 공개돼요. 기존 카드 설정은 유지돼요.',
                  ],
                ] as const
              ).map(([key, label, description]) => (
                <div className={styles.setting} key={key}>
                  <Checkbox
                    checked={visibility[key]}
                    disabled={busy}
                    onChange={(value) => setVisibility({ ...visibility, [key]: value })}
                  >
                    <strong>{label}</strong>
                    <span className={styles.settingHint}>{description}</span>
                  </Checkbox>
                </div>
              ))}
            </section>
            <fieldset className={styles.stack}>
              <legend>나를 팔로우할 수 있는 사람</legend>
              <p className={styles.hint}>새 팔로우에 적용해요. 이미 연결된 팔로우는 유지돼요.</p>
              <div className={styles.options}>
                {(
                  [
                    ['SAME_GRADE', '같은 학년'],
                    ['ALL', '모든 학생'],
                    ['NONE', '새 팔로우 받지 않기'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name="whoCanFollow"
                      value={value}
                      checked={visibility.whoCanFollow === value}
                      disabled={busy}
                      onChange={() => setVisibility({ ...visibility, whoCanFollow: value })}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error && (
              <p role="alert" className={styles.error}>
                {error}
              </p>
            )}
            <Button className={styles.inkButton} disabled={busy || !dirty} onClick={save}>
              {busy ? '저장 중…' : dirty ? '변경 내용 저장' : '저장된 설정이에요'}
            </Button>
          </>
        )}
      </div>
      <Sheet
        open={leave}
        onClose={() => setLeave(false)}
        title="변경 내용을 저장하지 않았어요"
        description="설정을 유지하려면 돌아가서 저장해 주세요."
      >
        <div className={styles.stack}>
          <Button className={styles.inkButton} onClick={() => setLeave(false)}>
            계속 설정하기
          </Button>
          <Button variant="outline" onClick={goBack}>
            저장하지 않고 나가기
          </Button>
        </div>
      </Sheet>
    </>
  );
}
