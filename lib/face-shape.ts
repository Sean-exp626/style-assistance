/**
 * 얼굴형 분류기 — 4단계 폴백.
 *
 * 우선순위:
 *  1) 모델이 enum으로 출력한 `face_shape_category` 그대로 사용
 *  2) 자유 텍스트 `face_shape`에서 키워드 매칭 (한국어 + 영어)
 *  3) MediaPipe 478 landmarks 기하학적 비율로 추정
 *  4) 모두 실패 시 null — UI는 "분류 미정"으로 분기
 *
 * 단계 분리 이유:
 *  - 1단계: 모델이 6분류를 안정적으로 내면 가장 정확
 *  - 2단계: 모델이 enum을 누락하더라도 자연어에 보통 카테고리가 들어 있음
 *  - 3단계: 모델 응답이 모호할 때 landmarks가 가장 객관적인 fallback
 *
 * 좌표 인덱스 (FaceLandmarker 478점 기준):
 *  - 234: 왼쪽 광대,  454: 오른쪽 광대  → face_width
 *  - 10:  이마 정점, 152: 턱 끝         → face_length
 *  - 172: 왼쪽 턱,   397: 오른쪽 턱     → jaw_width
 *  - 103: 왼쪽 헤어라인, 332: 오른쪽 헤어라인 → forehead_width
 */
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

import { FACE_SHAPE_CATEGORIES, type FaceShapeCategory } from "./prompts";

export type { FaceShapeCategory };
export { FACE_SHAPE_CATEGORIES };

/* ============================================================
 * Side-profile (측면) landmarks + metrics
 *
 * MediaPipe FaceLandmarker는 정면 학습 모델이라 측면 검출 신뢰도가 낮다.
 * "검출 성공" 여부를 단순 `faces.length === 1`로 판단하면 false-positive가
 * 흔하므로, 사이드 프로파일 분석에 필요한 7개의 sparse keypoint 중
 * **3개 이상이 화면 안에 있고 yaw가 그럴듯할 때만** 검출 성공으로 간주한다.
 *
 * 좌표는 **사진 원본 좌표 그대로** 저장한다. 좌/우 mirror normalization 없음.
 * (UI는 측면 메트릭을 노출하지 않으며, Firestore/Claude만 소비하므로
 *  뒷날 양쪽 yaw를 모아 통계 낼 때 원좌표가 더 유용하다.)
 *
 * MediaPipe FaceLandmarker (478점 모델) 인덱스 매핑:
 *  - NOSE_TIP=1, NOSE_BRIDGE=6, FOREHEAD=10, PHILTRUM=0
 *  - LOWER_LIP=17, CHIN=152, EAR_LEFT=234, EAR_RIGHT=454
 *  - EYE_LEFT=33 (좌측 외안각), EYE_RIGHT=263 (우측 외안각)
 *
 * Yaw 부호 규약: "left" = 피사체가 (보는 사람 기준) 왼쪽으로 고개 돌림.
 * 외안각 dx = lm[EYE_RIGHT].x - lm[EYE_LEFT].x → 오른쪽으로 갈수록 dx 양수.
 * ============================================================ */

export interface SideProfileLandmarks {
  yaw: "left" | "right" | "near-frontal";
  keypoints: Partial<
    Record<
      | "nose_tip"
      | "nose_bridge"
      | "forehead"
      | "philtrum"
      | "lower_lip"
      | "chin"
      | "ear_front",
      [number, number, number]
    >
  >;
}

export interface SideProfileMetrics {
  nasofrontal_angle?: number;
  mentolabial_angle?: number;
  facial_convexity?: number;
  jaw_angle?: number;
}

export const SIDE_KEYPOINT_NAMES = [
  "nose_tip",
  "nose_bridge",
  "forehead",
  "philtrum",
  "lower_lip",
  "chin",
  "ear_front",
] as const;

export type SideKeypointName = (typeof SIDE_KEYPOINT_NAMES)[number];

/* MediaPipe FaceLandmarker 478점 모델 인덱스 */
const NOSE_TIP = 1;
const NOSE_BRIDGE = 6;
const FOREHEAD = 10;
const PHILTRUM = 0;
const LOWER_LIP = 17;
const CHIN = 152;
const EAR_LEFT = 234;
const EAR_RIGHT = 454;
const EYE_LEFT = 33;
const EYE_RIGHT = 263;

