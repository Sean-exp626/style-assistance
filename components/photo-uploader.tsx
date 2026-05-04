"use client";

/**
 * PhotoUploader — 카드형 드롭존 업로더.
 *
 * 단일 책임: "정면/측면/뒷면" 한 슬롯의 사진 선택 + 미리보기 + 제거.
 * 부모는 단순히 `file` 상태와 `onChange` 콜백만 관리.
 *
 * 디자인 의도:
 *  - native `<input type="file">`는 `sr-only`로 숨기고 라벨 클릭으로 트리거.
 *    → 모든 시각적 요소를 디자인 가능하게.
 *  - 16:10 종횡비 카드, 호버 시 틸 보더 + 미세한 글로우.
 *  - 파일 선택 시 카드 전체가 미리보기로 전환. HEIC는 비동기 변환 후 미리보기 생성.
 *  - 우상단 × 버튼으로 제거. 카드 전체 클릭은 새 파일 선택(교체).
 *  - capture="environment" 유지 → 모바일에서 후면 카메라 직캡쳐 가능.
 *
 * a11y:
 *  - <label>이 input과 연결돼 있어 키보드/스크린리더에서도 동작.
 *  - 제거 버튼은 별도 <button>으로 라벨 영역 밖에 배치 (이벤트 버블 차단).
 */

import { useEffect, useId, useState } from "react";
import { Camera, X } from "lucide-react";

import { FaceMeshOverlay } from "@/components/face-mesh-overlay";
import { cn } from "@/lib/utils";
import { convertHeicToJpeg, isHeic } from "@/lib/heic";

interface PhotoUploaderProps {
  label: string;
  /** 선택된 원본 파일. 부모가 상태를 보유한다. */
  file: File | null;
  /** 사용자가 새 파일을 고르거나 제거(null)할 때 호출. */
  onChange: (file: File | null) => void;
  /** 보조 안내 카피 (예: "정면을 향한 사진"). 선택. */
  hint?: string;
  className?: string;
  /**
   * 미리보기 자리에 FaceMeshOverlay를 띄운다 (정면 슬롯 한정).
   * mesh 카드도 label 클릭으로 파일 picker 트리거가 되도록 wrap.
   */
  withFaceMesh?: boolean;
  /** mesh 검출 결과(478개 트리플렛)를 부모에게 전달. */
  onLandmarks?: (lm: number[][] | null) => void;
}

