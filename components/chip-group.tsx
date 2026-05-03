"use client";

/**
 * ChipGroup — pill 모양 단일 선택 그룹. 드롭다운 대체용.
 *
 * 옵션이 3~5개로 짧고 의미가 짧은 라벨일 때 드롭다운보다 눈에 잘 들어온다.
 * 활성 칩은 틸 채움. 비활성은 보더만 있는 ghost 칩.
 */
import { cn } from "@/lib/utils";

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

interface ChipGroupProps<T extends string> {
  value: T;
  options: readonly ChipOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}

export function ChipGroup<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: ChipGroupProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn("flex flex-wrap gap-2", className)}
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
              "h-9 rounded-full border px-4 text-sm font-medium transition-all",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
              active
                ? "border-[color:var(--color-tc-accent)] bg-[color:var(--color-tc-accent)]/15 text-[color:var(--color-tc-accent-hi)] shadow-[0_0_0_1px_var(--color-tc-accent-soft)]"
                : "border-border/80 bg-transparent text-[color:var(--color-tc-text-muted)] hover:border-[color:var(--color-tc-accent)]/60 hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
