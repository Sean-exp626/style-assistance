import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

/*
 * Phase 1: Geist만 임시 사용. Phase 3에서 Cormorant Garamond + Noto Sans KR로 교체.
 * `--font-sans`는 globals.css가 이 변수를 그대로 매핑한다.
 */
const sans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const mono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KAI JUNG HAIR · Style Assistance",
  description:
    "강남 KAI JUNG HAIR 원장 페르소나로 얼굴형·두상에 맞는 헤어스타일을 추천하는 AI 어시스턴트. Powered by TEAM COCONUT.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${sans.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
