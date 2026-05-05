"use client";

/**
 * FaceMeshOverlay — 사진 위 분석 시각화 오버레이.
 *
 * 두 가지 모드:
 *  - mode="face" (default, 정면/측면): MediaPipe FaceLandmarker로 얼굴 메쉬 검출
 *    - 478 landmarks tessellation을 토큰 색상으로 그림
 *    - 결과를 `onLandmarks`로 전달
 *    - 측면(profile) 사진은 검출 신뢰도가 낮을 수 있음 — no-face로 떨어져도 정상 흐름
 *  - mode="head" (뒷면): mediapipe 호출 없이 시뮬레이션된 두상 분석 시각 피드백
 *    - 약 2.2초 간 스캔 라인 → 4-corner 브래킷 + "Profile Mapped" 배지
 *    - landmarks는 항상 null
 *
 * 공통 시각:
 *  - 분석 중(loading/analyzing): 청록 가로 스캔 라인이 위→아래로 1.4s 루프
 *  - 결과 시: 페이드인 (240ms)
 *
 * 디자인 원칙:
 *  - mediapipe 모듈은 dynamic import (서버 번들 부하 회피, env로 비활성화 시 모델 fetch SKIP)
 *  - module-level singleton + initPromise로 React Strict Mode 더블 렌더 race 방지
 *  - 8s 타임아웃으로 모델 로드 실패를 사용자에게 명확히 표시
 *  - `object-contain`으로 표시되는 이미지 박스 크기에 맞춰 좌표 매핑
 *  - canvas backing store는 devicePixelRatio로 스케일 (선명도)
 *
 * a11y:
 *  - 우상단 상태 배지 `role="status" aria-live="polite"`
 *  - 스캔 라인은 `aria-hidden`
 */
import { useEffect, useId, useRef, useState } from "react";

import {
  computeSideProfileMetrics,
  extractSideProfileLandmarks,
  type SideProfileLandmarks,
  type SideProfileMetrics,
} from "@/lib/face-shape";
import { cn } from "@/lib/utils";

import type {
  FaceLandmarker as FaceLandmarkerType,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

/* --------------------------- 모듈-레벨 싱글톤 --------------------------- */

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
const HEAD_SCAN_DURATION_MS = 2200;

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
    numFaces: 2,
    // 측면 사진 검출률을 높이기 위해 임계값을 낮춤. 정면 false-positive 위험은
    // numFaces 상한과 결과 후처리(no-face/multi-face) 분기로 제한.
    minFaceDetectionConfidence: 0.1,
    minFacePresenceConfidence: 0.1,
    minTrackingConfidence: 0.1,
  });
  cachedLandmarker = landmarker;
  return landmarker;
}

