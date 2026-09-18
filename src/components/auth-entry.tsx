'use client';
import { useEffect, useState } from 'react';
import { ArrowRight, GraduationCap, Heart } from './icons';
import { Button } from './ui';
import { api } from '@/lib/api';
import { retryAtOf, useRetryCountdown, waitingLabel } from '@/lib/retry-countdown';
import type { Role } from '@/lib/contracts';
import styles from './auth-entry.module.css';

type Config = { demo: boolean; providers: string[]; authOrigin: string };
const names: Record<string, string> = {
  google: 'Google',
  kakao: '카카오',
  naver: '네이버',
  apple: 'Apple',
};

function ProviderMark({ provider }: { provider: string }) {
  if (provider === 'google')
    return (
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
        <path
          fill="#4285F4"
          d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.61 4.61 0 0 1-2 3.02v2.51h3.24c1.89-1.74 2.98-4.31 2.98-7.36Z"
        />
        <path
          fill="#34A853"
          d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.05v2.59A10 10 0 0 0 12 22Z"
        />
        <path
          fill="#FBBC05"
          d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.05a10 10 0 0 0 0 9.02l3.35-2.59Z"
        />
        <path
          fill="#EA4335"
          d="M12 5.96c1.47 0 2.79.51 3.82 1.51l2.86-2.86A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.95 5.49l3.35 2.59C7.19 7.72 9.4 5.96 12 5.96Z"
        />
      </svg>
    );
  if (provider === 'kakao')
    return (
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M12 3C6.5 3 2 6.5 2 10.8c0 2.8 1.9 5.3 4.8 6.7l-1 3.8c0 .2.2.3.4.2l4.3-2.9H12c5.5 0 10-3.5 10-7.8S17.5 3 12 3Z"
        />
      </svg>
    );
  return (
    <span aria-hidden="true" className={styles.providerLetter}>
      {provider === 'naver' ? 'N' : '●'}
    </span>
  );
}

export default function AuthEntry({
  demoPage,
  onLogin,
  retryAt: initialRetryAt = null,
}: {
  demoPage: boolean;
  onLogin: (role: Role) => Promise<void>;
  retryAt?: number | null;
}) {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<Role | null>(null);
  const [retryAt, setRetryAt] = useState(initialRetryAt);
  const retryIn = useRetryCountdown(retryAt);
  useEffect(() => {
    if (initialRetryAt) setRetryAt(initialRetryAt);
  }, [initialRetryAt]);
  async function load() {
    setError('');
    try {
      setConfig(await api<Config>('/config'));
    } catch {
      setError('로그인 서비스를 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.');
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function start(role: Role) {
    setBusy(role);
    setError('');
    try {
      await onLogin(role);
    } catch (e) {
      setError((e as Error).message);
      setRetryAt(retryAtOf(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <main className={styles.entry}>
      <section className={styles.intro} aria-label="memoryz">
        <h1 className={styles.brand}>
          memoryz<span>.</span>
        </h1>
        {demoPage ? (
          <>
            <span className={styles.demoBadge}>데모 체험</span>
            <p className={styles.demoDescription}>
              샘플 자료로 학생·학부모 기능을 둘러보세요.
              <br />
              다른 체험 사용자와 데이터가 공유됩니다.
            </p>
          </>
        ) : (
          <p className={styles.tagline}>
            배운 순간을,
            <br />
            오래 남는 기억으로.
          </p>
        )}
      </section>
      <section className={styles.signIn} aria-label={demoPage ? '데모 계정 선택' : '소셜 로그인'}>
        <h2 className={demoPage ? undefined : 'sr-only'}>
          {demoPage ? '어떤 역할로 체험할까요?' : '로그인 또는 회원가입'}
        </h2>
        {!config && !error && <p role="status">로그인 수단을 확인하고 있어요…</p>}
        {demoPage ? (
          config?.demo ? (
            <>
              <Button
                disabled={!!busy || retryIn > 0}
                className="w-full"
                onClick={() => start('STUDENT')}
              >
                <GraduationCap size={20} />
                {busy === 'STUDENT'
                  ? '학생 체험을 여는 중…'
                  : waitingLabel('학생으로 체험하기', retryIn)}
              </Button>
              <Button
                disabled={!!busy || retryIn > 0}
                variant="secondary"
                className="w-full"
                onClick={() => start('PARENT')}
              >
                <Heart size={19} />
                {busy === 'PARENT'
                  ? '학부모 체험을 여는 중…'
                  : waitingLabel('학부모로 체험하기', retryIn)}
              </Button>
            </>
          ) : (
            config && <p role="status">현재는 데모 체험을 제공하지 않아요.</p>
          )
        ) : (
          config && (
            <>
              {['kakao', 'naver', 'google', 'apple']
                .filter((p) => config.providers.includes(p))
                .map((p) =>
                  retryIn > 0 ? (
                    <button key={p} className={styles.provider} disabled>
                      {waitingLabel(`${names[p]}로 계속하기`, retryIn)}
                    </button>
                  ) : (
                    <a
                      key={p}
                      className={`${styles.provider} ${styles[p] || ''}`}
                      href={`${config.authOrigin}/api/auth/${p}`}
                    >
                      <ProviderMark provider={p} />
                      <span>{names[p]}로 계속하기</span>
                      <span />
                    </a>
                  ),
                )}
              {!config.providers.length && (
                <p role="alert">
                  로그인 서비스 연결을 준비하고 있어요. 잠시 후 다시 방문해 주세요.
                </p>
              )}
            </>
          )
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
            {!config && (
              <Button variant="ghost" onClick={load}>
                다시 불러오기
              </Button>
            )}
          </div>
        )}
        {retryIn > 0 && <p role="status">요청이 많아요. {retryIn}초 후 다시 시작할 수 있어요.</p>}
        <p className={styles.footnote}>
          {demoPage
            ? '실제 학습은 내 계정으로 시작해 주세요.'
            : '처음이라면 로그인 후 가입이 이어져요.'}
        </p>
        {demoPage && (
          <a className={styles.loginLink} href="/login">
            내 계정으로 로그인하기 <ArrowRight size={16} />
          </a>
        )}
      </section>
    </main>
  );
}
