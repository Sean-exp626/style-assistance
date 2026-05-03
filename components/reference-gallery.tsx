"use client";

/**
 * Reference Gallery — 분석 결과 keywords 기반 레퍼런스 이미지 그리드.
 *
 * 디자인 결정:
 *  - Next `<Image>` 대신 native `<img>` — 외부 도메인 화이트리스트 관리 부담을 피함.
 *  - `loading="lazy"` + `referrerPolicy="no-referrer"` — 일부 사이트의 hotlink 차단 회피.
 *  - `<img onError>`로 thum.io 페이지 스크린샷 폴백 (서버 image_url이 410/404로 깨질 경우).
 *  - 16:10 aspect-ratio + object-cover + max-h-[380px] — 다양한 비율 사진을 균일하게.
 *  - 모바일 1열 / md 2열 / lg 3열 — Phase 2 기본 그리드.
 *
 * Phase 3에서 디자인 폴리싱 (그라디언트, Cormorant Garamond, 펄스 등) 적용 예정.
 *
 * 주의: prop 이름으로 `ref`를 쓰면 React 19/eslint react-hooks/refs 룰이 ref hook으로
 * 오인해 에러를 띄운다. `item` 같은 도메인 명사로 명명한다.
 */
import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReferenceImage } from "@/lib/search";

const SKELETON_COUNT = 5;

function thumbnailFor(pageUrl: string): string {
  return `https://image.thum.io/get/width/600/maxAge/12/${pageUrl}`;
}

function ReferenceCard({ item }: { item: ReferenceImage }) {
  const [src, setSrc] = useState<string>(item.image_url);
  const [hasFallback, setHasFallback] = useState(false);

  function onImgError() {
    if (hasFallback) return; // 무한 루프 방지: 폴백도 깨지면 그대로 둠
    const fallback = thumbnailFor(item.url);
    if (src !== fallback) {
      setSrc(fallback);
      setHasFallback(true);
    }
  }

  return (
    <Card className="overflow-hidden p-0">
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer"
        className="group block"
      >
        <div className="aspect-[16/10] w-full overflow-hidden bg-muted">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={item.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={onImgError}
            className="h-full max-h-[380px] w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
          />
        </div>
      </a>
      <CardContent className="space-y-1 p-3">
        <p className="line-clamp-2 text-sm font-medium" title={item.title}>
          {item.title}
        </p>
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="truncate" title={item.source}>
            {item.source || "출처 미상"}
          </span>
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 underline-offset-2 hover:underline"
          >
            원문 보기 →
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function GallerySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
        <Card key={i} className="overflow-hidden p-0">
          <Skeleton className="aspect-[16/10] w-full rounded-none" />
          <CardContent className="space-y-2 p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </CardContent>
        </Card>
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
      <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        레퍼런스 이미지를 찾지 못했습니다. 다시 시도해 주세요.
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
