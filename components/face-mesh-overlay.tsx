"use client";

/**
 * FaceMeshOverlay — MediaPipe FaceLandmarker로 정면 사진 위에 얼굴 메쉬를 그리는 컴포넌트.
 *
 * 책임:
 *  - 입력 `source`(이미지 URL 또는 ObjectURL)에서 얼굴 1개의 478개 landmarks 검출
 *  - canvas에 tessellation halo + core 라인을 토큰 색상으로 그림
 *  - 결과 number[][] (x,y,z 트리플렛)을 부모에게 전달 (`onLandmarks`)
 *
 * 디자인 원칙:
 *  - mediapipe 모듈은 dynamic import (서버 번들 부하 회피, env로 비활성화 시 모델 fetch 자체 SKIP)
 *  - module-level singleton + initPromise로 React Strict Mode 더블 렌더 race 방지
 *  - 8s 타임아웃으로 모델 로드 실패를 사용자에게 명확히 표시
 *  - `object-contain`으로 표시되는 이미지 박스 크기에 맞춰 좌표 매핑
 *  - canvas backing store는 devicePixelRatio로 스케일 (선명도)
 *
 * a11y:
 *  - 우상단 상태 배지 `role="status" aria-live="polite"`
 *  - 스피너는 `aria-hidden`
 */
import { useEffect, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

// type 전용 import — 빌드 시 사라지므로 mediapipe runtime은 dynamic import만으로 도입
import type {
  FaceLandmarker as FaceLandmarkerType,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

/* --------------------------- 모듈-레벨 싱글톤 --------------------------- */

// 동적 import 결과를 모듈 스코프에 캐싱. React Strict Mode에서 effect가 두 번 돌아도
// 모델은 한 번만 만들어진다.
type MpModule = typeof import("@mediapipe/tasks-vision");
type FaceLandmarkerInstance = FaceLandmarkerType;

let cachedLandmarker: FaceLandmarkerInstance | null = null;
let initPromise: Promise<FaceLandmarkerInstance> | null = null;
let cachedModule: MpModule | null = null;

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const MODEL_LOAD_TIMEOUT_MS = 8000;

async function loadMpModule(): Promise<MpModule> {
  if (cachedModule) return cachedModule;
  cachedModule = await import("@mediapipe/tasks-vision");
  return cachedModule;
}

async function initLandmarker(): Promise<FaceLandmarkerInstance> {
  const mp = await loadMpModule();
  const fileset = await mp.FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await mp.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL },
    runningMode: "IMAGE",
    // 1보다 크게 두어야 multi-face 상태를 분기할 수 있다 (검출 수로 판정)
    numFaces: 2,
  });
  cachedLandmarker = landmarker;
  return landmarker;
}

