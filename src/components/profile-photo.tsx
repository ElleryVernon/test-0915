'use client';
import { useEffect, useRef, useState } from 'react';
import { Camera } from '@/components/icons';
import { Button } from '@/components/ui';
import { api, apiErrorOf } from '@/lib/api';
import { sessionFetch } from '@/lib/session-boundary';
import { prepareProfilePhoto, PROFILE_PHOTO_ACCEPT } from '@/lib/profile-photo';
import styles from './profile-photo.module.css';

export function ProfilePhoto({
  name,
  url,
  large = false,
}: {
  name: string;
  url?: string;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span className={`${styles.avatar} ${large ? styles.large : ''}`}>
      {url && !failed ? (
        <img src={url} alt={`${name}의 프로필 사진`} onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{name.slice(0, 1)}</span>
      )}
    </span>
  );
}

export function ProfilePhotoEditor({
  name,
  url,
  onSaved,
  onBusy,
}: {
  name: string;
  url?: string;
  onSaved: () => Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Blob | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!selected) {
      setPreview('');
      return;
    }
    const value = URL.createObjectURL(selected);
    setPreview(value);
    return () => URL.revokeObjectURL(value);
  }, [selected]);
  function working(value: boolean) {
    setBusy(value);
    onBusy?.(value);
  }
  async function choose(file?: File) {
    if (!file) return;
    working(true);
    setError('');
    setStatus('');
    setConfirmRemove(false);
    try {
      setSelected(await prepareProfilePhoto(file));
    } catch (e) {
      setError(e instanceof Error ? e.message : '사진을 읽지 못했어요. 다른 사진을 선택해 주세요.');
    } finally {
      working(false);
    }
  }
  async function save(remove = false) {
    if (busy) return;
    working(true);
    setError('');
    setStatus('');
    try {
      if (remove) await api('/profile/photo', undefined, 'DELETE');
      else {
        const response = await sessionFetch('/api/profile/photo', {
          method: 'PUT',
          body: selected,
          headers: { 'Content-Type': 'image/jpeg' },
          signal: AbortSignal.timeout(20_000),
        });
        const result = await response.json();
        if (!response.ok) throw apiErrorOf(response, result, '사진을 저장하지 못했어요.');
      }
      setSelected(null);
      setConfirmRemove(false);
      await onSaved();
      setStatus(remove ? '기본 프로필로 바꿨어요.' : '프로필 사진을 저장했어요.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      working(false);
    }
  }
  return (
    <section className={styles.editor} aria-label="프로필 사진" aria-busy={busy}>
      <ProfilePhoto name={name} url={preview || url} large />
      <input
        ref={input}
        type="file"
        accept={PROFILE_PHOTO_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-label="프로필 사진 파일"
        onChange={(e) => {
          void choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className={styles.actions}>
        <Button
          type="button"
          size="compact"
          variant="secondary"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Camera size={16} />
          {url || selected ? '사진 바꾸기' : '사진 추가'}
        </Button>
        {url && !selected && (
          <Button
            type="button"
            size="compact"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            사진 삭제
          </Button>
        )}
      </div>
      {selected ? (
        <>
          <p className={styles.note}>이 모습으로 보여요. 저장하면 사진에 바로 반영돼요.</p>
          <div className={styles.actions}>
            <Button type="button" size="compact" disabled={busy} onClick={() => void save()}>
              {busy ? '저장 중…' : '사진 저장'}
            </Button>
            <Button
              type="button"
              size="compact"
              variant="ghost"
              disabled={busy}
              onClick={() => setSelected(null)}
            >
              선택 취소
            </Button>
          </div>
        </>
      ) : (
        <p className={styles.note}>
          JPG · PNG · WebP, 최대 5MB
          <br />
          사진은 내 마이 화면에만 보여요.
        </p>
      )}
      {confirmRemove && (
        <div className={styles.remove}>
          <p>사진을 삭제하고 기본 프로필로 바꿀까요?</p>
          <div className={styles.actions}>
            <Button
              type="button"
              size="compact"
              variant="secondary"
              disabled={busy}
              onClick={() => void save(true)}
            >
              사진 삭제하기
            </Button>
            <Button
              type="button"
              size="compact"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              취소
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <p role="status" className={styles.note}>
        {status}
      </p>
    </section>
  );
}
