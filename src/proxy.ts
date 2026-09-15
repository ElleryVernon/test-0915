import { NextResponse, type NextRequest } from 'next/server';
import { currentUser } from '@/lib/server/auth';
export async function proxy(request: NextRequest) {
  if (!request.cookies.has('memoryz_session')) return NextResponse.next();
  let role: string;
  try {
    role = (await currentUser(request)).role;
  } catch {
    return NextResponse.redirect(new URL('/', request.url));
  }
  const path = request.nextUrl.pathname;
  const student =
    /^\/(study|subjects|quiz|essay|flashcards|wrong-notes|create-card|completed-subjects|community|boards|planner)(\/|$)/.test(
      path,
    );
  const parent = /^\/(parent|parent-boards)(\/|$)/.test(path);
  if (
    (role === 'PARENT' && student) ||
    (role === 'STUDENT' && parent) ||
    (path.startsWith('/admin') && role !== 'ADMIN')
  )
    return new NextResponse(
      '<!doctype html><html lang="ko"><meta name="viewport" content="width=device-width, initial-scale=1"><title>접근할 수 없는 공간 · memoryz</title><body style="font-family:system-ui;padding:48px 24px;max-width:420px;margin:auto"><p style="color:#f97316">memoryz · 403</p><h1 style="font-size:24px">이 계정에서 볼 수 없는 화면이에요</h1><p>학생과 학부모의 공간을 안전하게 구분하고 있어요.</p><a href="/">내 홈으로 돌아가기</a></body></html>',
      {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    );
  return NextResponse.next();
}
export const config = {
  matcher: [
    '/study/:path*',
    '/subjects/:path*',
    '/quiz/:path*',
    '/essay/:path*',
    '/flashcards/:path*',
    '/wrong-notes/:path*',
    '/create-card/:path*',
    '/completed-subjects/:path*',
    '/community/:path*',
    '/boards/:path*',
    '/planner/:path*',
    '/parent/:path*',
    '/parent-boards/:path*',
    '/cheer/:path*',
    '/admin/:path*',
  ],
};
