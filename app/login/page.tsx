"use client";

/**
 * /login — Google OAuth 단일 진입점.
 *
 * 흐름:
 *  1) "Continue with Google" 클릭 → Firebase popup으로 ID 토큰 획득
 *  2) ID 토큰을 `/api/auth/session`으로 POST → 서버가 세션 쿠키 발급
 *  3) `returnTo` 쿼리(없으면 `/`)로 navigate
 *
 * 디자인:
 *  - TC 다크 무드 + 틸 액센트 유지
 *  - 코코넛 로고 + 워드마크 헤더 재사용
 */
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { CoconutLogo, CoconutWordmark } from "@/components/coconut-logo";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { signInWithGoogle } from "@/lib/firebase/client";

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // open redirect 방지 — root-relative path만 허용
  const rawReturnTo = searchParams.get("returnTo");
  const returnTo =
    rawReturnTo && rawReturnTo.startsWith("/") && !rawReturnTo.startsWith("//")
      ? rawReturnTo
      : "/";

  async function handleGoogleSignIn() {
    setError(null);
    setIsPending(true);
    try {
      const user = await signInWithGoogle();
      const idToken = await user.getIdToken();

      const res = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? "세션 발급에 실패했습니다.");
      }

      // 세션 쿠키가 set 되었으니 보호 라우트 진입 가능
      router.push(returnTo);
      router.refresh();
    } catch (err) {
      console.error("Login failed:", err);
      setError(toFriendlyError(err));
      setIsPending(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center px-5 pb-24 pt-16 sm:pt-24">
      <header className="flex flex-col items-center text-center">
        <CoconutLogo className="h-14 w-14 sm:h-16 sm:w-16" />
        <div className="mt-5 flex items-center gap-3">
          <span className="h-px w-6 bg-border" />
          <CoconutWordmark className="text-[12px]" />
          <span className="h-px w-6 bg-border" />
        </div>
        <h1 className="mt-10 font-sans text-[32px] font-bold leading-tight tracking-[-0.025em] sm:text-[40px]">
          로그인
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Google 계정으로 로그인하면 분석 기록이 저장됩니다.
        </p>
      </header>

      <section className="mt-12 w-full">
        <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card/80 p-6 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.7)] backdrop-blur-sm sm:p-8">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--color-tc-accent)]/40 to-transparent" />

          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isPending}
            className={[
              "group inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl",
              "border border-border bg-[color:var(--color-tc-surface-2)] text-[14px] font-medium text-foreground",
              "transition-all hover:-translate-y-px hover:bg-[color:var(--color-tc-surface)]",
              "active:translate-y-0",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
              "disabled:cursor-not-allowed disabled:opacity-50",
            ].join(" ")}
          >
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                로그인 중…
              </>
            ) : (
              <>
                <GoogleIcon />
                Continue with Google
              </>
            )}
          </button>

          {error ? (
            <div className="mt-5">
              <Alert variant="destructive">
                <AlertTitle>로그인에 실패했습니다</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          ) : null}
        </div>

        <p className="mt-6 text-center text-[11px] uppercase tracking-[0.24em] text-muted-foreground/70">
          Powered by TEAM COCONUT
        </p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  // useSearchParams는 Suspense 경계가 필요하다 (Next.js 16 권장 패턴)
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center px-5 pt-24">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </main>
      }
    >
      <LoginInner />
    </Suspense>
  );
}

function GoogleIcon() {
  // Google 브랜드 가이드 컬러 — 멀티컬러 G 마크
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8431 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.18l-2.9087-2.2581c-.806.54-1.8368.8595-3.0477.8595-2.344 0-4.3282-1.5831-5.036-3.7104H.9574v2.3318C2.4382 15.9831 5.4818 18 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.6559 3.5795 9 3.5795z"
        fill="#EA4335"
      />
    </svg>
  );
}

function toFriendlyError(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    const code = String((err as { code: unknown }).code ?? "");
    if (code === "auth/popup-closed-by-user") {
      return "로그인 창이 닫혔습니다. 다시 시도해 주세요.";
    }
    if (code === "auth/popup-blocked") {
      return "팝업이 차단되었습니다. 브라우저 설정을 확인해 주세요.";
    }
    if (code === "auth/cancelled-popup-request") {
      return "로그인이 취소되었습니다.";
    }
    if (code === "auth/network-request-failed") {
      return "네트워크 오류가 발생했습니다. 연결을 확인해 주세요.";
    }
  }
  if (err instanceof Error && err.message) return err.message;
  return "알 수 없는 오류가 발생했습니다.";
}