/** MediaPipe NormalizedLandmark 좌표가 이미지 frame 안에 있는지(±5% 여유). */
function inFrame(p: NormalizedLandmark): boolean {
  return p.x >= -0.05 && p.x <= 1.05 && p.y >= -0.05 && p.y <= 1.05;
}

function asTriplet(p: NormalizedLandmark): [number, number, number] {
  return [p.x, p.y, p.z];
}

/**
 * MediaPipe 478개 NormalizedLandmark에서 측면 sparse keypoint를 뽑는다.
 *
 * 반환 규칙:
 *  - landmark 배열이 478점 미만이면 즉시 `null`
 *  - 7개 후보 중 frame 밖이 3개 이상이면 `null` (검출 신뢰도 낮음)
 *  - yaw가 near-frontal로 분류되면 `null`
 *  - 그 외에는 frame 안에 있는 keypoint만 담긴 객체 반환
 *    (값 좌표는 raw `[x,y,z]` — 정규화/미러 없음)
 */
export function extractSideProfileLandmarks(
  rawLm: NormalizedLandmark[],
): SideProfileLandmarks | null {
  if (!rawLm || rawLm.length < 478) return null;

  const candidates: Partial<Record<SideKeypointName, NormalizedLandmark>> = {
    nose_tip: rawLm[NOSE_TIP],
    nose_bridge: rawLm[NOSE_BRIDGE],
    forehead: rawLm[FOREHEAD],
    philtrum: rawLm[PHILTRUM],
    lower_lip: rawLm[LOWER_LIP],
    chin: rawLm[CHIN],
  };

  // yaw classification — 외안각 두 점이 모두 있어야 추정 가능
  const eyeL = rawLm[EYE_LEFT];
  const eyeR = rawLm[EYE_RIGHT];
  if (!eyeL || !eyeR) return null;
  const dx = eyeR.x - eyeL.x;

  // ear 후보: in-frame인 쪽을 사용. 둘 다 in-frame이면 "yaw 반대편" 귀를 선택
  const earL = rawLm[EAR_LEFT];
  const earR = rawLm[EAR_RIGHT];
  const earLIn = earL ? inFrame(earL) : false;
  const earRIn = earR ? inFrame(earR) : false;

  let earChoice: NormalizedLandmark | undefined;
  // dx > 0 → yaw "left" → 보이는 귀는 ear_right
  // dx < 0 → yaw "right" → 보이는 귀는 ear_left
  if (earLIn && earRIn) {
    earChoice = dx > 0 ? earR : earL;
  } else if (earLIn) {
    earChoice = earL;
  } else if (earRIn) {
    earChoice = earR;
  } else {
    earChoice = undefined;
  }
  if (earChoice) candidates.ear_front = earChoice;

  // out-of-frame 카운트
  const all: Array<[SideKeypointName, NormalizedLandmark | undefined]> = [
    ["nose_tip", candidates.nose_tip],
    ["nose_bridge", candidates.nose_bridge],
    ["forehead", candidates.forehead],
    ["philtrum", candidates.philtrum],
    ["lower_lip", candidates.lower_lip],
    ["chin", candidates.chin],
    ["ear_front", candidates.ear_front],
  ];
  let outOfFrame = 0;
  for (const [, p] of all) {
    if (!p || !inFrame(p)) outOfFrame += 1;
  }
  if (outOfFrame >= 3) return null;

  // bbox width — 7개 keypoint 중 in-frame인 것들의 x 범위
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [, p] of all) {
    if (!p || !inFrame(p)) continue;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }
  const faceWidth = maxX - minX;
  if (!Number.isFinite(faceWidth) || faceWidth <= 1e-6) return null;

  const ratio = Math.abs(dx) / faceWidth;
  if (ratio < 0.18) return null; // near-frontal — 측면이 아님

  const yaw: "left" | "right" = dx > 0 ? "left" : "right";

  // keypoints 결과 — frame 안에 있는 것만 raw 좌표로 채운다
  const keypoints: SideProfileLandmarks["keypoints"] = {};
  for (const [name, p] of all) {
    if (!p || !inFrame(p)) continue;
    keypoints[name] = asTriplet(p);
  }

  return { yaw, keypoints };
}

/**
 * `b`에서 두 점 `a`, `c`로 이어진 선분이 이루는 각도(degree).
 * 2D만 사용 (z는 측면 사진에서 신뢰도 낮음).
 */
