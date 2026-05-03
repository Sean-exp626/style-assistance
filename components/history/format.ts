/**
 * 히스토리/관리자 카드/모달 공통 날짜 포맷터.
 *
 * 모든 표시는 KST 기준 — 사용자가 어느 timezone이든 동일한 결과를 보도록.
 *
 * - `formatKstShort`: 카드 라벨용 (2026. 5. 2. 14:33)
 * - `formatKstFull`:  모달 헤더용 (2026년 5월 2일 (토) 14:33 KST)
 */
const TIMEZONE = "Asia/Seoul";

const SHORT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const FULL = new Intl.DateTimeFormat("ko-KR", {
  timeZone: TIMEZONE,
  dateStyle: "full",
  timeStyle: "short",
});

export function formatKstShort(epochMs: number): string {
  if (!epochMs) return "—";
  return SHORT.format(new Date(epochMs));
}

export function formatKstFull(epochMs: number): string {
  if (!epochMs) return "—";
  return `${FULL.format(new Date(epochMs))} KST`;
}
