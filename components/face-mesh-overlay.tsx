"use client";

/**
 * FaceMeshOverlay — 사진 위 분석 시각화 오버레이.
 *
 * 세 가지 모드:
 *  - mode="face" (default, 정면): MediaPipe FaceLandmarker로 얼굴 메쉬 검출
 *    - 478 landmarks tessellation을 토큰 색상으로 그림
 *    - 결과를 `onLandmarks`로 전달
 *  - mode="profile" (측면): **MediaPipe 호출 없음.** Claude Vision이 단일 소스.
 *    - 부모로부터 `serverKeypoints`(Claude 응답의 `side_keypoints`)를 받아 그린다.
 *    - 정의된 키포인트가 ≥3개면 sparse polyline + cross + jaw line + triangle 시각화
 *    - <3개거나 null이면 "NO PROFILE DETECTED" 배지 + 빈 캔버스 (합성 폴백 없음)
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

import { cn } from "@/lib/utils";
import type { FaceBbox, SideKeypoints } from "@/lib/prompts";

import type {
  FaceLandmarker as FaceLandmarkerType,
  FaceLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

/** V1 측면 키포인트 7개 이름. SYSTEM_PROMPT/Claude 응답과 1:1. */
type SideKeypointName =
  | "forehead"
  | "nose_bridge"
  | "nose_tip"
  | "philtrum"
  | "lower_lip"
  | "chin"
  | "ear_front";

/** profile 모드에서 부모가 내려주는 서버 측 키포인트 — bbox 내부 [0,1] 상대 좌표 */
type ServerKeypoints = NonNullable<SideKeypoints> | null | undefined;
/** 얼굴 영역 bounding box (원본 사진 기준 [0,1] 정규화). null 이면 전체 이미지로 fallback. */
type ServerFaceBbox = NonNullable<FaceBbox> | null | undefined;

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
  | { kind: "ok"; faces: number }                          // face mode 성공 (실제 landmarks)
  | { kind: "profile-detected"; pointCount: number }       // profile mode 검출 성공 (Claude ≥3)
  | { kind: "profile-no-detection" }                       // profile mode: Claude null/<3
  | { kind: "head-mapped" }                                // head mode 성공
  | { kind: "no-face" }
  | { kind: "multi-face"; count: number }
  | { kind: "error"; message: string };

interface FaceMeshOverlayProps {
  source: string | null;
  onLandmarks?: (lm: number[][] | null) => void;
  /**
   * profile 모드 단일 소스 — Claude Vision이 반환한 7개 측면 키포인트.
   * - `null` 또는 정의된 키 < 3개 → "NO PROFILE DETECTED" 상태로 폴백
   * - 정의된 키 ≥ 3개 → sparse overlay 렌더
   * - 각 좌표는 원본 사진 기준 정규화 [0,1] (x: 좌→우, y: 상→하)
   */
  serverKeypoints?: ServerKeypoints;
  /**
   * profile 모드 — Claude Vision이 반환한 얼굴 axis-aligned bbox.
   * `serverKeypoints`의 좌표는 이 bbox 내부 상대 [0,1]. bbox 가 null/undefined 이면
   * 좌표를 원본 이미지 전체 [0,1] 로 해석 (backward compat).
   */
  serverFaceBbox?: ServerFaceBbox;
  variant?: Variant;
  mode?: Mode;
  className?: string;
}

const ENABLED = process.env.NEXT_PUBLIC_ENABLE_FACE_MESH !== "false";

/* --------------------------- 컴포넌트 --------------------------- */

