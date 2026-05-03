/**
 * Firebase Web SDK 클라이언트 wrapper.
 *
 * 책임:
 *  - 브라우저(`'use client'`) 컴포넌트에서 사용할 Auth 인스턴스/Provider를 노출
 *  - HMR/SSR 중 중복 init 방지 (getApps 검사)
 *  - 도메인 로직과 인프라 분리: 화면 컴포넌트는 이 모듈의 헬퍼만 호출하고
 *    Firebase API는 직접 import하지 않는다 (의존성 역전)
 *
 * 환경변수: NEXT_PUBLIC_FIREBASE_* — 클라이언트 번들에 노출되어도 안전한
 * 공개 키 4종 (Firebase Auth는 Authorized Domains로 보호)
 */
import {
  GoogleAuthProvider,
  getAuth,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app: FirebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);

export const auth: Auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
// 매번 계정 선택 화면을 띄워 멀티 계정 사용자 혼란을 줄임
googleProvider.setCustomParameters({ prompt: "select_account" });

/**
 * Google 로그인 흐름.
 *
 * 1) 브라우저에서 popup으로 Google OAuth → Firebase ID 토큰 획득
 * 2) 호출 측에서 idToken을 추출해 `/api/auth/session`으로 POST하여 세션 쿠키 발급
 *
 * Popup 차단/사용자 닫음 등의 오류는 throw 그대로 전달 — UI 단에서 한국어 메시지로 변환.
 */
export async function signInWithGoogle(): Promise<User> {
  const credential = await signInWithPopup(auth, googleProvider);
  return credential.user;
}

/**
 * 로그아웃 — 클라이언트 Firebase 세션 + 서버 쿠키 모두 정리.
 *
 * 순서: 서버 쿠키 먼저 → 클라이언트 SDK signOut.
 * (반대로 하면 짧은 시간 동안 클라이언트는 logged-out인데 쿠키가 살아있어
 *  proxy가 보호 라우트로의 진입을 허용하는 상태가 발생할 수 있음)
 */
export async function signOutAndClearSession(): Promise<void> {
  try {
    await fetch("/api/auth/session", { method: "DELETE" });
  } catch (err) {
    // 네트워크 오류여도 클라이언트 signOut은 진행한다
    console.error("Failed to clear server session cookie:", err);
  }
  await signOut(auth);
}
