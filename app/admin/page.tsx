/**
 * /admin — 관리자 전체 분석 로그 (Phase C).
 *
 * 보안 모델:
 *  1) Proxy로 1차 보호 (쿠키 부재 시 /login)
 *  2) Server Component에서 세션 + isAdmin 화이트리스트 검증
 *  3) 권한 없으면 `notFound()` — 403 대신 404로 응답해 라우트 존재 자체를 숨긴다
 *  4) Firestore 보안 규칙도 관리자 이메일만 전체 read 허용 — 다층 방어
 *
 * 검색:
 *  - 쿼리 파라미터 `?email=...` 기반의 GET form (uncontrolled, 새로고침으로 적용)
 *  - 부분 일치(대소문자 무시) — `fetchAllAnalyses({ emailFilter })`가 in-memory 필터
 *  - 100건 제한 → 200건으로 확대 (관리자 시야 확보)
 */
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Search } from "lucide-react";

import { CoconutLogo } from "@/components/coconut-logo";
import { AnalysisCard } from "@/components/history/analysis-card";
import { verifySessionCookieFromRequest } from "@/lib/firebase/admin";
import { fetchAllAnalyses } from "@/lib/firebase/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "관리자 · TEAM COCONUT",
};

const ADMIN_LIMIT = 200;

interface AdminPageProps {
  // Next.js 16 — searchParams는 Promise로 전달된다
  searchParams: Promise<{ email?: string | string[] }>;
}

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const user = await authorizeAdmin();

  const params = await searchParams;
  const emailRaw = Array.isArray(params.email) ? params.email[0] : params.email;
  const emailFilter = emailRaw?.trim() ?? "";

  const records = await fetchAllAnalyses({
    emailFilter,
    limit: ADMIN_LIMIT,
  });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-5 pb-24 pt-12 sm:px-8 sm:pt-16 lg:pt-20 animate-in fade-in duration-500">
      <header className="flex flex-col items-center text-center">
        <CoconutLogo className="h-12 w-12 opacity-80 sm:h-14 sm:w-14" />
        <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
          Admin
        </p>
        <h1 className="mt-3 font-sans text-[32px] font-bold tracking-[-0.025em] sm:text-[44px]">
          전체 분석 로그
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          최근 {ADMIN_LIMIT}건의 분석 기록을 최신순으로 보여드립니다. 이메일로 필터링하거나 카드를 눌러 상세 결과를 확인하세요.
        </p>
        <p className="mt-2 text-[11px] uppercase tracking-[0.28em] text-muted-foreground/70">
          {user.email} · admin
        </p>
      </header>

      <section className="mt-10 sm:mt-12">
        <SearchForm currentEmail={emailFilter} />

        <div className="mt-4 flex items-baseline justify-between text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          <span>
            {emailFilter ? `Filter · "${emailFilter}"` : "All Users"}
          </span>
          <span>
            {records.length} {records.length === 1 ? "record" : "records"}
          </span>
        </div>
      </section>

      <section className="mt-6">
        {records.length === 0 ? (
          <EmptyState filtered={emailFilter.length > 0} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {records.map((record) => (
              <AnalysisCard
                key={record.id}
                record={record}
                showOwner
              />
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

async function authorizeAdmin() {
  const h = await headers();
  const cookieHeader = h.get("cookie") ?? "";
  const proxyReq = new Request("http://internal/", {
    headers: { cookie: cookieHeader },
  });
  const user = await verifySessionCookieFromRequest(proxyReq);

  // 비로그인 + 비관리자 모두 404 — 라우트 존재 자체를 숨긴다 (정보 누출 최소화)
  if (!user || !user.isAdmin) {
    notFound();
  }
  return user;
}

function SearchForm({ currentEmail }: { currentEmail: string }) {
  return (
    <form
      method="GET"
      action="/admin"
      className="relative flex w-full items-center rounded-xl border border-border/70 bg-[color:var(--color-tc-surface-2)] focus-within:border-[color:var(--color-tc-accent)]/70"
    >
      <span className="pointer-events-none flex h-11 w-11 items-center justify-center text-muted-foreground">
        <Search className="h-4 w-4" strokeWidth={2} />
      </span>
      <input
        name="email"
        type="search"
        defaultValue={currentEmail}
        placeholder="이메일로 필터 (예: gmail)"
        className="h-11 flex-1 bg-transparent text-[14px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        autoComplete="off"
      />
      <button
        type="submit"
        className="mr-1.5 inline-flex h-8 items-center justify-center rounded-lg bg-[color:var(--color-tc-surface)] px-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-foreground transition-colors hover:bg-[color:var(--color-tc-border)]"
      >
        검색
      </button>
    </form>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 px-6 py-16 text-center">
      <CoconutLogo className="h-10 w-10 opacity-40" />
      <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
        No records
      </p>
      <p className="text-sm text-muted-foreground/85">
        {filtered
          ? "검색 조건에 일치하는 분석 기록이 없습니다."
          : "아직 저장된 분석 기록이 없습니다."}
      </p>
    </div>
  );
}
