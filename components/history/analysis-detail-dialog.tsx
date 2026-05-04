"use client";

/**
 * AnalysisDetailDialog — 분석 카드 클릭 시 열리는 상세 모달.
 *
 * 책임:
 *  - 단일 `HairAnalysisRecord`를 받아 모든 분석 정보를 한 화면에 정리
 *  - 본문은 가독성을 위해 섹션 단위 (Meta / Recommended / Director's Note / Keywords / References)
 *  - 모달의 open 상태는 `Dialog.Root`가 자체 관리 (uncontrolled)
 *
 * 디자인:
 *  - 기존 결과 패널(`ResultTabs`)의 톤을 가능한 한 그대로 가져와 통일감을 유지
 *  - 모바일에서 스크롤 가능한 본문 + 고정 헤더
 *
 * 의존:
 *  - `Dialog*` 프리미티브 (`@base-ui/react` wrap)
 *  - 외부 이미지는 `<img>` + `referrerPolicy="no-referrer"` (ReferenceGallery와 동일 정책)
 */
import { ExternalLink, Quote } from "lucide-react";

import { FaceShapeClassifier } from "@/components/face-shape-classifier";
import { Badge } from "@/components/ui/badge";
import {
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { classifyFaceShape } from "@/lib/face-shape";
import type { HairAnalysisRecord } from "@/lib/firebase/queries";

import { formatKstFull } from "./format";

interface AnalysisDetailDialogProps {
  record: HairAnalysisRecord;
  /** 관리자 뷰에서 사용자 식별 정보를 노출할지 여부 */
  showOwner?: boolean;
}

export function AnalysisDetailDialog({
  record,
  showOwner = false,
}: AnalysisDetailDialogProps) {
  const { result, references } = record;

  return (
    <DialogContent>
      {/* 헤더 — 고정 영역 */}
      <header className="border-b border-border/70 px-5 py-4 sm:px-7 sm:py-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
          Recommended Style
        </p>
        <DialogTitle className="mt-1.5">
          {result.recommended_style.name || "스타일 정보 없음"}
        </DialogTitle>
        <DialogDescription className="mt-1 text-[12px]">
          {formatKstFull(record.createdAt)} · {record.gender} ·{" "}
          {record.lengthPreference}
        </DialogDescription>

        {showOwner ? (
          <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
            <OwnerAvatar
              photoURL={record.userPhotoURL}
              name={record.userDisplayName ?? record.userEmail ?? "사용자"}
            />
            <span className="truncate">
              {record.userDisplayName ?? "이름 없음"}
              {record.userEmail ? ` · ${record.userEmail}` : ""}
            </span>
          </div>
        ) : null}
      </header>

      {/* 본문 — 스크롤 가능 */}
      <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
        <div className="space-y-6">
          {/* Face Shape 6분류 — 분류 가능할 때만 (history는 hideOnNull) */}
          <FaceShapeClassifier
            matched={classifyFaceShape(
              record.result,
              record.frontLandmarks ?? null,
            )}
            faceShapeText={record.result.face_shape}
            hideOnNull
          />

          {/* Meta cards */}
          <div className="grid gap-2.5 sm:grid-cols-3">
            <MetricCard label="Face Shape" value={result.face_shape} />
            <MetricCard label="Head Profile" value={result.head_shape} />
            <MetricCard label="Length" value={result.recommended_style.length} />
          </div>

          {/* Key features */}
          {result.recommended_style.key_features.length > 0 ? (
            <section>
              <SectionLabel>Key Features</SectionLabel>
              <ul className="mt-3 space-y-2">
                {result.recommended_style.key_features.map((feature, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 text-[14px] leading-relaxed"
                  >
                    <span
                      aria-hidden
                      className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-tc-accent-hi)] shadow-[0_0_10px_var(--color-tc-accent)]"
                    />
                    <span className="text-foreground/90">{feature}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* Director's note */}
          {result.professional_analysis ? (
            <section className="relative overflow-hidden rounded-xl border border-border/80 bg-[color:var(--color-tc-surface)]/70 p-5 sm:p-6">
              <div className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-[color:var(--color-tc-accent-hi)] to-[color:var(--color-tc-accent)]" />
              <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
                <Quote className="h-3 w-3" strokeWidth={2.2} />
                Director&apos;s Note
              </div>
              <p className="mt-3 whitespace-pre-line text-[14px] leading-[1.85] text-foreground/90">
                {result.professional_analysis}
              </p>
            </section>
          ) : null}

          {/* Search keywords */}
          {result.search_keywords.length > 0 ? (
            <section>
              <SectionLabel>Search Keywords</SectionLabel>
              <div className="mt-3 flex flex-wrap gap-2">
                {result.search_keywords.map((kw) => (
                  <Badge
                    key={kw}
                    variant="outline"
                    className="h-7 border-border/80 bg-[color:var(--color-tc-surface-2)] px-3 text-[12px] font-normal"
                  >
                    {kw}
                  </Badge>
                ))}
              </div>
            </section>
          ) : null}

          {/* References gallery */}
          <section>
            <SectionLabel>References</SectionLabel>
            {references.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-border/80 px-5 py-8 text-center text-[13px] text-muted-foreground">
                레퍼런스 이미지가 저장되지 않았습니다.
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                {references.map((item) => (
                  <ReferenceMini key={item.url} item={item} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </DialogContent>
  );
}

/* ----------------------------- Sub-views ----------------------------- */

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
      {children}
    </p>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-card p-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-[14px] font-medium leading-snug text-foreground">
        {value || "—"}
      </p>
    </div>
  );
}

function ReferenceMini({
  item,
}: {
  item: { title: string; url: string; image_url: string; source: string };
}) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noreferrer"
      className="group relative block overflow-hidden rounded-lg border border-border/80 bg-[color:var(--color-tc-surface-2)] transition-colors hover:border-[color:var(--color-tc-accent)]/70"
    >
      <div className="aspect-[4/5] w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={item.image_url}
          alt={item.title}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1.5 p-2">
        <span
          className="line-clamp-1 text-[11px] text-white/90 drop-shadow"
          title={item.source}
        >
          {item.source || "출처 미상"}
        </span>
        <ExternalLink
          className="h-3 w-3 text-[color:var(--color-tc-accent-hi)]"
          strokeWidth={2}
        />
      </div>
    </a>
  );
}

function OwnerAvatar({
  photoURL,
  name,
}: {
  photoURL: string | null;
  name: string;
}) {
  if (photoURL) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoURL}
        alt={name}
        referrerPolicy="no-referrer"
        className="h-5 w-5 rounded-full object-cover"
      />
    );
  }
  const initial = (name[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-5 w-5 items-center justify-center rounded-full bg-[color:var(--color-tc-accent)] text-[10px] font-semibold text-[color:var(--color-tc-accent-fg)]"
    >
      {initial}
    </span>
  );
}
