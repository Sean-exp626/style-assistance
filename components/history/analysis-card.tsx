"use client";

/**
 * AnalysisCard — 히스토리/관리자 그리드의 단위 카드.
 *
 * 책임:
 *  - 한 건의 분석 레코드를 카드로 표시하고, 클릭 시 상세 모달을 연다
 *  - Dialog 상태는 base-ui Dialog Root가 자체 관리
 *
 * 디자인 결정:
 *  - 카드 자체를 `<button>`(DialogTrigger)으로 만들어 키보드/스크린리더 접근 보장
 *  - 첫 references 이미지를 썸네일로 사용 (없으면 placeholder — 그라디언트 + 로고)
 *  - 호버 시 미세한 lift + 틸 글로우
 *
 * 관리자 모드(`showOwner`):
 *  - 우측 상단에 사용자 아바타+이메일을 작게 노출
 */
import { ImageOff } from "lucide-react";

import { Dialog, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { HairAnalysisRecord } from "@/lib/firebase/queries";

import { AnalysisDetailDialog } from "./analysis-detail-dialog";
import { formatKstShort } from "./format";

interface AnalysisCardProps {
  record: HairAnalysisRecord;
  /** 관리자 화면에서 사용자 이메일/아바타 노출 */
  showOwner?: boolean;
}

export function AnalysisCard({ record, showOwner = false }: AnalysisCardProps) {
  const thumbnail = record.references[0] ?? null;
  const styleName = record.result.recommended_style.name || "분석 결과";
  const timestamp = formatKstShort(record.createdAt);

  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            aria-label={`${styleName} 분석 결과 자세히 보기`}
            className={cn(
              "group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-card text-left",
              "transition-all duration-300",
              "hover:-translate-y-0.5 hover:border-[color:var(--color-tc-accent)]/70",
              "hover:shadow-[0_18px_50px_-25px_var(--color-tc-accent)]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
            )}
          >
            <CardThumbnail thumbnail={thumbnail} alt={styleName} />

            <div className="flex flex-1 flex-col gap-2 px-4 py-3.5 sm:px-5 sm:py-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-muted-foreground">
                {timestamp}
              </p>
              <h3 className="line-clamp-2 font-sans text-[15px] font-semibold leading-snug tracking-[-0.01em] text-foreground sm:text-base">
                {styleName}
              </h3>
              <div className="mt-auto flex items-center justify-between gap-2 pt-1.5 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {record.gender} · {record.lengthPreference}
                </span>
                <span className="shrink-0 text-[color:var(--color-tc-accent-hi)] opacity-0 transition-opacity group-hover:opacity-100">
                  자세히 →
                </span>
              </div>

              {showOwner ? (
                <OwnerLine
                  photoURL={record.userPhotoURL}
                  name={record.userDisplayName}
                  email={record.userEmail}
                />
              ) : null}
            </div>
          </button>
        }
      />
      <AnalysisDetailDialog record={record} showOwner={showOwner} />
    </Dialog>
  );
}

/* ----------------------------- Sub-views ----------------------------- */

function CardThumbnail({
  thumbnail,
  alt,
}: {
  thumbnail: { image_url: string; url: string } | null;
  alt: string;
}) {
  if (!thumbnail) {
    return (
      <div className="relative flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-[color:var(--color-tc-surface-2)] via-[color:var(--color-tc-surface)] to-[color:var(--color-tc-bg)]">
        <ImageOff
          className="h-7 w-7 text-muted-foreground/40"
          strokeWidth={1.5}
        />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[color:var(--color-tc-accent)]/30 to-transparent" />
      </div>
    );
  }

  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-[color:var(--color-tc-surface-2)]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbnail.image_url}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
    </div>
  );
}

function OwnerLine({
  photoURL,
  name,
  email,
}: {
  photoURL: string | null;
  name: string | null;
  email: string | null;
}) {
  const display = name ?? email ?? "사용자";
  const initial = (display[0] ?? "?").toUpperCase();
  return (
    <div className="mt-2 flex items-center gap-2 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
      {photoURL ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoURL}
          alt={display}
          referrerPolicy="no-referrer"
          className="h-5 w-5 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden
          className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-tc-accent)] text-[10px] font-semibold text-[color:var(--color-tc-accent-fg)]"
        >
          {initial}
        </span>
      )}
      <span className="truncate" title={email ?? undefined}>
        {email ?? display}
      </span>
    </div>
  );
}
