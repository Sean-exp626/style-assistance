/**
 * /history — 본인 분석 기록 (Phase C).
 *
 * 책임:
 *  1) Proxy로 1차 보호 (쿠키 부재 시 /login)
 *  2) Server Component에서 Admin SDK로 세션을 *재검증* — 위조된 쿠키 차단 (이중 안전)
 *  3) 본인 uid의 hairAnalyses 문서를 최신순 50건 조회
 *  4) 카드 그리드로 렌더 — 카드 클릭 시 상세 모달
 *
 * 보안 경계:
 *  - 검증 실패 시 `/login?returnTo=/history`로 redirect (proxy와 동일한 흐름)
 *  - Firestore 보안 규칙도 본인/관리자만 read 허용 — 다층 방어
 */
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";

import { CoconutLogo } from "@/components/coconut-logo";
import { AnalysisCard } from "@/components/history/analysis-card";
import { verifySessionCookieFromRequest } from "@/lib/firebase/admin";
import { fetchUserAnalyses } from "@/lib/firebase/queries";

export const runtime = "nodejs";
// 매 요청마다 쿠키 검증 + Firestore 조회 — 정적 prerender 금지
export const dynamic = "force-dynamic";
export const metadata = {
  title: "내 히스토리 · TEAM COCONUT",
};

const HISTORY_LIMIT = 50;

export default async function HistoryPage() {
  const user = await authenticate();
  const records = await fetchUserAnalyses(user.uid, HISTORY_LIMIT);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-24 pt-12 sm:px-8 sm:pt-16 lg:pt-20 animate-in fade-in duration-500">
      <header className="flex flex-col items-center text-center">
        <CoconutLogo className="h-12 w-12 opacity-80 sm:h-14 sm:w-14" />
        <h1 className="mt-6 font-sans text-[32px] font-bold tracking-[-0.025em] sm:text-[44px]">
          내 히스토리
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          최근 {HISTORY_LIMIT}건의 분석 기록을 최신순으로 보여드립니다. 카드를 눌러 상세 결과를 확인하세요.
        </p>
        <p className="mt-2 text-[11px] uppercase tracking-[0.28em] text-muted-foreground/70">
          Total · {records.length} {records.length === 1 ? "record" : "records"}
        </p>
      </header>

      <section className="mt-12 sm:mt-16">
        {records.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {records.map((record) => (
              <AnalysisCard key={record.id} record={record} />
            ))}
          </div>
        )}
      </section>

      <footer className="mt-24 flex flex-col items-center gap-2 text-center">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
          <span className="h-px w-6 bg-border" />
          <span>Powered by TEAM COCONUT</span>
          <span className="h-px w-6 bg-border" />
        </div>
      </footer>
    </main>
  );
}

/* ----------------------------- Auth + UI ----------------------------- */

async function authenticate() {
  // verifySessionCookieFromRequest는 Request의 cookie 헤더만 사용하므로
  // headers()로 추출해 가짜 Request를 합성한다 (admin 페이지와 동일 패턴).
  const h = await headers();
  const cookieHeader = h.get("cookie") ?? "";
  const proxyReq = new Request("http://internal/", {
    headers: { cookie: cookieHeader },
  });
  const user = await verifySessionCookieFromRequest(proxyReq);

  if (!user) {
    // proxy.ts가 1차 방어를 하지만 위조된 쿠키 / proxy matcher 우회 등 엣지 케이스 대비.
    redirect("/login?returnTo=%2Fhistory");
  }
  return user;
}

function EmptyState() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
      <CoconutLogo className="h-10 w-10 opacity-40" />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
          No records yet
        </p>
        <p className="mt-2 text-sm text-muted-foreground/85">
          아직 분석 기록이 없습니다.
        </p>
      </div>
      <Link
        href="/"
        className="inline-flex h-10 items-center justify-center rounded-xl bg-gradient-to-r from-[color:var(--color-tc-accent)] to-[color:var(--color-tc-accent-hi)] px-5 text-[12px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-tc-accent-fg)] shadow-[0_10px_30px_-12px_var(--color-tc-accent)] transition-all hover:-translate-y-px hover:shadow-[0_14px_36px_-12px_var(--color-tc-accent-hi)]"
      >
        분석하러 가기
      </Link>
    </div>
  );
}
