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
