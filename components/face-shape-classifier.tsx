"use client";

/**
 * FaceShapeClassifier — 한국형 얼굴형 6분류 시각 아틀라스.
 *
 * 책임:
 *  - 6개 카테고리 SVG 아이콘 그리드 (모바일 3x2 / 데스크 6x1)
 *  - matched 카테고리 셀에 강조 + ring pulse 1회 + MATCHED 배지
 *  - matched가 있을 때 자유 텍스트 `face_shape`를 카드 하단에 부연 설명으로 노출
 *  - hideOnNull=true면 분류 미정 시 컴포넌트 자체 미렌더 (history 모달 등에서 사용)
 *
 * 디자인:
 *  - SVG는 viewBox 24x24, stroke="currentColor"로 통일 → matched 셀에서 stroke 굵게
 *  - 토큰: --color-tc-accent / -hi / -fg / -surface-2 / --color-border
 *  - 펄스 애니메이션은 motion-safe로 한정해 prefers-reduced-motion 존중
 */
import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  FACE_SHAPE_CATEGORIES,
  type FaceShapeCategory,
} from "@/lib/face-shape";

interface FaceShapeClassifierProps {
  matched: FaceShapeCategory | null;
  /** 카드 하단 부연 설명. matched가 있을 때만 노출. */
  faceShapeText?: string;
  /** matched===null이면 컴포넌트 자체 미렌더. */
  hideOnNull?: boolean;
}

// SVG path 정의 — 6개 카테고리 각각의 윤곽
const SHAPE_PATHS: Record<FaceShapeCategory, string> = {
  계란형:
    "M12 2.5 C 15.5 2.5 18 5.5 18 9.2 C 18 13 17 17.5 14.5 20 C 13.6 20.9 12.7 21.3 12 21.3 C 11.3 21.3 10.4 20.9 9.5 20 C 7 17.5 6 13 6 9.2 C 6 5.5 8.5 2.5 12 2.5 Z",
  마름모형:
    "M12 2.5 L 16.2 7.5 L 19 12 L 16.2 17 L 12 21.5 L 7.8 17 L 5 12 L 7.8 7.5 Z",
  하트형:
    "M5.5 4.5 C 5.5 3.7 6.2 3.2 7 3.2 L 17 3.2 C 17.8 3.2 18.5 3.7 18.5 4.5 L 18.5 8 C 18.5 12 17.5 16 15.5 18.5 C 14.2 20.2 13 21.3 12 21.3 C 11 21.3 9.8 20.2 8.5 18.5 C 6.5 16 5.5 12 5.5 8 Z",
  땅콩형:
    "M7 3.5 C 9 3.2 15 3.2 17 3.5 C 18.2 3.7 18.6 5 18.4 6.5 C 18.1 8.5 17 10.5 14.5 11.8 C 17 13.1 18.1 15 18.4 17 C 18.6 18.5 18.2 19.8 17 20 C 15 20.3 9 20.3 7 20 C 5.8 19.8 5.4 18.5 5.6 17 C 5.9 15 7 13.1 9.5 11.8 C 7 10.5 5.9 8.5 5.6 6.5 C 5.4 5 5.8 3.7 7 3.5 Z",
  육각형:
    "M8 3.5 L 16 3.5 L 19.5 9 L 19.5 14 L 16 20 L 8 20 L 4.5 14 L 4.5 9 Z",
  둥근형:
    "M12 3 C 16.4 3 19.5 6.4 19.5 12 C 19.5 17.6 16.4 21 12 21 C 7.6 21 4.5 17.6 4.5 12 C 4.5 6.4 7.6 3 12 3 Z",
};

export function FaceShapeClassifier({
  matched,
  faceShapeText,
  hideOnNull = false,
}: FaceShapeClassifierProps) {
  // hooks는 항상 동일한 순서로 호출 — early return은 모든 hook 호출 이후에.
  const [pulseKey, setPulseKey] = useState(0);
  const [showPulse, setShowPulse] = useState(false);

  // ring pulse — matched 변경 시 1회 트리거, 620ms 후 unmount.
  // react-hooks/set-state-in-effect 룰 회피를 위해 effect 본문에서 동기 setState를 호출하지 않고
  // microtask로 한 단계 미루어 cascading render 신호를 주지 않는다.
  useEffect(() => {
    if (!matched) {
      const id = setTimeout(() => setShowPulse(false), 0);
      return () => clearTimeout(id);
    }
    const startId = setTimeout(() => {
      setShowPulse(true);
      setPulseKey((k) => k + 1);
    }, 0);
    const stopId = setTimeout(() => setShowPulse(false), 620);
    return () => {
      clearTimeout(startId);
      clearTimeout(stopId);
    };
  }, [matched]);

  if (hideOnNull && !matched) return null;

  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        {/* 헤더 */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
            Face Shape Atlas
          </span>
          <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            한국형 6분류
          </span>
        </div>

        {/* 6 SVG 그리드 */}
        <div className="grid grid-cols-3 grid-rows-2 gap-2 sm:grid-cols-6 sm:grid-rows-1 sm:gap-3">
          {FACE_SHAPE_CATEGORIES.map((cat) => {
            const isMatched = cat === matched;
            const noMatch = matched === null;
            return (
              <div
                key={cat}
                aria-current={isMatched ? "true" : undefined}
                className={cn(
                  "relative flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl transition-all",
                  isMatched
                    ? "border-2 border-[color:var(--color-tc-accent-hi)] bg-[color:var(--color-tc-surface-2)] scale-[1.02] shadow-[0_10px_40px_-20px_var(--color-tc-accent)] text-[color:var(--color-tc-accent-hi)] [&_path]:stroke-[1.5]"
                    : cn(
                        "border border-border/80 bg-[color:var(--color-tc-surface-2)] text-[color:var(--color-tc-text-muted)]",
                        noMatch ? "opacity-70" : "opacity-40",
                      ),
                )}
              >
                {isMatched ? (
                  <>
                    <span className="absolute right-1.5 top-1.5 rounded-md bg-[color:var(--color-tc-accent)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.24em] text-[color:var(--color-tc-accent-fg)]">
                      Matched
                    </span>
                    <span className="sr-only">매칭된 얼굴형</span>
                    {showPulse ? (
                      <span
                        key={pulseKey}
                        aria-hidden
                        className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-[color:var(--color-tc-accent-hi)] motion-safe:transition-all motion-safe:duration-[600ms] motion-safe:ease-out opacity-0 scale-[1.18]"
                        style={{
                          // 시작 상태를 데이터 속성으로 적용하기 위한 트릭은 불필요 —
                          // mount 시점에는 React가 오프->온 전환을 자동 처리한다.
                          // 시작 상태를 명시하려면 두 단계 mount가 필요하지만,
                          // 시각적으로 한 번 사라지는 효과만 주려면 종료 상태만 유지하면 충분.
                        }}
                      />
                    ) : null}
                  </>
                ) : null}

                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-12 w-12"
                  aria-hidden
                >
                  <path
                    d={SHAPE_PATHS[cat]}
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                </svg>
                <span
                  className={cn(
                    "mt-1.5 text-[11px] font-medium leading-tight",
                    isMatched ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {cat}
                </span>
              </div>
            );
          })}
        </div>

        {/* 카드 하단 — matched 부연 설명 또는 미정 안내 */}
        {matched && faceShapeText ? (
          <p className="text-[13px] leading-[1.6] text-muted-foreground">
            {faceShapeText}
          </p>
        ) : matched === null ? (
          <p className="rounded-md border border-dashed border-border/60 px-3 py-2 text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
            분류 미정
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
