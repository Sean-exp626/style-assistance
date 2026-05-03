/**
 * TEAM COCONUT — 로고 마크.
 *
 * 원본 로고에서 코코넛 그래픽만 누끼 따낸 PNG (`/public/coconut.png`)를 사용한다.
 * 흰 배경은 투명, 안쪽 흰 과육은 그대로 보존된 알파 PNG.
 *
 * 사용:
 *   <CoconutLogo className="h-16 w-16" />
 */
import { cn } from "@/lib/utils";

interface CoconutLogoProps {
  className?: string;
  alt?: string;
}

export function CoconutLogo({ className, alt = "TEAM COCONUT" }: CoconutLogoProps) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/coconut.png"
      alt={alt}
      className={cn("block object-contain select-none", className)}
      draggable={false}
    />
  );
}

/**
 * 워드마크 — 텍스트로 처리해 a11y/검색에 유리하게.
 */
export function CoconutWordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "font-sans text-[15px] font-medium uppercase tracking-[0.42em] text-foreground",
        className,
      )}
    >
      TEAM&nbsp;COCONUT
    </span>
  );
}
