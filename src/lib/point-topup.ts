export const TOPUP_MIN = 1_000;
export const TOPUP_MAX = 100_000;
export function topupAmount(raw: string) {
  if (!/^\d+$/.test(raw)) return null;
  const amount = Number(raw);
  return Number.isSafeInteger(amount) && amount >= TOPUP_MIN && amount <= TOPUP_MAX ? amount : null;
}
interface PaymentRequest {
  method: 'CARD';
  amount: { currency: 'KRW'; value: number };
  orderId: string;
  orderName: string;
  successUrl: string;
  failUrl: string;
}
type TossFactory = (key: string) => {
  payment: (options: { customerKey: string }) => {
    requestPayment: (options: PaymentRequest) => Promise<void>;
  };
};
declare global {
  interface Window {
    TossPayments?: TossFactory;
  }
}
let sdk: Promise<TossFactory> | undefined;
export function loadPaymentSDK(): Promise<TossFactory> {
  if (window.TossPayments) return Promise.resolve(window.TossPayments);
  if (sdk) return sdk;
  sdk = new Promise<TossFactory>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://js.tosspayments.com/v2/standard';
    script.async = true;
    const fail = () => {
      script.remove();
      sdk = undefined;
      reject(new Error('결제창을 불러오지 못했어요. 연결을 확인하고 다시 시도해 주세요.'));
    };
    const timeout = window.setTimeout(fail, 12_000);
    script.onload = () => {
      window.clearTimeout(timeout);
      if (window.TossPayments) resolve(window.TossPayments);
      else fail();
    };
    script.onerror = () => {
      window.clearTimeout(timeout);
      fail();
    };
    document.head.appendChild(script);
  });
  return sdk;
}
export interface PointOrder {
  id: string;
  amount: number;
  mode: 'test' | 'live';
  status: 'READY' | 'VERIFYING' | 'DONE' | 'FAILED';
  createdAt: string;
}
export interface PointWallet {
  balance: number;
  mode: 'unavailable' | 'test' | 'live';
  wonPerPoint: 1;
  minAmount: number;
  maxAmount: number;
  orders: PointOrder[];
}
