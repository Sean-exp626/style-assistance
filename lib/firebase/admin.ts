/**
 * Firebase Admin SDK 서버 wrapper.
 *
 * 책임:
 *  - 서버(Node.js runtime)에서 ID 토큰/세션 쿠키 검증
 *  - Firestore Admin 클라이언트 노출 (Phase B에서 사용)
 *  - 싱글톤: HMR/serverless cold start에서 중복 init 방지
 *
 * 주의:
 *  - Edge runtime(proxy.ts)에서는 절대 import 금지 — `getApps()/cert()` 모두
 *    Node API에 의존 (process.env 접근 + 동적 require)
 *  - 모든 사용처는 `export const runtime = "nodejs"` 명시
 */
import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Lazy 싱글톤 — 모듈 로드 시점이 아니라 첫 사용 시점에 init한다.
 *
 * Why lazy:
 *  Next.js 16 build 단계의 "page data collection"에서 라우트의 module graph를
 *  탐색하기 위해 모듈을 import한다. 이때 process.env가 실제 런타임 값을 갖지 않을
 *  수 있어, top-level에서 init하면 빌드가 실패한다.
 */
let cachedApp: App | null = null;

function getAdminApp(): App {
  if (cachedApp) return cachedApp;

  const existing = getApps()[0];
  if (existing) {
    cachedApp = existing;
    return cachedApp;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error(
      "Firebase Admin SDK 환경변수가 누락되었습니다 (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).",
    );
  }

  // Vercel 등의 환경변수 저장소는 multi-line PEM의 줄바꿈을 `\n` 리터럴로 보존하므로
  // 실제 줄바꿈으로 복원해 Admin SDK에 전달한다.
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  cachedApp = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
  return cachedApp;
}

/** Lazy proxy: 사용 시점에 admin app을 보장한다. */
export const adminAuth: Auth = new Proxy({} as Auth, {
  get(_target, prop, receiver) {
    return Reflect.get(getAuth(getAdminApp()), prop, receiver);
  },
});

export const adminDb: Firestore = new Proxy({} as Firestore, {
  get(_target, prop, receiver) {
    return Reflect.get(getFirestore(getAdminApp()), prop, receiver);
  },
});

export interface AuthenticatedUser {
  uid: string;
  email: string;
  isAdmin: boolean;
}

/** ADMIN_EMAILS env (콤마 구분)을 trim된 배열로 파싱. */
function getAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * 요청에서 `__session` 쿠키를 꺼내 검증하고 사용자 정보를 반환한다.
 *
 * - 쿠키 부재 / 검증 실패 / 이메일 미존재 → null
 * - `checkRevoked: true` — 비밀번호 변경/계정 비활성화 직후를 즉시 반영
 *
 * 호출 측은 null이면 401을 반환하면 됨.
 */
export async function verifySessionCookieFromRequest(
  req: Request,
): Promise<AuthenticatedUser | null> {
  const sessionCookie = readCookie(req, "__session");
  if (!sessionCookie) return null;

  try {
    const decoded = await adminAuth.verifySessionCookie(sessionCookie, true);
    const email = (decoded.email ?? "").toLowerCase();
    if (!email) return null;
    return {
      uid: decoded.uid,
      email,
      isAdmin: getAdminEmails().includes(email),
    };
  } catch {
    return null;
  }
}

/** Request의 Cookie 헤더에서 단일 쿠키 값을 추출한다. */
function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}
