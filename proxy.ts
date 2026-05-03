/**
 * Next.js 16 Proxy (구 Middleware).
 *
 * 책임 — Optimistic auth gate:
 *  - 보호 페이지(`/`, `/history`, `/admin`) 진입 시 `__session` 쿠키 부재면
 *    `/login?returnTo=...`로 redirect
 *  - 이미 로그인한 사용자가 `/login`에 접근하면 `/`로 redirect
 *
 * 중요한 제약:
 *  - Proxy는 Edge Runtime에서 동작 → `firebase-admin` import 절대 금지
 *    (NodeAPI/PEM 처리 등이 깨짐)
 *  - 따라서 쿠키의 *유효성*은 검증하지 않고 *존재 여부*만 본다 (optimistic check)
 *  - 위조된 쿠키로 보호 페이지에 진입해도 실제 데이터 fetch 단계에서
 *    Admin SDK가 검증을 다시 수행 → 보안 경계는 서버 라우트가 책임짐
 *  - matcher에서 API/_next 자원은 제외하고, 각 API 라우트가 직접 검증한다 (Phase B/C)
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "__session";
const LOGIN_PATH = "/login";

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);

  // 이미 로그인된 사용자가 /login 접근 시 홈으로 보낸다
  if (pathname === LOGIN_PATH) {
    if (hasSession) {
      const home = request.nextUrl.clone();
      home.pathname = "/";
      home.search = "";
      return NextResponse.redirect(home);
    }
    return NextResponse.next();
  }

  // 보호 라우트: 쿠키 없으면 로그인 페이지로
  if (!hasSession) {
    const login = request.nextUrl.clone();
    login.pathname = LOGIN_PATH;
    // returnTo로 원래 경로 + 쿼리 보존 (단, 자기 자신/외부 리다이렉트 방지를 위해
    // 항상 root-relative path만 저장)
    const returnTo = `${pathname}${search}`;
    login.search = `?returnTo=${encodeURIComponent(returnTo)}`;
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

/**
 * matcher 제외 항목:
 *  - api/*           → 각 라우트 핸들러가 자체 인증
 *  - _next/static/*  → 정적 빌드 산출물
 *  - _next/image/*   → 이미지 최적화 캐시
 *  - 정적 자산 (favicon / 로고 이미지)
 */
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|coconut.png|team-coconut-logo.jpeg).*)",
  ],
};
