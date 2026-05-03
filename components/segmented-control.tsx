"use client";

/**
 * SegmentedControl — 두 개 이상의 상호 배타적 옵션을 위한 탭형 토글.
 *
 * 라디오 그룹 의미는 보존하되 시각적으로는 iOS/macOS의 segmented control처럼.
 * - 활성 세그먼트는 틸 그라디언트 배경 + 진한 글씨.
 * - 비활성은 muted 배경, 호버 시 텍스트 밝아짐.
 * - 키보드 화살표는 다루지 않음(클릭만): 옵션 수가 적고 폼 흐름 안에서 단순한 게 낫다.
 */
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-full rounded-lg border border-border/80 bg-[color:var(--color-tc-surface-2)] p-1",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-all",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
              active
                ? "bg-gradient-to-b from-[color:var(--color-tc-accent-hi)] to-[color:var(--color-tc-accent)] text-[color:var(--color-tc-accent-fg)] shadow-[0_4px_18px_-8px_var(--color-tc-accent)]"
                : "text-[color:var(--color-tc-text-muted)] hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
