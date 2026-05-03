/**
 * /admin — Phase A stub.
 *
 * 책임:
 *  1) Proxy로 1차 보호 (쿠키 부재 시 /login)
 *  2) 서버에서 Admin SDK로 세션 검증 → ADMIN_EMAILS에 포함된 사용자만 통과
 *     아니면 notFound()로 라우트 자체를 숨긴다 (403 대신 404 — 관리 메뉴 노출 최소화)
 *
 * 실제 전체 사용자 분석 로그/통계 화면은 Phase C에서 구현.
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { CoconutLogo } from "@/components/coconut-logo";
import { verifySessionCookieFromRequest } from "@/lib/firebase/admin";

export const runtime = "nodejs";
// 매 요청마다 cookie 검증 — 정적 prerender 금지
export const dynamic = "force-dynamic";
export const metadata = {
  title: "관리자 · TEAM COCONUT",
};

export default async function AdminPage() {
  // Server Component에서 verifySessionCookieFromRequest를 재사용하기 위해
  // headers()로 cookie 헤더만 추출해 가짜 Request를 합성한다.
  const h = await headers();
  const cookieHeader = h.get("cookie") ?? "";
  const proxyReq = new Request("http://internal/", {
    headers: { cookie: cookieHeader },
  });
  const user = await verifySessionCookieFromRequest(proxyReq);

  if (!user || !user.isAdmin) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pb-24 pt-16 sm:pt-24">
      <header className="flex flex-col items-center text-center">
        <CoconutLogo className="h-12 w-12 opacity-70" />
        <h1 className="mt-8 font-sans text-[32px] font-bold tracking-[-0.025em] sm:text-[40px]">
          관리자
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          {user.email} · 관리자 권한으로 로그인되었습니다.
        </p>
      </header>

      <section className="mt-16 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 px-6 py-14 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
          Coming Soon
        </p>
        <p className="text-sm text-muted-foreground/80">
          전체 사용자 분석 로그와 통계가 여기에 표시됩니다. (Phase C에서 구현 예정)
        </p>
      </section>
    </main>
  );
}