function angleBetween(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): number {
  const v1x = a[0] - b[0];
  const v1y = a[1] - b[1];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const angle1 = Math.atan2(v1y, v1x);
  const angle2 = Math.atan2(v2y, v2x);
  let diff = Math.abs(angle1 - angle2);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  return (diff * 180) / Math.PI;
}

function isFiniteAngle(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 180;
}

/**
 * 측면 프로파일에서 4가지 미용 분석 각도를 계산한다.
 * - 누락된 keypoint가 있는 메트릭은 `undefined`로 떨어진다.
 * - 결과 값이 NaN이거나 [0,180] 범위를 벗어나면 해당 필드 제거.
 */
export function computeSideProfileMetrics(
  slm: SideProfileLandmarks,
): SideProfileMetrics {
  const kp = slm.keypoints;
  const out: SideProfileMetrics = {};

  // nasofrontal_angle: 이마 — 코 다리 — 코끝
  if (kp.forehead && kp.nose_bridge && kp.nose_tip) {
    const v = angleBetween(kp.forehead, kp.nose_bridge, kp.nose_tip);
    if (isFiniteAngle(v)) out.nasofrontal_angle = v;
  }

  // mentolabial_angle: 인중 — 아랫입술 — 턱끝
  if (kp.philtrum && kp.lower_lip && kp.chin) {
    const v = angleBetween(kp.philtrum, kp.lower_lip, kp.chin);
    if (isFiniteAngle(v)) out.mentolabial_angle = v;
  }

  // facial_convexity: 이마 — 코끝 — 턱끝
  if (kp.forehead && kp.nose_tip && kp.chin) {
    const v = angleBetween(kp.forehead, kp.nose_tip, kp.chin);
    if (isFiniteAngle(v)) out.facial_convexity = v;
  }

  // jaw_angle: chin - ear_front 벡터와 수직축(아래 방향)의 각도
  if (kp.ear_front && kp.chin) {
    const dxv = kp.chin[0] - kp.ear_front[0];
    const dyv = kp.chin[1] - kp.ear_front[1];
    // 0 = 수직 아래(↓), 90 = 수평
    const rad = Math.atan2(Math.abs(dxv), Math.abs(dyv));
    const deg = (rad * 180) / Math.PI;
    if (isFiniteAngle(deg)) out.jaw_angle = deg;
  }

  return out;
}

interface ClassifyInput {
  face_shape_category?: string;
  face_shape: string;
}

export function classifyFaceShape(
  result: ClassifyInput,
  landmarks: number[][] | null,
): FaceShapeCategory | null {
  // 1단계 — 모델 enum
  if (
    result.face_shape_category &&
    (FACE_SHAPE_CATEGORIES as readonly string[]).includes(
      result.face_shape_category,
    )
  ) {
    return result.face_shape_category as FaceShapeCategory;
  }

  // 2단계 — 자유 텍스트 키워드
  const t = result.face_shape ?? "";
  if (/계란|달걀|oval/i.test(t)) return "계란형";
  if (/마름모|diamond/i.test(t)) return "마름모형";
  if (/하트|heart|역삼각/i.test(t)) return "하트형";
  if (/땅콩|peanut|모래시계|hourglass/i.test(t)) return "땅콩형";
  if (/육각|hexagon/i.test(t)) return "육각형";
  if (/둥근|round|동그란/i.test(t)) return "둥근형";

  // 3단계 — landmarks 기하학적 비율
  if (landmarks && landmarks.length >= 478) {
    const lm = landmarks;
    const dx = (a: number, b: number) => Math.abs(lm[a][0] - lm[b][0]);
    const dy = (a: number, b: number) => Math.abs(lm[a][1] - lm[b][1]);

    const face_width = dx(234, 454);
    const face_length = dy(10, 152);
    const jaw_width = dx(172, 397);
    const forehead_width = dx(103, 332);

    if (face_width < 1e-6) return null;
    const ratio_lw = face_length / face_width;

    if (ratio_lw > 1.5 && jaw_width < forehead_width) return "하트형";
    if (ratio_lw > 1.4 && Math.abs(jaw_width - forehead_width) < 0.05)
      return "계란형";
    if (ratio_lw < 1.15) return "둥근형";
    if (
      face_width > jaw_width + 0.04 &&
      face_width > forehead_width + 0.04 &&
      Math.abs(jaw_width - forehead_width) < 0.04
    )
      return "마름모형";
    if (jaw_width + forehead_width > face_width) return "육각형";
    return "땅콩형";
  }

  // 4단계 — 모두 실패
  return null;
}