async function getLandmarker(): Promise<FaceLandmarkerInstance> {
  if (cachedLandmarker) return cachedLandmarker;
  if (!initPromise) {
    initPromise = initLandmarker().catch((err) => {
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
type Mode = "face" | "profile" | "head";

type State =
  | { kind: "idle" }
  | { kind: "loading-model" }
  | { kind: "analyzing" }
  | { kind: "ok"; faces: number }                       // face mode 성공 (실제 landmarks)
  | { kind: "profile-detected"; pointCount: number }    // profile mode 검출 성공
  | { kind: "profile-estimated" }                       // profile mode 폴백 (synth overlay)
  | { kind: "head-mapped" }                             // head mode 성공
  | { kind: "no-face" }
  | { kind: "multi-face"; count: number }
  | { kind: "error"; message: string };

interface FaceMeshOverlayProps {
  source: string | null;
  onLandmarks?: (lm: number[][] | null) => void;
  /**
   * 측면 모드 검출 성공시 sparse landmarks를 부모로 전달.
   * 검출 실패(estimated 폴백)일 때는 `null`로 호출.
   */
  onSideLandmarks?: (v: SideProfileLandmarks | null) => void;
  /** 측면 4각도 메트릭. 검출 실패시 `null`. */
  onSideMetrics?: (v: SideProfileMetrics | null) => void;
  variant?: Variant;
  mode?: Mode;
  className?: string;
}

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_FACE_MESH !== "false";

/* --------------------------- 컴포넌트 --------------------------- */

export function FaceMeshOverlay({
  source,
  onLandmarks,
  onSideLandmarks,
  onSideMetrics,
  variant = "interactive",
  mode = "face",
  className,
}: FaceMeshOverlayProps) {
  const figureId = useId();
  const descId = useId();
  const figureRef = useRef<HTMLElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let headTimer: ReturnType<typeof setTimeout> | null = null;

    if (!source || !ENABLED) {
      onLandmarks?.(null);
      onSideLandmarks?.(null);
      onSideMetrics?.(null);
      return () => {
        cancelled = true;
        setState({ kind: "idle" });
      };
    }

    /* ============= head mode (뒷면) — mediapipe 우회, 시각만 ============= */
    if (mode === "head") {
      onLandmarks?.(null);

      async function runHead() {
        setState({ kind: "loading-model" });
        const img = imgRef.current;
        if (!img) {
          setState({ kind: "error", message: "이미지 요소 없음" });
          return;
        }
        try {
          await waitImageLoaded(img);
        } catch {
          if (cancelled) return;
          setState({ kind: "error", message: "이미지 로드 실패" });
          return;
        }
        if (cancelled) return;
        setState({ kind: "analyzing" });
        headTimer = setTimeout(() => {
          if (cancelled) return;
          setState({ kind: "head-mapped" });
        }, HEAD_SCAN_DURATION_MS);
      }
      void runHead();

      return () => {
        cancelled = true;
        if (headTimer) clearTimeout(headTimer);
      };
    }

    /* ============= face/profile mode — mediapipe 검출 (통합 경로) =============
     *
     * 측면 모드도 동일한 mediapipe 호출을 시도한다. 단,
     *  - 검출 실패(model load fail / no-face / multi-face / OOF keypoint 다수)
     *    인 경우 합성 overlay로 자연스럽게 폴백 (기존 사용자 경험 유지).
     *  - 검출 성공시 sparse polyline + cross marker로 실제 좌표를 시각화하고,
     *    부모로 SideProfileLandmarks/SideProfileMetrics를 흘려보낸다. */
    /**
     * 측면 모드 폴백으로 떨어지는 진입점. 합성 overlay를 그리고 부모에 null을 흘려준다.
     * resize 시에도 합성 overlay가 다시 그려지도록 ResizeObserver를 붙인다.
     */
    function enterProfileFallback() {
      if (cancelled) return;
      setState({ kind: "profile-estimated" });
      onSideLandmarks?.(null);
      onSideMetrics?.(null);
      drawProfileFallback();
      if (figureRef.current && typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(drawProfileFallback);
        resizeObserver.observe(figureRef.current);
      }
    }

    async function run() {
      setState({ kind: "loading-model" });

      let mp: MpModule;
      let landmarker: FaceLandmarkerInstance;
      try {
        landmarker = await timeoutAfter(getLandmarker(), MODEL_LOAD_TIMEOUT_MS);
        mp = await loadMpModule();
      } catch (err) {
        if (cancelled) return;
        console.warn("[face-mesh] model load failed:", err);
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
        setState({ kind: "error", message: "검출 모델 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

      const img = imgRef.current;
      if (!img) {
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
        setState({ kind: "error", message: "이미지 요소 없음" });
        return;
      }
      try {
        await waitImageLoaded(img);
      } catch (err) {
        if (cancelled) return;
        console.warn("[face-mesh] image load failed:", err);
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
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
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
        setState({ kind: "error", message: "검출 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

      const faces = detection.faceLandmarks ?? [];
      if (faces.length === 0) {
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
        setState({ kind: "no-face" });
        onLandmarks?.(null);
        clearCanvas();
        return;
      }
      if (faces.length > 1) {
        if (mode === "profile") {
          enterProfileFallback();
          return;
        }
        setState({ kind: "multi-face", count: faces.length });
        onLandmarks?.(null);
        clearCanvas();
        return;
      }

      const primary = faces[0];

      // ============ 측면 모드: sparse keypoint 추출 시도 ============
      if (mode === "profile") {
        const slm = extractSideProfileLandmarks(primary);
        if (!slm) {
          enterProfileFallback();
          return;
        }
        const metrics = computeSideProfileMetrics(slm);
        onSideLandmarks?.(slm);
        onSideMetrics?.(metrics);
        const pointCount = Object.keys(slm.keypoints).length;
        setState({ kind: "profile-detected", pointCount });

        const drawSide = () => {
          if (cancelled) return;
          drawProfileSparse(primary, slm);
        };
        drawSide();
        if (figureRef.current && typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(drawSide);
          resizeObserver.observe(figureRef.current);
        }
        return;
      }

      // ============ 정면 모드: 478점 mesh 시각화 ============
      const triplets = primary.map((p) => [p.x, p.y, p.z]);
      onLandmarks?.(triplets);
      setState({ kind: "ok", faces: 1 });

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

    /**
     * profile mode 폴백 — landmarks 없이 figure 박스 비례로 합성 overlay 그리기.
     * 좌측 facing(코가 왼쪽으로 돌출) 가정. 우측 facing이어도 시각적으로 어색하지 않도록
     * 좌우 대칭성을 일부 유지.
     */
    function drawProfileFallback() {
      const canvas = canvasRef.current;
      const figure = figureRef.current;
      if (!canvas || !figure) return;
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

      const W = cssRect.width;
      const H = cssRect.height;
      const isMobile =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 640px)").matches;

      const cyan = readCssVar("--color-tc-accent-hi") || "#2BA8AB";
      const white = readCssVar("--color-tc-text") || "#ECEEED";
      const red = readCssVar("--color-tc-danger") || "#E26D6D";
      const green = "#7DDB7A";

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 1) 흰 dashed — 세로 중심선 + 수평 레벨 라인 (이마/눈/코/입/턱)
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(white, 0.45);
      ctx.lineWidth = isMobile ? 0.6 : 0.8;
      // 세로
      ctx.beginPath();
      ctx.moveTo(W * 0.5, H * 0.12);
      ctx.lineTo(W * 0.5, H * 0.92);
      ctx.stroke();
      // 수평 레벨 5개
      const levels = [0.22, 0.36, 0.52, 0.68, 0.85];
      for (const lv of levels) {
        ctx.beginPath();
        ctx.moveTo(W * 0.18, H * lv);
        ctx.lineTo(W * 0.82, H * lv);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // 2) 흰 윤곽 — 측면 silhouette 근사 (좌측 facing 가정)
      ctx.strokeStyle = white;
      ctx.lineWidth = isMobile ? 0.9 : 1.1;
      ctx.beginPath();
      ctx.moveTo(W * 0.55, H * 0.12); // 정수리
      ctx.bezierCurveTo(W * 0.42, H * 0.13, W * 0.32, H * 0.25, W * 0.30, H * 0.40); // 이마-코 위
      ctx.bezierCurveTo(W * 0.26, H * 0.46, W * 0.26, H * 0.54, W * 0.32, H * 0.58); // 코끝 돌출
      ctx.bezierCurveTo(W * 0.34, H * 0.62, W * 0.34, H * 0.68, W * 0.40, H * 0.72); // 인중-입
      ctx.bezierCurveTo(W * 0.42, H * 0.78, W * 0.45, H * 0.85, W * 0.55, H * 0.90); // 턱
      ctx.stroke();

      // 3) 빨간 분석 삼각형 (이마-코끝-턱) + 빨간 점
      const tri = [
        { x: W * 0.50, y: H * 0.20 }, // 이마
        { x: W * 0.30, y: H * 0.52 }, // 코끝
        { x: W * 0.50, y: H * 0.88 }, // 턱
      ];
      ctx.strokeStyle = withAlpha(red, 0.8);
      ctx.lineWidth = isMobile ? 1 : 1.3;
      ctx.beginPath();
      ctx.moveTo(tri[0].x, tri[0].y);
      ctx.lineTo(tri[1].x, tri[1].y);
      ctx.lineTo(tri[2].x, tri[2].y);
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = red;
      ctx.shadowColor = red;
      ctx.shadowBlur = isMobile ? 3 : 5;
      const redDotR = isMobile ? 2.5 : 3.5;
      for (const p of tri) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, redDotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // 4) 초록 jaw angle 라인 (귀-턱)
      ctx.strokeStyle = green;
      ctx.lineWidth = isMobile ? 1.4 : 1.8;
      ctx.shadowColor = green;
      ctx.shadowBlur = isMobile ? 3 : 4;
      ctx.beginPath();
      ctx.moveTo(W * 0.62, H * 0.55); // 귀 부근
      ctx.lineTo(W * 0.50, H * 0.88); // 턱 끝
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 5) 청록 cross 마커 — 정수리/이마/코끝/입/턱
      // shadowBlur는 estimated 폴백임을 시각적으로 한 단계 약하게 표현 (mobile 3, desktop 4)
      ctx.strokeStyle = cyan;
      ctx.lineWidth = isMobile ? 1.5 : 1.8;
      ctx.shadowColor = cyan;
      ctx.shadowBlur = isMobile ? 3 : 4;
      const crossSize = isMobile ? 4 : 5.5;
      const crosses = [
        { x: W * 0.50, y: H * 0.20 },
        { x: W * 0.30, y: H * 0.52 },
        { x: W * 0.40, y: H * 0.72 },
        { x: W * 0.50, y: H * 0.88 },
      ];
      for (const p of crosses) {
        ctx.beginPath();
        ctx.moveTo(p.x - crossSize, p.y);
        ctx.lineTo(p.x + crossSize, p.y);
        ctx.moveTo(p.x, p.y - crossSize);
        ctx.lineTo(p.x, p.y + crossSize);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
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

      const boxW = cssRect.width;
      const boxH = cssRect.height;
      const imgW = img.naturalWidth || boxW;
      const imgH = img.naturalHeight || boxH;
      const scale = Math.min(boxW / imgW, boxH / imgH);
      const renderW = imgW * scale;
      const renderH = imgH * scale;
      const offsetX = (boxW - renderW) / 2;
      const offsetY = (boxH - renderH) / 2;

      const projected = landmarks.map((p) => ({
        x: offsetX + p.x * renderW,
        y: offsetY + p.y * renderH,
      }));

      const isMobile =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 640px)").matches;

      // [Image #9] reference — facial proportion analysis 다층 오버레이.
      // 5개 레이어를 순차로 그려 미용/성형 분석 차트의 외관을 재현한다.
      const cyan = readCssVar("--color-tc-accent-hi") || "#2BA8AB";
      const white = readCssVar("--color-tc-text") || "#ECEEED";
      const red = readCssVar("--color-tc-danger") || "#E26D6D";
      const green = "#7DDB7A"; // facial analysis green (디자인 토큰 외 단발성 사용)

      const Mp = mp.FaceLandmarker;

      // polyline 헬퍼
      const drawLine = (idx: number[]) => {
        if (idx.length < 2) return;
        ctx.beginPath();
        const first = projected[idx[0]];
        if (!first) return;
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < idx.length; i++) {
          const p = projected[idx[i]];
          if (!p) continue;
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      };
      const drawGroup = (g: Array<{ start: number; end: number }> | undefined) => {
        if (!g) return;
        for (const c of g) {
          const a = projected[c.start];
          const b = projected[c.end];
          if (!a || !b) continue;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      };

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      /* ===== Layer 1: 흰 윤곽선 (얼굴/눈썹/눈/코/입) ===== */
      ctx.strokeStyle = white;
      ctx.lineWidth = isMobile ? 0.9 : 1.1;
      ctx.shadowBlur = 0;

      drawGroup(Mp.FACE_LANDMARKS_FACE_OVAL);
      drawGroup(Mp.FACE_LANDMARKS_LEFT_EYEBROW);
      drawGroup(Mp.FACE_LANDMARKS_RIGHT_EYEBROW);
      drawGroup(Mp.FACE_LANDMARKS_LEFT_EYE);
      drawGroup(Mp.FACE_LANDMARKS_RIGHT_EYE);
      // 입술 outer (mediapipe LIPS는 inner도 포함해 두꺼워 보이므로 outer만 수동)
      drawLine([61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291]); // upper outer
      drawLine([291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61]); // lower outer
      // 코 — 다리 + 양 wing
      drawLine([168, 6, 197, 195, 5, 4, 1]); // bridge → tip
      drawLine([49, 64, 1, 294, 279]); // wings ↔ tip

      /* ===== Layer 2: 흰 dashed 보조선 (수직/수평/내부 삼각) ===== */
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(white, 0.45);
      ctx.lineWidth = isMobile ? 0.6 : 0.75;
      drawLine([10, 168, 1, 0, 17, 152]); // 세로 중심선
      drawLine([33, 263]); // 수평 동공선
      drawLine([33, 152]); // 좌 눈 → 턱
      drawLine([263, 152]); // 우 눈 → 턱
      drawLine([33, 1, 263]); // 눈-코끝-눈 V 삼각
      ctx.setLineDash([]);

      /* ===== Layer 3: 빨간 분석 삼각형 (광대-광대-턱) + 빨간 점 ===== */
      ctx.strokeStyle = withAlpha(red, 0.8);
      ctx.lineWidth = isMobile ? 1 : 1.3;
      drawLine([234, 454, 152, 234]);

      ctx.fillStyle = red;
      ctx.shadowColor = red;
      ctx.shadowBlur = isMobile ? 3 : 5;
      const redDotR = isMobile ? 2.5 : 3.5;
      for (const idx of [234, 454, 152]) {
        const p = projected[idx];
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, redDotR, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      /* ===== Layer 4: 초록 nasolabial 라인 (코 wing → 입꼬리) ===== */
      ctx.strokeStyle = green;
      ctx.lineWidth = isMobile ? 1.4 : 1.8;
      ctx.shadowColor = green;
      ctx.shadowBlur = isMobile ? 3 : 4;
      drawLine([64, 61]); // 좌
      drawLine([294, 291]); // 우
      ctx.shadowBlur = 0;

      /* ===== Layer 5: 청록 cross 마커 (key landmarks) ===== */
      ctx.strokeStyle = cyan;
      ctx.lineWidth = isMobile ? 1.5 : 1.8;
      ctx.shadowColor = cyan;
      ctx.shadowBlur = isMobile ? 4 : 6;
      const crossSize = isMobile ? 4 : 5.5;
      for (const idx of [33, 133, 263, 362, 64, 294, 61, 291]) {
        const p = projected[idx];
        if (!p) continue;
        ctx.beginPath();
        ctx.moveTo(p.x - crossSize, p.y);
        ctx.lineTo(p.x + crossSize, p.y);
        ctx.moveTo(p.x, p.y - crossSize);
        ctx.lineTo(p.x, p.y + crossSize);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    /**
     * 측면 sparse overlay — 검출 성공시 7개 keypoint를 polyline + cross로 시각화.
     *
     * 레이어 구성 (drawMesh와 같은 projection 헬퍼 사용):
     *  1) 청록 polyline (forehead → nose_bridge → nose_tip → philtrum → lower_lip → chin)
     *  2) 초록 jaw line (ear_front → chin) — ear_front 누락시 생략 + chin glow boost
     *  3) 빨간 분석 삼각형 (forehead → nose_tip → chin) + 빨간 점
     *  4) 청록 cross 마커 (in-frame인 모든 keypoint)
     */
    function drawProfileSparse(
      landmarks: NormalizedLandmark[],
      slm: SideProfileLandmarks,
    ) {
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

      const boxW = cssRect.width;
      const boxH = cssRect.height;
      const imgW = img.naturalWidth || boxW;
      const imgH = img.naturalHeight || boxH;
      const scale = Math.min(boxW / imgW, boxH / imgH);
      const renderW = imgW * scale;
      const renderH = imgH * scale;
      const offsetX = (boxW - renderW) / 2;
      const offsetY = (boxH - renderH) / 2;

      const project = (p: { x: number; y: number }) => ({
        x: offsetX + p.x * renderW,
        y: offsetY + p.y * renderH,
      });

      // MediaPipe 인덱스 매핑 — face-shape.ts와 동일
      const NOSE_TIP = 1;
      const NOSE_BRIDGE = 6;
      const FOREHEAD = 10;
      const PHILTRUM = 0;
      const LOWER_LIP = 17;
      const CHIN = 152;

      // slm.keypoints에 어떤 이름이 있는지 = "in-frame인 keypoint"
      const has = (name: keyof SideProfileLandmarks["keypoints"]) =>
        slm.keypoints[name] !== undefined;

      const proj = {
        forehead: has("forehead") ? project(landmarks[FOREHEAD]) : null,
        nose_bridge: has("nose_bridge") ? project(landmarks[NOSE_BRIDGE]) : null,
        nose_tip: has("nose_tip") ? project(landmarks[NOSE_TIP]) : null,
        philtrum: has("philtrum") ? project(landmarks[PHILTRUM]) : null,
        lower_lip: has("lower_lip") ? project(landmarks[LOWER_LIP]) : null,
        chin: has("chin") ? project(landmarks[CHIN]) : null,
      } as const;

      // ear_front: slm.keypoints.ear_front의 raw [x,y]를 그대로 project
      const earKp = slm.keypoints.ear_front;
      const earProj = earKp ? project({ x: earKp[0], y: earKp[1] }) : null;

      const isMobile =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 640px)").matches;

      const cyan = readCssVar("--color-tc-accent-hi") || "#2BA8AB";
      const red = readCssVar("--color-tc-danger") || "#E26D6D";
      const green = "#7DDB7A";

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      /* ===== 1) 청록 polyline (검출된 keypoint 중에서) ===== */
      const polylineOrder: Array<keyof typeof proj> = [
        "forehead",
        "nose_bridge",
        "nose_tip",
        "philtrum",
        "lower_lip",
        "chin",
      ];
      const polylinePoints = polylineOrder
        .map((k) => proj[k])
        .filter((p): p is { x: number; y: number } => p !== null);

      if (polylinePoints.length >= 4) {
        ctx.strokeStyle = withAlpha(cyan, 0.55);
        ctx.lineWidth = isMobile ? 1.0 : 1.2;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(polylinePoints[0].x, polylinePoints[0].y);
        for (let i = 1; i < polylinePoints.length; i++) {
          ctx.lineTo(polylinePoints[i].x, polylinePoints[i].y);
        }
        ctx.stroke();
      }

      /* ===== 2) 초록 jaw line (ear_front → chin) ===== */
      if (earProj && proj.chin) {
        ctx.strokeStyle = green;
        ctx.lineWidth = isMobile ? 1.4 : 1.8;
        ctx.shadowColor = green;
        ctx.shadowBlur = isMobile ? 3 : 4;
        ctx.beginPath();
        ctx.moveTo(earProj.x, earProj.y);
        ctx.lineTo(proj.chin.x, proj.chin.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      /* ===== 3) 빨간 분석 삼각형 (forehead → nose_tip → chin) + 점 ===== */
      if (proj.forehead && proj.nose_tip && proj.chin) {
        ctx.strokeStyle = withAlpha(red, 0.8);
        ctx.lineWidth = isMobile ? 1.0 : 1.3;
        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(proj.forehead.x, proj.forehead.y);
        ctx.lineTo(proj.nose_tip.x, proj.nose_tip.y);
        ctx.lineTo(proj.chin.x, proj.chin.y);
        ctx.closePath();
        ctx.stroke();

        ctx.fillStyle = red;
        ctx.shadowColor = red;
        ctx.shadowBlur = isMobile ? 3 : 5;
        const redDotR = isMobile ? 2.5 : 3.5;
        for (const p of [proj.forehead, proj.nose_tip, proj.chin]) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, redDotR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.shadowBlur = 0;
      }

      /* ===== 4) 청록 cross 마커 (모든 in-frame keypoint) ===== */
      ctx.strokeStyle = cyan;
      ctx.lineWidth = isMobile ? 1.5 : 1.8;
      ctx.shadowColor = cyan;
      const baseBlur = isMobile ? 4 : 6;
      const boostedBlur = isMobile ? 6 : 8;
      const crossSize = isMobile ? 4 : 5.5;

      const allCrosses: Array<{
        p: { x: number; y: number };
        blur: number;
      }> = [];
      for (const k of polylineOrder) {
        const p = proj[k];
        if (!p) continue;
        // ear_front 누락 + chin은 한 단계 강조
        const boost = k === "chin" && !earProj;
        allCrosses.push({ p, blur: boost ? boostedBlur : baseBlur });
      }
      if (earProj) allCrosses.push({ p: earProj, blur: baseBlur });

      for (const { p, blur } of allCrosses) {
        ctx.shadowBlur = blur;
        ctx.beginPath();
        ctx.moveTo(p.x - crossSize, p.y);
        ctx.lineTo(p.x + crossSize, p.y);
        ctx.moveTo(p.x, p.y - crossSize);
        ctx.lineTo(p.x, p.y + crossSize);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    void run();

    return () => {
      cancelled = true;
      if (resizeObserver) resizeObserver.disconnect();
    };
    // onLandmarks identity는 부모 setState로 안정 — dep 제외
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mode]);

  const meshVisible =
    state.kind === "ok" ||
    state.kind === "profile-detected" ||
    state.kind === "profile-estimated";
  const headBracketsVisible = state.kind === "head-mapped";
  const scanVisible =
    state.kind === "loading-model" || state.kind === "analyzing";
  const showEstimatedDescription = state.kind === "profile-estimated";

  const altLabel =
    mode === "head" ? "뒷면 두상" : mode === "face" ? "얼굴" : "사진";

  return (
    <figure
      ref={figureRef}
      aria-labelledby={figureId}
      aria-describedby={showEstimatedDescription ? descId : undefined}
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
          alt={altLabel}
          crossOrigin="anonymous"
          className="absolute inset-0 h-full w-full object-contain"
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          No Image
        </div>
      )}

      {/* canvas — face mode mesh */}
      <canvas
        ref={canvasRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 h-full w-full transition-opacity motion-safe:duration-[240ms] motion-safe:ease-out",
          meshVisible ? "opacity-100" : "opacity-0",
        )}
      />

      {/* 분석 중 가로 스캔 라인 */}
      {scanVisible ? <ScanLine /> : null}

      {/* head mode: 4-corner 브래킷 (분석 완료 표시) */}
      {headBracketsVisible ? <HeadBrackets /> : null}

      <span id={figureId} className="sr-only">
        {mode === "head"
          ? "뒷면 두상 분석 오버레이"
          : `얼굴 메쉬 오버레이 (${variant === "readonly" ? "읽기 전용" : "분석"})`}
      </span>

      {showEstimatedDescription ? (
        <span id={descId} className="sr-only">
          측면 각도가 부드러워 합성 가이드로 표시됩니다. 분석 결과는 정상적으로 진행됩니다.
        </span>
      ) : null}

      <StatusBadge state={state} mode={mode} />
    </figure>
  );
}

/* --------------------------- 보조 UI --------------------------- */

function ScanLine() {
  // top:0%→100% 사이를 1.4s 루프. PhotoUploader 라벨 클릭을 가리지 않도록 pointer-events-none.
  // bg는 양 끝이 투명한 가로 그라디언트 + 청록 코어. 위아래 약한 글로우.
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-10 h-[2px]"
      style={{
        animation: "mesh-scan 1.4s linear infinite",
        background:
          "linear-gradient(90deg, transparent 0%, var(--color-tc-accent) 20%, var(--color-tc-accent-hi) 50%, var(--color-tc-accent) 80%, transparent 100%)",
        boxShadow:
          "0 0 12px var(--color-tc-accent-hi), 0 0 28px var(--color-tc-accent)",
      }}
    />
  );
}

function HeadBrackets() {
  // 4개 모서리 브래킷 — 카메라 AF 마커 스타일.
  // 각 브래킷은 두 변(가로/세로)으로 구성. fade-in.
  const armBase =
    "absolute h-5 w-5 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-300";
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-3 z-10"
    >
      {/* top-left */}
      <span className={cn(armBase, "left-0 top-0 border-l-2 border-t-2 border-[color:var(--color-tc-accent-hi)] rounded-tl-md")} />
      {/* top-right */}
      <span className={cn(armBase, "right-0 top-0 border-r-2 border-t-2 border-[color:var(--color-tc-accent-hi)] rounded-tr-md")} />
      {/* bottom-left */}
      <span className={cn(armBase, "left-0 bottom-0 border-l-2 border-b-2 border-[color:var(--color-tc-accent-hi)] rounded-bl-md")} />
      {/* bottom-right */}
      <span className={cn(armBase, "right-0 bottom-0 border-r-2 border-b-2 border-[color:var(--color-tc-accent-hi)] rounded-br-md")} />
    </span>
  );
}

function StatusBadge({ state, mode }: { state: State; mode: Mode }) {
  const base =
    "pointer-events-none absolute right-2 top-2 z-20 inline-flex items-center gap-1.5 rounded-md border border-border/80 bg-[color:var(--color-tc-surface-2)]/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.32em] backdrop-blur-sm";

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
        {mode === "head" ? "Mapping" : "Analyzing"}
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
  if (state.kind === "profile-detected") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-accent-hi)]")}
      >
        {`PROFILE · ${state.pointCount} PTS`}
      </span>
    );
  }
  if (state.kind === "profile-estimated") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-text-soft)]")}
      >
        <span
          aria-hidden
          className="inline-block h-[9px] w-[9px] rounded-[1px] border border-dashed border-current"
          style={{ marginRight: "6px" }}
        />
        PROFILE · ESTIMATED
      </span>
    );
  }
  if (state.kind === "head-mapped") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-accent-hi)]")}
      >
        Profile Mapped
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