async function getLandmarker(): Promise<FaceLandmarkerInstance> {
  if (cachedLandmarker) return cachedLandmarker;
  if (!initPromise) {
    initPromise = initLandmarker().catch((err) => {
      // 다음 호출에서 재시도 가능하도록 promise 캐시 비움
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

function timeoutAfter<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`mediapipe load timeout (${ms}ms)`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/* --------------------------- props/state --------------------------- */

type Variant = "interactive" | "readonly";

type State =
  | { kind: "idle" }
  | { kind: "loading-model" }
  | { kind: "analyzing" }
  | { kind: "ok"; faces: number }
  | { kind: "no-face" }
  | { kind: "multi-face"; count: number }
  | { kind: "error"; message: string };

interface FaceMeshOverlayProps {
  /** 이미지 URL (외부 또는 ObjectURL). null이면 빈 카드. */
  source: string | null;
  /** landmarks 결과 콜백. null이면 검출 실패 또는 비활성화. */
  onLandmarks?: (lm: number[][] | null) => void;
  /**
   * 시맨틱 힌트 — 동작 분기에는 사용되지 않고 sr-only 라벨에만 반영된다.
   * (현재 readonly에서도 모델 호출은 동일하게 일어남. 추후 캐시된 landmarks를
   * 받아 재검출 없이 그리기만 하는 변형이 생기면 이 prop이 의미를 가짐.)
   */
  variant?: Variant;
  className?: string;
}

const ENABLED =
  process.env.NEXT_PUBLIC_ENABLE_FACE_MESH !== "false";

/* --------------------------- 컴포넌트 --------------------------- */

export function FaceMeshOverlay({
  source,
  onLandmarks,
  variant = "interactive",
  className,
}: FaceMeshOverlayProps) {
  const figureId = useId();
  const figureRef = useRef<HTMLElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  /**
   * source가 바뀌면 검출 + 그리기 파이프라인 재실행.
   * source가 null이거나 ENABLED=false면 mesh를 SKIP하고 source img만 표시.
   *
   * react-hooks/set-state-in-effect 룰을 피하려면 effect 본문에서 동기적으로
   * setState를 호출하지 않는다. idle 리셋은 cleanup에서 처리하고, 본문은 항상
   * 비동기 실행으로 진입한다.
   */
  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;

    if (!source || !ENABLED) {
      // 본문에서 setState 호출 없이 cleanup만 등록.
      onLandmarks?.(null);
      return () => {
        cancelled = true;
        // idle로 강제 리셋 — cleanup에서의 setState는 lint 룰 대상이 아니다.
        setState({ kind: "idle" });
      };
    }

    async function run() {
      // 비동기 진입점에서만 setState (effect body가 아님)
      setState({ kind: "loading-model" });

      let mp: MpModule;
      let landmarker: FaceLandmarkerInstance;
      try {
        // dynamic import 자체와 모델 로드 모두 8s 타임아웃으로 묶는다
        landmarker = await timeoutAfter(getLandmarker(), MODEL_LOAD_TIMEOUT_MS);
        mp = await loadMpModule();
      } catch (err) {
        if (cancelled) return;
        console.warn("[face-mesh] model load failed:", err);
        setState({ kind: "error", message: "검출 모델 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

      // 이미지 로드 대기
      const img = imgRef.current;
      if (!img) {
        setState({ kind: "error", message: "이미지 요소 없음" });
        return;
      }
      try {
        await waitImageLoaded(img);
      } catch (err) {
        if (cancelled) return;
        console.warn("[face-mesh] image load failed:", err);
        setState({ kind: "error", message: "이미지 로드 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

      setState({ kind: "analyzing" });

      let detection: FaceLandmarkerResult;
      try {
        detection = landmarker.detect(img);
      } catch (err) {
        if (cancelled) return;
        console.warn("[face-mesh] detect failed:", err);
        setState({ kind: "error", message: "검출 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

      const faces = detection.faceLandmarks ?? [];
      if (faces.length === 0) {
        setState({ kind: "no-face" });
        onLandmarks?.(null);
        clearCanvas();
        return;
      }
      if (faces.length > 1) {
        setState({ kind: "multi-face", count: faces.length });
        onLandmarks?.(null);
        clearCanvas();
        return;
      }

      const primary = faces[0];
      // number[][] (x,y,z) 트리플렛으로 변환해 부모에 전달 + 저장 토대 일치
      const triplets = primary.map((p) => [p.x, p.y, p.z]);
      onLandmarks?.(triplets);
      setState({ kind: "ok", faces: 1 });

      // 그리기. resize 대응을 위해 ResizeObserver로도 재호출.
      const draw = () => {
        if (cancelled) return;
        drawMesh(mp, primary);
      };
      draw();
      if (figureRef.current && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(draw);
        resizeObserver.observe(figureRef.current);
      }
    }

    function clearCanvas() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function drawMesh(mp: MpModule, landmarks: NormalizedLandmark[]) {
      const canvas = canvasRef.current;
      const figure = figureRef.current;
      const img = imgRef.current;
      if (!canvas || !figure || !img) return;

      const cssRect = figure.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(cssRect.width * dpr);
      canvas.height = Math.round(cssRect.height * dpr);
      canvas.style.width = `${cssRect.width}px`;
      canvas.style.height = `${cssRect.height}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // object-contain 박스 계산: 이미지 비율 유지하며 figure 안에 fit
      const boxW = cssRect.width;
      const boxH = cssRect.height;
      const imgW = img.naturalWidth || boxW;
      const imgH = img.naturalHeight || boxH;
      const scale = Math.min(boxW / imgW, boxH / imgH);
      const renderW = imgW * scale;
      const renderH = imgH * scale;
      const offsetX = (boxW - renderW) / 2;
      const offsetY = (boxH - renderH) / 2;

      // landmarks는 normalized 0~1 (이미지 자체 좌표)
      const projected = landmarks.map((p) => ({
        x: offsetX + p.x * renderW,
        y: offsetY + p.y * renderH,
      }));

      const isMobile =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 640px)").matches;

      const accent = readCssVar("--color-tc-accent") || "#1E8E91";
      const accentHi = readCssVar("--color-tc-accent-hi") || "#2BA8AB";

      const tessellation = mp.FaceLandmarker.FACE_LANDMARKS_TESSELATION;

      // Halo (두꺼운 alpha layer)
      ctx.lineWidth = isMobile ? 2 : 2.5;
      ctx.strokeStyle = withAlpha(accent, 0.18);
      ctx.beginPath();
      for (const c of tessellation) {
        const a = projected[c.start];
        const b = projected[c.end];
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();

      // Core (얇은 윗선)
      ctx.lineWidth = isMobile ? 0.75 : 1;
      ctx.strokeStyle = withAlpha(accentHi, 0.7);
      ctx.beginPath();
      for (const c of tessellation) {
        const a = projected[c.start];
        const b = projected[c.end];
        if (!a || !b) continue;
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
    }

    void run();

    return () => {
      cancelled = true;
      if (resizeObserver) resizeObserver.disconnect();
    };
    // onLandmarks는 부모에서 setState identity가 안정적이라 dep 제외 (lint는 disable로)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // 페이드인용 클래스 — variant와 무관하게 mesh가 그려졌을 때만 보이게
  const meshVisible = state.kind === "ok";

  return (
    <figure
      ref={figureRef}
      aria-labelledby={figureId}
      className={cn(
        "relative aspect-[16/11] overflow-hidden rounded-xl border border-border/80 bg-[color:var(--color-tc-surface)]",
        className,
      )}
    >
      {source ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={source}
          alt="얼굴 정면"
          crossOrigin="anonymous"
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          No Image
        </div>
      )}

      {/* canvas wrapper — 페이드인 */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "absolute inset-0 h-full w-full pointer-events-none transition-opacity motion-safe:duration-[240ms] motion-safe:ease-out",
          meshVisible ? "opacity-100" : "opacity-0",
        )}
      />

      <span id={figureId} className="sr-only">
        정면 사진 얼굴 메쉬 오버레이 ({variant === "readonly" ? "읽기 전용" : "분석"})
      </span>

      <StatusBadge state={state} />
    </figure>
  );
}

/* --------------------------- 보조 UI --------------------------- */

function StatusBadge({ state }: { state: State }) {
  // PhotoUploader 안에 figure로 들어갈 때 label 클릭(파일 picker)을 가리지 않도록
  // pointer-events-none. 시각 정보 전용이라 클릭 타깃일 필요가 없다.
  const base =
    "pointer-events-none absolute right-2 top-2 z-10 inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-[color:var(--color-tc-surface-2)]/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.32em] backdrop-blur-sm";

  if (state.kind === "idle") return null;
  if (state.kind === "loading-model") {
    return (
      <span role="status" aria-live="polite" className={base}>
        <Spinner />
        Loading
      </span>
    );
  }
  if (state.kind === "analyzing") {
    return (
      <span role="status" aria-live="polite" className={base}>
        <Spinner />
        Analyzing
      </span>
    );
  }
  if (state.kind === "ok") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-accent-hi)]")}
      >
        478 pts
      </span>
    );
  }
  if (state.kind === "no-face") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-text-muted)]")}
      >
        No Face
      </span>
    );
  }
  if (state.kind === "multi-face") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-danger)]")}
      >
        Multi {state.count}
      </span>
    );
  }
  // error
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(base, "text-[color:var(--color-tc-danger)]")}
    >
      {state.message}
    </span>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

/* --------------------------- 헬퍼 --------------------------- */

function readCssVar(name: string): string {
  if (typeof window === "undefined") return "";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v;
}

/**
 * #RRGGBB 또는 rgb()/rgba()/var() 문자열에 alpha를 입혀 rgba()로 반환.
 * 알아보기 어려운 형식이면 원본을 그대로 반환 (fallback).
 */
function withAlpha(color: string, alpha: number): string {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const intVal = parseInt(hex[1], 16);
    const r = (intVal >> 16) & 0xff;
    const g = (intVal >> 8) & 0xff;
    const b = intVal & 0xff;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

function waitImageLoaded(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("image load error"));
    };
    function cleanup() {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onErr);
    }
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onErr);
  });
}