export function FaceMeshOverlay({
  source,
  onLandmarks,
  serverKeypoints,
  serverFaceBbox,
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
    let profileAnalyzingTimer: ReturnType<typeof setTimeout> | null = null;

    if (!source || !ENABLED) {
      onLandmarks?.(null);
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

    /* ============= profile mode (측면) — Claude Vision 단일 소스 =============
     *
     * V1: MediaPipe 측면 검출은 사용하지 않는다 (478-mesh 모델은 strict 90° profile
     * 입력에서 빈 결과를 자주 반환). 대신 부모 `serverKeypoints` prop으로 받은
     * Claude 응답을 그대로 시각화한다.
     *
     *  - <3 정의된 키 OR null → "NO PROFILE DETECTED" 상태 (합성 오버레이 없음)
     *  - ≥3 정의된 키 → drawProfileSparse(serverKeypoints) 로 시각화
     */
    if (mode === "profile") {
      onLandmarks?.(null);

      async function runProfile() {
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

        // face mode와의 시각적 연속성을 위해 짧은 analyzing 페이즈
        setState({ kind: "analyzing" });
        profileAnalyzingTimer = setTimeout(() => {
          if (cancelled) return;

          const kp = serverKeypoints ?? null;
          const definedCount = kp ? countDefinedKeypoints(kp) : 0;

          if (!kp || definedCount < 3) {
            setState({ kind: "profile-no-detection" });
            clearCanvas();
            return;
          }

          setState({ kind: "profile-detected", pointCount: definedCount });

          const bbox = serverFaceBbox ?? null;
          const drawSide = () => {
            if (cancelled) return;
            drawProfileSparse(kp, bbox);
          };
          drawSide();
          if (figureRef.current && typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(drawSide);
            resizeObserver.observe(figureRef.current);
          }
        }, 250);
      }
      void runProfile();

      return () => {
        cancelled = true;
        if (profileAnalyzingTimer) clearTimeout(profileAnalyzingTimer);
        if (resizeObserver) resizeObserver.disconnect();
      };
    }

    /* ============= face mode (정면) — MediaPipe 478점 mesh ============= */
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
        setState({ kind: "error", message: "검출 모델 실패" });
        onLandmarks?.(null);
        return;
      }
      if (cancelled) return;

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

      // 478점 mesh 시각화
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
     * 측면 sparse overlay — Claude Vision이 반환한 7개 keypoint를 polyline + cross로 시각화.
     *
     * V1 입력: `ServerKeypoints` (정규화 [0,1] 좌표). MediaPipe 인덱스를 사용하지 않는다.
     *
     * 레이어 구성:
     *  1) 청록 polyline (forehead → nose_bridge → nose_tip → philtrum → lower_lip → chin)
     *  2) 초록 jaw line (ear_front → chin) — ear_front 누락시 생략 + chin glow boost
     *  3) 빨간 분석 삼각형 (forehead → nose_tip → chin) + 빨간 점
     *  4) 청록 cross 마커 (정의된 모든 keypoint)
     */
    function drawProfileSparse(
      kp: NonNullable<SideKeypoints>,
      bbox: NonNullable<FaceBbox> | null,
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

      // V2 hybrid 대비: [x,y,z] 튜플도 들어올 수 있도록 양쪽 형태 모두 지원.
      const readXY = (
        v: { x: number; y: number } | [number, number, number] | undefined,
      ): { x: number; y: number } | undefined => {
        if (!v) return undefined;
        if (Array.isArray(v)) return { x: v[0], y: v[1] };
        return { x: v.x, y: v.y };
      };

      // bbox 가 유효하면 keypoint(bbox-relative) → 이미지 정규화 좌표로 합성.
      // bbox 없으면 keypoint 를 이미지 정규화로 그대로 해석 (backward compat).
      const bboxValid =
        !!bbox &&
        Number.isFinite(bbox.x_min) &&
        Number.isFinite(bbox.y_min) &&
        Number.isFinite(bbox.x_max) &&
        Number.isFinite(bbox.y_max) &&
        bbox.x_max > bbox.x_min &&
        bbox.y_max > bbox.y_min;
      const bboxW = bboxValid ? bbox!.x_max - bbox!.x_min : 1;
      const bboxH = bboxValid ? bbox!.y_max - bbox!.y_min : 1;
      const bboxX = bboxValid ? bbox!.x_min : 0;
      const bboxY = bboxValid ? bbox!.y_min : 0;
      const toImageNorm = (p: { x: number; y: number }) => ({
        x: bboxX + p.x * bboxW,
        y: bboxY + p.y * bboxH,
      });
      const project = (p: { x: number; y: number }) => {
        const img = toImageNorm(p);
        return {
          x: offsetX + img.x * renderW,
          y: offsetY + img.y * renderH,
        };
      };

      const projectName = (name: SideKeypointName) => {
        const xy = readXY(kp[name]);
        return xy ? project(xy) : null;
      };

      const proj = {
        forehead: projectName("forehead"),
        nose_bridge: projectName("nose_bridge"),
        nose_tip: projectName("nose_tip"),
        philtrum: projectName("philtrum"),
        lower_lip: projectName("lower_lip"),
        chin: projectName("chin"),
      } as const;
      const earProj = projectName("ear_front");

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
    // onLandmarks identity는 부모 setState로 안정 — dep 제외.
    // serverKeypoints/serverFaceBbox는 부모 result 문서 단위로만 바뀌어 inline 객체 ref 안정.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, mode, serverKeypoints, serverFaceBbox]);

  const meshVisible =
    state.kind === "ok" || state.kind === "profile-detected";
  const headBracketsVisible = state.kind === "head-mapped";
  const scanVisible =
    state.kind === "loading-model" || state.kind === "analyzing";
  const showNoDetectionDescription = state.kind === "profile-no-detection";

  const altLabel =
    mode === "head" ? "뒷면 두상" : mode === "face" ? "얼굴" : "사진";

  return (
    <figure
      ref={figureRef}
      aria-labelledby={figureId}
      aria-describedby={showNoDetectionDescription ? descId : undefined}
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

      {showNoDetectionDescription ? (
        <span id={descId} className="sr-only">
          측면 프로파일을 자동으로 인식하지 못했습니다. 분석 결과는 정상적으로 진행됩니다.
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
  if (state.kind === "profile-no-detection") {
    return (
      <span
        role="status"
        aria-live="polite"
        className={cn(base, "text-[color:var(--color-tc-text-muted)]")}
      >
        NO PROFILE DETECTED
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

/**
 * `serverKeypoints`에서 정의된(=undefined 아님) 키 수를 센다.
 * V1 임계: ≥3이면 detected, 미만이면 no-detection.
 */
function countDefinedKeypoints(kp: NonNullable<SideKeypoints>): number {
  let n = 0;
  for (const name of [
    "forehead",
    "nose_bridge",
    "nose_tip",
    "philtrum",
    "lower_lip",
    "chin",
    "ear_front",
  ] as const satisfies readonly SideKeypointName[]) {
    if (kp[name] !== undefined) n += 1;
  }
  return n;
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
