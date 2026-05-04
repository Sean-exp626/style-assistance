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
import { FACE_SHAPE_CATEGORIES, type FaceShapeCategory } from "./prompts";

export type { FaceShapeCategory };
export { FACE_SHAPE_CATEGORIES };

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
