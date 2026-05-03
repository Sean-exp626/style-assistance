/**
 * POST   /api/auth/session — Firebase ID 토큰으로 서버 세션 쿠키 발급
 * DELETE /api/auth/session — 세션 쿠키 삭제 (로그아웃)
 *
 * 흐름:
 *  1) 클라이언트가 Google 로그인 후 ID 토큰을 획득 (Firebase Web SDK)
 *  2) 본 라우트에 idToken을 POST → Admin SDK가 검증하고 5일짜리 세션 쿠키를 만들어
 *     httpOnly + Secure + SameSite=Lax 로 응답에 set
 *  3) Proxy(Edge)는 이 `__session` 쿠키 존재 여부만 보고 보호 라우트 접근을 게이트한다
 *
 * 보안 노트:
 *  - 쿠키 이름은 Firebase가 권장하는 `__session` 그대로 (Hosting CDN 호환성과 무관하게
 *    관례 유지 — Vercel 배포 시 충돌 없음)
 *  - secure는 production에서만 (localhost http 개발 위해 NODE_ENV 분기)
 *  - Edge Runtime은 firebase-admin 비호환 → nodejs runtime 명시
 */
import { z } from "zod";
import { cookies } from "next/headers";

import { adminAuth } from "@/lib/firebase/admin";

export const runtime = "nodejs";

const SESSION_COOKIE_NAME = "__session";
const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000; // 5 days
const SESSION_DURATION_SEC = SESSION_DURATION_MS / 1000;

const PostBodySchema = z.object({
  idToken: z.string().min(10, "idToken이 비어 있습니다."),
});

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError("요청 본문을 JSON으로 파싱할 수 없습니다.", 400);
  }

  const parsed = PostBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonError("idToken이 필요합니다.", 400);
  }

  const { idToken } = parsed.data;

  try {
    // 1) idToken 자체 검증 — uid가 일관된지, 만료/취소되지 않았는지
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    if (!decoded.uid) {
      return jsonError("토큰에서 사용자 정보를 확인할 수 없습니다.", 401);
    }

    // 2) 세션 쿠키 발급 (idToken은 보통 1시간 만료 → 5일짜리 cookie로 교체)
    const sessionCookie = await adminAuth.createSessionCookie(idToken, {
      expiresIn: SESSION_DURATION_MS,
    });

    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE_NAME, sessionCookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DURATION_SEC,
    });

    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("/api/auth/session POST failed:", err);
    return jsonError("인증에 실패했습니다. 다시 로그인해 주세요.", 401);
  }
}

export async function DELETE(): Promise<Response> {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(SESSION_COOKIE_NAME);
    return Response.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("/api/auth/session DELETE failed:", err);
    return jsonError("로그아웃 처리 중 오류가 발생했습니다.", 500);
  }
}
