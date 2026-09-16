import type { Metadata, Viewport } from 'next';
import './globals.css';
import App from '@/components/app';
export const metadata: Metadata = {
  title: 'memoryz · 기억이 남는 공부',
  description: '내 자료로 문제, 서술형 코칭, 복습 카드까지. 매일 조금씩, 오래 기억하는 공부.',
  applicationName: 'memoryz',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'memoryz' },
  icons: { icon: '/icon.svg', apple: '/icon-180.png' },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {/* One client shell lives above route caching so Back never restores a second history owner. */}
        <App />
        {children}
      </body>
    </html>
  );
}
