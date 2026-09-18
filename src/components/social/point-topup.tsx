'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import type { ScreenProps } from '@/lib/contracts';
import { loadPaymentSDK, topupAmount, type PointOrder, type PointWallet } from '@/lib/point-topup';
import { Button, ScreenHeader } from '@/components/ui';
import styles from './point-topup.module.css';
const money = (n: number) => n.toLocaleString('ko-KR');
const stateLabel = {
  READY: '결제 전',
  VERIFYING: '결과 확인 중',
  DONE: '충전 완료',
  FAILED: '결제 미완료',
};

export default function PointTopup(props: ScreenProps) {
  const [wallet, setWallet] = useState<PointWallet | null>(null);
  const [raw, setRaw] = useState('10000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [terminalFailure, setTerminalFailure] = useState(false);
  const [done, setDone] = useState<PointOrder | null>(null);
  const attempt = useRef<{ amount: number; id: string } | null>(null);
  const confirming = useRef(false);
  const amount = topupAmount(raw);
  const query = new URLSearchParams(props.path.split('?')[1]);
  const paymentKey = query.get('paymentKey'),
    orderId = query.get('orderId'),
    returnedAmount = query.get('amount');
  const failed = query.get('result') === 'fail';
  const returning = Boolean(paymentKey && orderId);
  const reload = useCallback(async () => setWallet(await api<PointWallet>('/points')), []);
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, [reload]);
  async function syncBalance() {
    const outcomes = await Promise.allSettled([reload(), props.refresh()]);
    if (outcomes.some((result) => result.status === 'rejected'))
      setError('충전은 완료됐지만 잔액을 다시 불러오지 못했어요. 잔액을 갱신해 주세요.');
  }
  async function confirm() {
    if (confirming.current || !paymentKey || !orderId) return;
    confirming.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<PointOrder>('/points/confirm', {
        paymentKey,
        orderId,
        amount: Number(returnedAmount),
      });
      setDone(result);
      await syncBalance();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.code === 'PAYMENT_FAILED') {
        setTerminalFailure(true);
        void reload();
      }
    } finally {
      confirming.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (returning) void confirm(); /* confirmation uses the server's idempotent order */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentKey, orderId]);
  async function pay() {
    if (
      busy ||
      wallet?.orders.some((o) => o.status === 'VERIFYING') ||
      amount === null ||
      !wallet ||
      wallet.mode === 'unavailable'
    )
      return;
    setBusy(true);
    setError('');
    try {
      const factory = await loadPaymentSDK();
      if (!attempt.current || attempt.current.amount !== amount)
        attempt.current = { amount, id: crypto.randomUUID() };
      const result = await api<{ order: PointOrder; clientKey: string; customerKey: string }>(
        '/points/orders',
        { amount, requestId: attempt.current.id },
      );
      if (result.order.status === 'DONE') {
        setDone(result.order);
        await reload();
        return;
      }
      if (result.order.status !== 'READY') {
        await reload();
        throw new Error('이 주문은 이미 진행됐어요. 충전 내역에서 결과를 확인해 주세요.');
      }
      await factory(result.clientKey)
        .payment({ customerKey: result.customerKey })
        .requestPayment({
          method: 'CARD',
          amount: { currency: 'KRW', value: result.order.amount },
          orderId: result.order.id,
          orderName: `응원 포인트 ${money(result.order.amount)}P`,
          successUrl: `${location.origin}/points?result=success`,
          failUrl: `${location.origin}/points?result=fail`,
        });
    } catch (e) {
      setError((e as Error).message || '결제창이 닫혔어요. 충전 내역에서 결과를 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  }
  async function check(order: PointOrder) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<PointOrder>(
        `/points/orders/${encodeURIComponent(order.id)}/check`,
        {},
      );
      await reload();
      if (result.status === 'DONE') {
        setDone(result);
        await syncBalance();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (props.data.profile.role !== 'PARENT')
    return (
      <>
        <ScreenHeader title="포인트 충전" back={() => props.back('/profile')} />
        <p className="page-inset">학부모 계정에서 이용할 수 있어요.</p>
      </>
    );
  const unavailable = wallet?.mode === 'unavailable';
  const unresolved = wallet?.orders.some((o) => o.status === 'VERIFYING');
  return (
    <>
      <ScreenHeader title="포인트 충전" back={() => props.back('/cheer')} />
      <div className={styles.page}>
        {done ? (
          <section className={styles.status} role="status">
            <h1>{money(done.amount)}P 충전했어요</h1>
            <p>{money(done.amount)}원 결제가 확인됐어요.</p>
            {done.mode === 'test' && (
              <p className={styles.notice}>테스트 충전이에요. 실제 결제는 발생하지 않았어요.</p>
            )}
            {error && (
              <div role="alert">
                <p className="text-danger">{error}</p>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    setError('');
                    await syncBalance();
                  }}
                >
                  잔액 다시 불러오기
                </Button>
              </div>
            )}
            <Button onClick={() => props.navigate('/cheer', { replace: true })}>
              응원 보내러 가기
            </Button>
            <Button
              variant="secondary"
              onClick={() => props.navigate('/points', { replace: true })}
            >
              충전 내역 보기
            </Button>
          </section>
        ) : returning ? (
          <section className={styles.status}>
            <h1>
              {terminalFailure
                ? '결제가 완료되지 않았어요'
                : busy
                  ? '결제 결과를 확인하고 있어요'
                  : '결제 결과 확인이 필요해요'}
            </h1>
            <p className={styles.notice}>
              확인이 끝나면 포인트가 반영돼요. 이 화면에서 같은 주문을 확인할 수 있어요.
            </p>
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <Button disabled={busy || terminalFailure} onClick={confirm}>
              {busy ? '확인 중…' : '이 주문 다시 확인하기'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => props.navigate('/points', { replace: true })}
            >
              충전 내역으로
            </Button>
          </section>
        ) : (
          <>
            <div className={styles.balance}>
              <span>보유 포인트</span>
              <strong>{money(wallet?.balance ?? props.data.profile.points)}P</strong>
            </div>
            {failed && (
              <p className={styles.notice} role="status">
                {query.get('code') === 'PAY_PROCESS_CANCELED'
                  ? '결제를 취소했어요.'
                  : '결제를 완료하지 못했어요.'}{' '}
                포인트는 승인 확인 후 반영돼요.
              </p>
            )}
            {unresolved && (
              <p className={styles.notice}>
                확인 중인 충전이 있어요. 아래 충전 내역에서 결과를 먼저 확인해 주세요.
              </p>
            )}
            {unavailable && (
              <p className={styles.notice} role="status">
                포인트 충전을 준비하고 있어요. 결제 연결이 완료되면 이용할 수 있어요.
              </p>
            )}
            {wallet?.mode === 'test' && (
              <p className={styles.notice}>테스트 결제 · 실제 금액은 청구되지 않아요.</p>
            )}
            <div className={styles.amount}>
              <label htmlFor="topup-amount">얼마를 충전할까요?</label>
              <div className={styles.input}>
                <input
                  id="topup-amount"
                  inputMode="numeric"
                  maxLength={6}
                  value={raw}
                  onChange={(e) => setRaw(e.target.value.replace(/\D/g, ''))}
                  aria-describedby="topup-rule"
                />
                <span>원</span>
              </div>
              <small id="topup-rule">1원 = 1P · 1,000원부터 100,000원까지</small>
              <div className={styles.presets}>
                {[5000, 10000, 30000].map((n) => (
                  <Button
                    key={n}
                    variant={amount === n ? 'neutral' : 'secondary'}
                    className="btn-compact"
                    aria-pressed={amount === n}
                    onClick={() => setRaw(String(n))}
                  >
                    {money(n)}원
                  </Button>
                ))}
              </div>
            </div>
            <dl className={styles.summary}>
              <div>
                <dt>결제 금액</dt>
                <dd>{amount === null ? '—' : `${money(amount)}원`}</dd>
              </div>
              <div>
                <dt>받을 포인트</dt>
                <dd>{amount === null ? '—' : `${money(amount)}P`}</dd>
              </div>
            </dl>
            <div className={styles.actions}>
              {!wallet && error && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setError('');
                    void reload().catch((e) => setError(e.message));
                  }}
                >
                  충전 정보 다시 불러오기
                </Button>
              )}
              {error && (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
              <Button
                disabled={busy || !wallet || unavailable || unresolved || amount === null}
                onClick={pay}
              >
                {busy
                  ? '결제창 여는 중…'
                  : unavailable
                    ? '충전 준비 중'
                    : unresolved
                      ? '이전 충전 결과 확인 필요'
                      : amount === null
                        ? '충전 금액을 입력해 주세요'
                        : `${money(amount)}원 결제하기`}
              </Button>
              <p className="text-xs text-muted text-center">
                {!unavailable && '카드·간편결제는 다음 화면에서 선택해요.'}
              </p>
            </div>
          </>
        )}
        {!returning && wallet && (
          <section className={styles.history}>
            <h2>최근 충전 내역</h2>
            {wallet.orders.length === 0 ? (
              <p className="text-sm text-muted">충전한 내역이 여기에 표시돼요.</p>
            ) : (
              wallet.orders.map((order) => (
                <div className={styles.order} key={order.id}>
                  <div>
                    <p>
                      {money(order.amount)}P {order.mode === 'test' ? '· 테스트' : ''}
                    </p>
                    <small>
                      {new Date(order.createdAt).toLocaleDateString('ko-KR')} ·{' '}
                      {stateLabel[order.status]}
                    </small>
                  </div>
                  {order.status === 'VERIFYING' && (
                    <Button
                      variant="secondary"
                      className="btn-compact"
                      disabled={busy}
                      onClick={() => check(order)}
                    >
                      결과 확인
                    </Button>
                  )}
                </div>
              ))
            )}
          </section>
        )}
      </div>
    </>
  );
}
