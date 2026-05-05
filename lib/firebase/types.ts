/**
 * Firestore 도메인 타입.
 *
 * 책임:
 *  - `hairAnalyses` 컬렉션의 단일 문서 형태를 명세한다.
 *  - 서버(write)와 클라이언트(read)가 같은 타입을 공유해 스키마 드리프트를 방지한다.
 *
 * 주의:
 *  - 이 모듈은 firebase-admin이 아니라 firebase(client/admin 모두에서 사용 가능한)
 *    Timestamp/FieldValue 타입을 import한다 — runtime 의존이 아니라 타입 전용.
 *  - 실제 write 시 `createdAt`은 Admin SDK의 `FieldValue.serverTimestamp()`를 사용한다
 *    (서버 시간 기준 정합성). 따라서 Input 타입에서는 FieldValue를 허용한다.
 */
import type { FieldValue, Timestamp } from "firebase-admin/firestore";

import type {
  SideProfileLandmarks,
  SideProfileMetrics,
} from "@/lib/face-shape";
import type { Gender, LengthPreference } from "@/lib/prompts";
import type { ReferenceImage } from "@/lib/search";

/** 분석 결과(도메인 응답) — `lib/prompts.ts`의 AnalysisResult와 동일 형태를 직접 명세 */
export interface AnalysisResultDoc {
  face_shape: string;
  /**
   * 6분류 enum 라벨. 모델이 보내지 않거나 인식 못한 값일 수 있어 string으로 느슨하게.
   * 실제 enum 보장은 `AnalysisResultSchema.face_shape_category`에서.
   */
  face_shape_category?: string;
  head_shape: string;
  recommended_style: {
    name: string;
    length: string;
    key_features: string[];
  };
  professional_analysis: string;
  search_keywords: string[];
  /**
   * 측면 프로파일 4각도 — 측면 사진이 제공된 경우에만 모델이 채울 수 있는 선택 필드.
   * 단위는 도(°), 0~180 범위. 모든 자연어 필드에는 숫자/도 표기 없음.
   */
  head_shape_metrics?: {
    nasofrontal_angle?: number;
    mentolabial_angle?: number;
    facial_convexity?: number;
    jaw_angle?: number;
  };
  /**
   * 측면 키포인트 (V1: Claude Vision 단일 소스).
   * - 원본 사진 기준 정규화 [0,1] 좌표 (x: 좌→우, y: 상→하).
   * - 모델이 3개 이상 자신 있게 짚으면 객체, 그 외엔 `null`.
   * - 부분 객체 OK (모든 키 optional) — UI는 ≥3개 정의된 키일 때만 overlay 표시.
   */
  side_keypoints?: {
    forehead?: { x: number; y: number };
    nose_bridge?: { x: number; y: number };
    nose_tip?: { x: number; y: number };
    philtrum?: { x: number; y: number };
    lower_lip?: { x: number; y: number };
    chin?: { x: number; y: number };
    ear_front?: { x: number; y: number };
  } | null;
}

/** 사진 view 라벨 (한국어 — 사람이 읽기 좋도록 한국어로 저장) */
export type ProvidedView = "정면" | "측면" | "뒷면";

/**
 * `hairAnalyses/{analysisId}` 단일 문서.
 *
 * - `id`는 Firestore 문서 ID (자동 생성). read 시 docSnap.id로 채워서 반환한다.
 * - `references`는 분석 직후에는 빈 배열로 저장되고, `/api/references`가 비동기로 update한다.
 */
export interface HairAnalysisDoc {
  id: string;
  uid: string;
  userEmail: string | null;
  userDisplayName: string | null;
  userPhotoURL: string | null;
  /** Firestore serverTimestamp(). 정렬 인덱스의 키. */
  createdAt: Timestamp;
  /** 분석에 걸린 시간(ms). 운영 모니터링용. */
  durationMs: number;
  gender: Gender;
  lengthPreference: LengthPreference;
  providedViews: ProvidedView[];
  result: AnalysisResultDoc;
  references: ReferenceImage[];
  /**
   * 정면 사진의 MediaPipe FaceLandmarker 478개 정규화 좌표 [x, y, z][].
   *
   * - 분석 시점에 클라이언트에서 추출, 서버는 검증 후 그대로 저장
   * - 사후 분류기/시각화 재현용 — 분석 직후뿐 아니라 history 모달에서도 재사용
   */
  frontLandmarks?: number[][];
  /**
   * 측면 사진의 sparse keypoint(최대 7개) — yaw 분류 + 원좌표 [x,y,z].
   *
   * - 클라이언트에서 검출 성공시에만 동봉
   * - 좌/우 mirror normalization 없음 — 사후 통계용 원좌표 그대로 저장
   * - UI에는 노출하지 않는다 (백엔드/Firestore only)
   */
  sideLandmarks?: SideProfileLandmarks;
  /**
   * 측면 4각도 메트릭 (도 단위, 0~180). 검출 성공시에만 동봉.
   * 일부 필드만 채워질 수 있다(예: ear_front 미검출 시 jaw_angle 없음).
   */
  sideMetrics?: SideProfileMetrics;
}

/**
 * write 시점에 사용하는 입력 형태.
 *
 * - `id`는 Firestore가 부여하므로 제외.
 * - `createdAt`은 Admin SDK의 `FieldValue.serverTimestamp()`를 그대로 set할 수 있도록
 *   FieldValue를 허용한다.
 */
export type HairAnalysisDocInput = Omit<HairAnalysisDoc, "id" | "createdAt"> & {
  createdAt: FieldValue;
};
