"use client";

/**
 * Reference Gallery — 분석 결과 keywords 기반 레퍼런스 이미지 그리드.
 *
 * 디자인 결정:
 *  - Next `<Image>` 대신 native `<img>` — 외부 도메인 화이트리스트 관리 부담을 피함.
 *  - `loading="lazy"` + `referrerPolicy="no-referrer"` — 일부 사이트의 hotlink 차단 회피.
 *  - `<img onError>`로 thum.io 페이지 스크린샷 폴백.
 *  - 4:5 세로 카드 + 하단 그라디언트 오버레이 위에 메타 — 갤러리 인상이 강해진다.
 *  - 호버 시 미세한 scale + 틸 보더 글로우.
 *  - `prop` 이름으로 `ref`를 쓰면 react-hooks/refs 룰이 ref hook으로 오인 → `item` 명사 사용.
 *
 * 그리드: 모바일 1열 / md 2열 / lg 3열.
 */
import { useState } from "react";
import { ExternalLink } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ReferenceImage } from "@/lib/search";

const SKELETON_COUNT = 5;

function thumbnailFor(pageUrl: string): string {
  return `https://image.thum.io/get/width/600/maxAge/12/${pageUrl}`;
}

function ReferenceCard({ item }: { item: ReferenceImage }) {
  const [src, setSrc] = useState<string>(item.image_url);
  const [hasFallback, setHasFallback] = useState(false);

  function onImgError() {
    if (hasFallback) return; // 무한 루프 방지
    const fallback = thumbnailFor(item.url);
    if (src !== fallback) {
      setSrc(fallback);
      setHasFallback(true);
    }
  }

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "group relative block overflow-hidden rounded-xl border border-border/80 bg-card transition-all",
        "hover:border-[color:var(--color-tc-accent)]/70 hover:shadow-[0_10px_40px_-20px_var(--color-tc-accent)]",
      )}
    >
      <div className="aspect-[4/5] w-full overflow-hidden bg-[color:var(--color-tc-surface-2)]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={item.title}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={onImgError}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
      </div>

      {/* 하단 그라디언트 + 메타 오버레이 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 via-black/45 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3.5">
        <p
          className="line-clamp-2 text-[13px] font-medium leading-snug text-white drop-shadow"
          title={item.title}
        >
          {item.title}
        </p>
        <div className="flex items-center justify-between gap-2 text-[11px] text-white/75">
          <span className="truncate" title={item.source}>
            {item.source || "출처 미상"}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[color:var(--color-tc-accent-hi)] transition-opacity opacity-90 group-hover:opacity-100">
            원문
            <ExternalLink className="h-3 w-3" strokeWidth={2} />
          </span>
        </div>
      </div>
    </a>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <div
          key={i}
          className="overflow-hidden rounded-xl border border-border/80 bg-card"
        >
          <Skeleton className="aspect-[4/5] w-full rounded-none" />
        </div>
      ))}
    </div>
  );
}

export function ReferenceGallery({
  refs,
  isLoading,
}: {
  refs: ReferenceImage[] | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return <GallerySkeleton />;
  }
  if (!refs || refs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/80 p-8 text-center text-sm text-muted-foreground">
        필터링이 강해 결과를 찾지 못했습니다 — 키워드를 다시 시도해 주세요
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {refs.map((item) => (
        <ReferenceCard key={item.url} item={item} />
      ))}
    </div>
  );
}