export function PhotoUploader({
  label,
  file,
  onChange,
  hint,
  className,
  withFaceMesh = false,
  onLandmarks,
}: PhotoUploaderProps) {
  const inputId = useId();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);

  /**
   * 파일이 바뀔 때마다 미리보기 URL을 다시 만든다.
   *  - HEIC면 JPEG로 변환된 결과의 ObjectURL을 사용 (모든 브라우저에서 미리보기 OK).
   *  - cleanup으로 URL 누수 방지.
   *
   * 주의: HEIC 변환 자체는 부모의 onSubmit 단계에서도 한 번 더 일어나는데,
   * 같은 라이브러리(heic-to)가 결정론적으로 동작하므로 결과 일관성 OK.
   * 미리보기용 변환은 서버 전송과는 별개로 클라이언트 메모리에서만 산다.
   *
   * react-hooks/set-state-in-effect 룰을 피하려면 effect 본문에서 동기적으로
   * setState 하지 않고, 항상 비동기 작업을 거쳐 상태를 갱신한다. (`!file`인 경우의
   * 동기 리셋은 cleanup으로 처리하므로 effect 본문에서는 set 호출이 없다.)
   */
  useEffect(() => {
    if (!file) {
      // file이 null이면 effect를 사실상 no-op. 이전 effect의 cleanup에서 이미 URL을 해제하고
      // setPreviewUrl(null)을 호출했으므로 여기서 추가로 set할 필요가 없다.
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;

    async function build() {
      try {
        if (file && isHeic(file)) {
          if (!cancelled) setIsPreparing(true);
          const jpeg = await convertHeicToJpeg(file);
          if (cancelled) return;
          createdUrl = URL.createObjectURL(jpeg);
        } else if (file) {
          createdUrl = URL.createObjectURL(file);
        }
        if (!cancelled && createdUrl) {
          setPreviewUrl(createdUrl);
        }
      } catch (err) {
        // 미리보기 실패는 치명적이지 않음 — 부모 onSubmit에서 동일한 변환을 다시 시도한다.
        console.warn("Preview generation failed:", err);
        if (!cancelled) setPreviewUrl(null);
      } finally {
        if (!cancelled) setIsPreparing(false);
      }
    }
    void build();

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
      // file이 바뀌거나 컴포넌트가 unmount될 때 미리보기/준비 상태를 즉시 리셋.
      // cleanup에서 setState를 호출하는 건 lint 룰 대상이 아니다.
      setPreviewUrl(null);
      setIsPreparing(false);
    };
  }, [file]);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.files?.[0] ?? null;
    onChange(next);
    // 같은 파일을 다시 선택해도 onChange가 발화하도록 value 초기화
    e.target.value = "";
  }

  function handleRemove(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onChange(null);
  }

  const hasFile = !!file;

  return (
    <div className={cn("group relative", className)}>
      {/* sr-only input — 라벨이 트리거를 담당 */}
      <input
        id={inputId}
        type="file"
        accept="image/*,.heic,.heif"
        capture="environment"
        onChange={handleInputChange}
        className="sr-only"
      />

      <label
        htmlFor={inputId}
        className={cn(
          "relative flex aspect-[16/11] w-full cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border bg-card text-center transition-all",
          "border-border/80 ring-1 ring-transparent",
          "hover:border-[color:var(--color-tc-accent)] hover:ring-[color:var(--color-tc-accent-soft)] hover:shadow-[0_0_28px_-12px_var(--color-tc-accent)]",
          "focus-within:border-[color:var(--color-tc-accent-hi)] focus-within:ring-[color:var(--color-tc-accent-soft)]",
          hasFile && "border-[color:var(--color-tc-accent)] ring-[color:var(--color-tc-accent-soft)]",
        )}
      >
        {hasFile && previewUrl ? (
          <>
            {withFaceMesh ? (
              // mesh는 자체적으로 img/canvas/배지를 그린다. label 영역 안에 absolute로 배치하되
              // pointer-events-none을 주지 않아 mesh 영역도 클릭 시 file picker가 열린다.
              // mesh 컴포넌트의 figure는 자체 border/radius를 가지지만 label이 더 큰 카드라
              // 시각 충돌은 없다 (object-contain 박스로 mesh가 부모 안에서 fit).
              <FaceMeshOverlay
                source={previewUrl}
                onLandmarks={onLandmarks}
                variant="interactive"
                className="absolute inset-0 h-full w-full rounded-none border-0 bg-transparent"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={`${label} 미리보기`}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            {/* 하단 그라디언트 — 파일명 가독성 확보 */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/75 via-black/30 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 p-2.5">
              <span
                className="line-clamp-1 max-w-[75%] text-[11px] font-medium text-white/90"
                title={file?.name}
              >
                {file?.name}
              </span>
              <span className="rounded-md bg-[color:var(--color-tc-accent)]/90 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-tc-accent-fg)]">
                {label}
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-2.5 px-4">
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full border border-border/80 bg-[color:var(--color-tc-surface-2)] text-[color:var(--color-tc-text-muted)] transition-colors group-hover:border-[color:var(--color-tc-accent)] group-hover:text-[color:var(--color-tc-accent-hi)]"
            >
              <Camera className="h-4 w-4" strokeWidth={1.6} />
            </span>
            <span className="text-[10px] font-medium uppercase tracking-[0.32em] text-[color:var(--color-tc-text-soft)]">
              {label}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {isPreparing ? "준비 중…" : hint ?? "탭하여 사진 선택"}
            </span>
          </div>
        )}
      </label>

      {hasFile ? (
        <button
          type="button"
          onClick={handleRemove}
          aria-label={`${label} 사진 제거`}
          className={cn(
            "absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/90 backdrop-blur-sm transition-colors",
            "hover:bg-black/80 hover:text-white",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
          )}
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
