import type { Metadata } from "next";
import { Cormorant_Garamond, Inter, Noto_Sans_KR } from "next/font/google";
import "./globals.css";

import { AuthNav } from "@/components/auth/auth-nav";

/*
 * Phase 3 — 폰트 시스템.
 *
 * - Inter: 영문 본문/UI (Geist 대체, 모던하고 가독성 우수)
 * - Noto Sans KR: 한국어 본문 (subset 'latin'만 가능 → CSS unicode-range가 자동 분기)
 * - Cormorant Garamond: 디스플레이 헤딩용 세리프 (브랜드 영역의 큰 제목에서 절제된 사용)
 *
 * `display: "swap"`으로 FOIT 방지. variable로 노출해 globals.css의 토큰에 매핑.
 */
const sans = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

const kr = Noto_Sans_KR({
  variable: "--font-kr",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const serif = Cormorant_Garamond({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "TEAM COCONUT · Hair Style Assistant",
  description:
    "20년 경력 베테랑 원장 페르소나로 얼굴형·두상에 맞는 헤어스타일을 추천하는 AI 어시스턴트. Powered by TEAM COCONUT.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${sans.variable} ${kr.variable} ${serif.variable} h-full antialiased`}
    >
      <body className="relative min-h-full flex flex-col">
        <AuthNav />
        {children}
      </body>
    </html>
  );
}
