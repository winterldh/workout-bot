import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Workout Check-in Dashboard',
  description: 'Slack 운동 인증 MVP 대시보드',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        style={{
          margin: 0,
          fontFamily:
            '"Pretendard Variable", "Pretendard", "Apple SD Gothic Neo", sans-serif',
          background: '#f5f7f2',
          color: '#112015',
        }}
      >
        <nav
          style={{
            maxWidth: 960,
            margin: '0 auto',
            padding: '20px 24px 0',
            display: 'flex',
            gap: 16,
          }}
        >
          <Link href="/">대시보드</Link>
          <Link href="/check-ins">인증 기록</Link>
          <Link href="/ranking">주간 랭킹</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
