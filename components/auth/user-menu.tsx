"use client";

/**
 * 헤더 우측의 인증 상태 위젯.
 *
 *  - 미로그인: "로그인" 링크 버튼
 *  - 로그인:   아바타(또는 이니셜) 트리거 → DropdownMenu (히스토리/관리자/로그아웃)
 *
 * 관리자 메뉴 노출:
 *  - 클라이언트 단에서는 모든 사용자에게 표시한다 (NEXT_PUBLIC_ADMIN_EMAILS 별도
 *    노출을 피하기 위함).
 *  - 실제 권한은 서버에서 verifySessionCookieFromRequest의 isAdmin으로 검증 →
 *    `/admin` 페이지가 권한 없는 사용자에게 notFound()를 반환할 책임을 진다 (Phase C).
 *
 * Hydration 고려:
 *  - onAuthStateChanged가 처음 fire되기 전까지 user는 undefined → "로딩 중" 상태로
 *    버튼 자리만 잡아두면 layout shift를 막을 수 있다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { History, LogOut, Shield } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { auth, signOutAndClearSession } from "@/lib/firebase/client";

type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; user: User };

export function UserMenu() {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setState(user ? { status: "authenticated", user } : { status: "anonymous" });
    });
    return () => unsubscribe();
  }, []);

  async function handleSignOut() {
    try {
      await signOutAndClearSession();
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  if (state.status === "loading") {
    return (
      <div
        aria-hidden
        className="h-9 w-9 rounded-full border border-border/60 bg-[color:var(--color-tc-surface-2)]/40"
      />
    );
  }

  if (state.status === "anonymous") {
    return (
      <Link
        href="/login"
        className="inline-flex h-9 items-center rounded-full border border-border/70 bg-[color:var(--color-tc-surface-2)] px-4 text-[12px] font-medium uppercase tracking-[0.18em] text-foreground transition-colors hover:bg-[color:var(--color-tc-surface)]"
      >
        로그인
      </Link>
    );
  }

  const { user } = state;
  const displayName = user.displayName ?? user.email ?? "사용자";
  const email = user.email ?? "";
  const initial = (displayName?.[0] ?? email[0] ?? "?").toUpperCase();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${displayName} 메뉴 열기`}
        className="inline-flex h-9 items-center gap-2 rounded-full border border-border/70 bg-[color:var(--color-tc-surface-2)] py-0 pr-3 pl-1 transition-colors hover:bg-[color:var(--color-tc-surface)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]"
      >
        <Avatar photoURL={user.photoURL} initial={initial} alt={displayName} />
        <span className="hidden max-w-[140px] truncate text-[12px] text-muted-foreground sm:inline">
          {email}
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[220px]">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5 py-1">
            <span className="text-[13px] font-medium text-foreground">
              {displayName}
            </span>
            {email && displayName !== email ? (
              <span className="text-[11px] text-muted-foreground">{email}</span>
            ) : null}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          render={
            <Link href="/history">
              <History className="text-muted-foreground" />
              히스토리
            </Link>
          }
        />
        <DropdownMenuItem
          render={
            <Link href="/admin">
              <Shield className="text-muted-foreground" />
              관리자
            </Link>
          }
        />

        <DropdownMenuSeparator />

        <DropdownMenuItem variant="destructive" onClick={handleSignOut}>
          <LogOut />
          로그아웃
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({
  photoURL,
  initial,
  alt,
}: {
  photoURL: string | null;
  initial: string;
  alt: string;
}) {
  if (photoURL) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoURL}
        alt={alt}
        referrerPolicy="no-referrer"
        className="h-7 w-7 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--color-tc-accent)] text-[12px] font-semibold text-[color:var(--color-tc-accent-fg)]"
    >
      {initial}
    </span>
  );
}
