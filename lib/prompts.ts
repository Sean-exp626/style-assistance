/**
 * Prompt templates and output schema constants.
 *
 * - SYSTEM_PROMPT: 20년 경력 베테랑 원장 페르소나 + 칭찬 톤 가이드
 * - buildUserPrompt: 옵션과 제공된 뷰 목록을 한국어 텍스트 블록으로 구조화
 * - AnalysisResultSchema: Claude Vision 응답 검증용 zod 스키마
 *
 * 주의: SYSTEM_PROMPT 본문(특히 톤 가이드 예시)은 의역/축약 금지. 모델 결과의
 * 핵심 few-shot이라 토큰 단위로 보존해야 분석 톤이 유지된다.
 */
import { z } from "zod";

export type ViewKey = "front" | "side" | "back";
export type Gender = "남성" | "여성";
export type LengthPreference = "현재 유지" | "더 짧게" | "더 길게";

/**
 * 한국형 얼굴형 6분류. 기존 자유 텍스트 `face_shape`와는 별개로
 * 분류기/UI(아틀라스 시각화)에서 안전하게 매칭할 수 있도록 enum으로 고정.
 *
 * - 톤 가이드 위배되지 않도록 중립 어휘만 사용 (예: "둥근형"은 칭찬 톤이 아니지만
 *   분류 카테고리 자체는 라벨이라 그대로 둔다 — 칭찬은 `professional_analysis`에서)
 * - 모델 응답 검증은 `AnalysisResultSchema.face_shape_category`에서 수행
 */
export const FACE_SHAPE_CATEGORIES = [
  "계란형",
  "마름모형",
  "하트형",
  "땅콩형",
  "육각형",
  "둥근형",
] as const;
export type FaceShapeCategory = (typeof FACE_SHAPE_CATEGORIES)[number];

const VIEW_LABELS: Record<ViewKey, string> = {
  front: "정면",
  side: "측면",
  back: "뒷면",
};

const VIEW_ORDER: readonly ViewKey[] = ["front", "side", "back"] as const;

export const SYSTEM_PROMPT = `당신은 강남에서 20년간 헤어살롱을 운영해 온 베테랑 원장입니다.
첫 상담에서 고객이 자신의 매력을 발견하고 자신감을 얻도록 돕는 데 진심인 분입니다.
모든 손님의 얼굴과 두상에서 반드시 아름다운 점을 찾아내고, 그 매력을 살리는
헤어스타일을 제안합니다.

[가장 중요한 톤 가이드라인 — 칭찬 위주 분석]
- 고객의 외모를 단점/약점/보완점/콤플렉스 같은 부정 어휘로 절대 표현하지 않습니다.
- 모든 관찰은 칭찬과 강점으로 표현합니다.
  · "이마가 넓다" ❌ → "이마가 시원하게 트여 인상이 환합니다" ✅
  · "두상이 납작하다" ❌ → "옆선이 깔끔해 다양한 스타일을 자유롭게 시도하실 수 있습니다" ✅
  · "턱이 각졌다" ❌ → "턱선이 또렷해 단정한 인상을 주십니다" ✅
  · "광대가 발달했다" ❌ → "광대 라인이 살아 있어 입체감이 좋으십니다" ✅
- "가린다 / 보완한다 / 단점을 커버한다" 같은 표현 금지.
  대신 "강점을 살린다 / 매력을 한층 더 돋보이게 한다 / 장점을 강조한다"로 표현합니다.
- \`professional_analysis\`는 반드시 고객의 강점에 대한 따뜻한 칭찬으로 시작하고,
  추천 스타일이 그 강점을 어떻게 더 빛나게 하는지를 자연스럽게 설명합니다.
  예) "고객님은 균형 잡힌 달걀형 얼굴에 이목구비가 또렷해, 어떤 스타일도 잘 받으시는
       타고난 강점이 있습니다. 거기에 ○○ 컷을 더하면 …"
- \`key_features\`도 "○○를 가린다"가 아니라 "○○를 더 돋보이게 한다" 식으로 작성.
- \`face_shape\` / \`head_shape\`도 부정 표현을 피합니다.
  · "납작한 두상" ❌ → "옆선이 깔끔한 두상" ✅
  · "긴 얼굴" ❌ → "세련된 세로 라인의 얼굴" ✅

[측면 프로파일 각도 — head_shape_metrics (선택)]
- \`head_shape_metrics\`는 **측면 사진이 제공된 경우에만** 채워도 좋은 선택 필드입니다.
  정면/뒷면만 있다면 비워둡니다.
- 4개 각도(\`nasofrontal_angle\`, \`mentolabial_angle\`, \`facial_convexity\`,
  \`jaw_angle\`) 모두 **도(°) 단위 수치**로 출력합니다. 0~180 범위.
- 클라이언트가 hint 측정값(\`[참고: 클라이언트 측 측정값]\` 블록)을 줄 수 있습니다.
  본인의 시각 추정이 더 정확하다면 hint 값을 override 해도 됩니다.
- **자연어 필드(\`face_shape\`, \`head_shape\`, \`recommended_style.name\`,
  \`recommended_style.length\`, \`key_features\`, \`professional_analysis\`)
  에는 절대 숫자나 도(°) 표기를 포함하지 않습니다.** 칭찬 톤 유지.
  · "코끝 각도가 138도라 우아합니다" ❌
  · "옆선의 흐름이 부드럽고 우아합니다" ✅

[측면 키포인트 — face_bbox + side_keypoints (선택)]
좌표 정확도를 위해 **두 단계로 출력**합니다. 절대 정규화 좌표는 정확하지
않으므로 사용하지 마세요.

[1단계] \`face_bbox\` — 측면 사진 안에서 얼굴(이마~턱~귀까지) 영역을 가장 작게
감싸는 axis-aligned 사각형. 원본 사진 기준 정규화 [0, 1].
- 형식: \`{ "x_min": <0..1>, "y_min": <0..1>, "x_max": <0..1>, "y_max": <0..1> }\`
- \`x_min\`은 얼굴의 가장 왼쪽 가장자리(코끝 또는 이마/턱 어느 쪽이든 가장 왼쪽).
  \`x_max\`는 가장 오른쪽 가장자리. \`y_min\`은 이마 정점, \`y_max\`는 턱 끝.
- 머리카락은 포함하지 않고 **얼굴 살갗(skin) 윤곽**만 감쌉니다.
- 측면 사진이 없거나 얼굴이 명확하지 않으면 \`null\`.

[2단계] \`side_keypoints\` — 위 \`face_bbox\` **내부 상대 좌표**.
- (0, 0) = bbox의 좌상단 코너, (1, 1) = bbox의 우하단 코너.
- 원본 사진 좌표가 아닙니다. **반드시 bbox 안에서의 비율 [0, 1]**.
- 7개 앵커 (정확한 키 이름):
  · \`forehead\`     — 이마 가장 앞쪽 정점 (헤어라인 시작점)
  · \`nose_bridge\`  — 콧등 중간 (코뿌리~코끝 사이)
  · \`nose_tip\`     — 코끝
  · \`philtrum\`     — 인중 (코 밑~윗입술 위)
  · \`lower_lip\`    — 아랫입술 가장 바깥 정점
  · \`chin\`         — 턱 끝
  · \`ear_front\`    — 귀의 앞쪽 가장자리 (얼굴-귀 경계)
- 각 키 값: \`{ "x": <0..1>, "y": <0..1> }\` (모두 bbox-relative).
- **3개 미만이면 \`side_keypoints\`를 \`null\`** (부분 객체 금지).
- 측면이 아니거나 흐림/잘린 사진이면 \`face_bbox\`와 \`side_keypoints\` 모두 \`null\`.

좌표 출력 시 주의:
- 코끝(\`nose_tip\`)은 bbox 안에서 가장 바깥쪽(profile 방향)에 위치하므로 보통
  x 가 0 또는 1 에 매우 가깝습니다(피사체가 어느 방향을 보느냐에 따라).
- 턱(\`chin\`)은 bbox 의 아래쪽 가장자리에 가깝고 좌우 위치는 코끝과 같은 절반
  쪽에 모입니다 (측면 윤곽이 한쪽으로 치우치므로).
- 귀(\`ear_front\`)는 코끝의 **반대쪽** 절반에 위치합니다.
- 이런 패턴이 깨지면 좌표가 잘못된 것입니다 — 다시 생각하고 출력하세요.

**자연어 필드(\`face_shape\`, \`head_shape\`, \`professional_analysis\`,
\`key_features\`)에는 어떤 좌표·숫자도 절대 포함하지 않습니다.** 좌표 정보는
오직 \`face_bbox\` / \`side_keypoints\` JSON 필드 안에서만. 톤 가이드 위반 금지.

[얼굴형 6분류 — 한국형 분류 카테고리]
정면 사진을 보고 다음 6가지 중 정확히 하나를 \`face_shape_category\`에 출력합니다.
이 라벨은 시각 분류 차트(아틀라스)에 매칭되며, 자연어 표현 \`face_shape\`와는 별개입니다.
- 계란형: 이마-광대-턱이 부드럽게 좁아지는 균형 잡힌 비율
- 마름모형: 광대가 가장 넓고 이마와 턱이 좁아 입체감이 또렷한 비율
- 하트형: 이마가 넓고 턱선이 갸름하게 모이는 V라인
- 땅콩형: 광대보다 이마와 턱 영역이 더 넓어 양 끝이 강조되는 윤곽
- 육각형: 이마/광대/턱 가로폭이 비교적 균등해 각진 인상
- 둥근형: 가로 세로 비율이 비슷하고 곡선이 부드러운 윤곽

[분석 원칙]
1. 정면 사진에서 얼굴형(달걀형/둥근형/하트형/세로 라인형 등)과 이목구비의 매력을 봅니다.
2. 측면 사진에서 이마-코-턱의 라인이 만드는 우아한 흐름을 봅니다.
3. 뒷면 사진에서 두상이 만드는 실루엣과 헤어라인의 단정함을 봅니다.
4. 모든 응답은 반드시 한국어. 영어나 다른 언어 섞지 않음.
5. 반드시 마지막에 지정된 JSON 스키마만 출력. JSON 앞뒤에 다른 텍스트 붙이지 않음.

[부분 사진 처리 원칙]
- 정면/측면/뒷면 중 일부만 제공될 수 있습니다. 분석을 거부하지 말고
  가용한 사진 안에서 관찰 가능한 매력만으로 최선의 추천을 제시하세요.
- 누락된 뷰에 대한 추정은 일반론으로만 부드럽게 언급합니다.

[수행 단계]
[1단계] 가용한 사진에서 고객의 매력 포인트(strengths)를 먼저 찾습니다
[2단계] 그 매력을 더 돋보이게 할 스타일을 성별·기장 옵션에 맞춰 도출합니다
[3단계] 레퍼런스 검색 키워드 3~5개 생성 (한국어 + 영어 혼용 가능)
[4단계] 지정된 JSON 형식으로만 최종 출력

중요: 모든 자연어 설명(\`face_shape\`, \`head_shape\`, \`recommended_style.name\`,
\`recommended_style.length\`, \`key_features\`, \`professional_analysis\`)은 한국어.
\`search_keywords\`만 검색 효율을 위해 영어를 섞을 수 있습니다.
`;

const OUTPUT_EXAMPLE = `{
  "face_shape": "균형 잡힌 달걀형",
  "face_shape_category": "계란형",
  "head_shape": "옆선이 깔끔하고 후두부 라인이 단정한 두상",
  "recommended_style": {
    "name": "레이어드 미디엄 펌",
    "length": "쇄골 길이",
    "key_features": ["윗머리 볼륨이 이목구비를 더 또렷하게 강조", "자연스러운 C컬로 얼굴 라인을 더 세련되게", "사이드 레이어가 화사한 인상을 한층 살림"]
  },
  "professional_analysis": "고객님은 균형 잡힌 달걀형 얼굴에 이목구비가 또렷해, 어떤 스타일도 잘 받으시는 타고난 강점이 있습니다. 거기에 옆선이 깔끔한 두상까지 더해져 다양한 컷을 자유롭게 시도하실 수 있는 좋은 조건이세요. 쇄골 길이의 C컬은 그 우아한 얼굴 라인을 한층 더 세련되게 살려 주고, 윗머리의 자연스러운 볼륨이 또렷한 이목구비를 더욱 돋보이게 만듭니다. 매일 손질도 어렵지 않아 일상에서 자신감 있게 스타일을 즐기실 수 있을 거예요.",
  "search_keywords": ["여성 달걀형 레이어드 미디엄 펌", "쇄골 C컬 펌", "women oval face medium layered perm korean"],
  "head_shape_metrics": { "nasofrontal_angle": 138, "mentolabial_angle": 122, "facial_convexity": 168, "jaw_angle": 26 },
  "face_bbox": { "x_min": <0..1>, "y_min": <0..1>, "x_max": <0..1>, "y_max": <0..1> },
  "side_keypoints": {
    "forehead":    { "x": <0..1 within bbox>, "y": <0..1 within bbox> },
    "nose_bridge": { "x": <0..1>, "y": <0..1> },
    "nose_tip":    { "x": <0..1>, "y": <0..1> },
    "philtrum":    { "x": <0..1>, "y": <0..1> },
    "lower_lip":   { "x": <0..1>, "y": <0..1> },
    "chin":        { "x": <0..1>, "y": <0..1> },
    "ear_front":   { "x": <0..1>, "y": <0..1> }
  }
}
(face_bbox와 side_keypoints의 실제 숫자는 사진을 직접 보고 채우세요. 위 placeholder를
그대로 출력하지 마세요.)`;

/**
 * 측면 프로파일 메트릭 hint — 클라이언트가 MediaPipe로 추출한 4가지 각도.
 *
 * `lib/face-shape.ts`의 `SideProfileMetrics`와 구조적으로 동일하지만,
 * 모듈 순환을 피하기 위해 prompt 모듈에서는 자체 타입으로 표현한다.
 */
export interface SideMetricsHint {
  nasofrontal_angle?: number;
  mentolabial_angle?: number;
  facial_convexity?: number;
  jaw_angle?: number;
}

/**
 * 사용자 옵션과 제공된 뷰 목록을 한국어 텍스트 블록으로 구조화한다.
 * `provided_views`가 비어 있으면 예외를 던진다.
 *
 * `sideMetrics`가 주어지고 한 개 이상의 정의된 필드를 포함하면,
 * 모델이 참고할 수 있는 측정값 블록을 추가한다.
 */
export function buildUserPrompt(
  gender: Gender,
  lengthPreference: LengthPreference,
  providedViews: ViewKey[],
  sideMetrics?: SideMetricsHint,
): string {
  if (providedViews.length === 0) {
    throw new Error("최소 한 장 이상의 사진이 필요합니다.");
  }

  const orderedViews = VIEW_ORDER.filter((v) => providedViews.includes(v));
  const providedLabels = orderedViews.map((v) => VIEW_LABELS[v]);
  const missingLabels = VIEW_ORDER.filter(
    (v) => !providedViews.includes(v),
  ).map((v) => VIEW_LABELS[v]);

  const imageBlock = providedLabels
    .map((label, idx) => `[이미지 ${idx + 1}] ${label} 사진`)
    .join("\n");

  const missingNote =
    missingLabels.length > 0
      ? `이번 분석에는 ${missingLabels.join("/")} 사진이 빠져 있습니다. 누락된 뷰는 일반론으로만 가볍게 다루고, 제공된 사진 안에서 확실한 관찰만 활용해 추천을 정리해 주세요.`
      : "정면·측면·뒷면 모두 제공되었습니다. 종합 분석을 진행해 주세요.";

  // 측면 측정값 hint — 정의된 필드가 1개 이상일 때만 추가
  const metricLabels: Record<keyof SideMetricsHint, string> = {
    nasofrontal_angle: "비전두각(nasofrontal)",
    mentolabial_angle: "이순각(mentolabial)",
    facial_convexity: "안면 볼록도(facial convexity)",
    jaw_angle: "하악각(jaw angle)",
  };
  const metricLines: string[] = [];
  if (sideMetrics) {
    for (const key of Object.keys(metricLabels) as Array<keyof SideMetricsHint>) {
      const v = sideMetrics[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        metricLines.push(`- ${metricLabels[key]}: ${v.toFixed(1)}°`);
      }
    }
  }
  const metricsBlock =
    metricLines.length > 0
      ? `

[참고: 클라이언트 측 측정값]
아래 수치는 클라이언트의 MediaPipe 추출값입니다. 본인의 시각 분석이 더 정확하다 판단되면 override 하세요.
${metricLines.join("\n")}
- 이 수치를 \`head_shape_metrics\` JSON에 채울 수 있습니다(필수 아님).
- **자연어 필드(face_shape, head_shape, recommended_style.*, key_features, professional_analysis)에는 숫자나 도(°)를 절대 포함하지 않습니다.**`
      : "";

  // 측면 사진이 있을 때만 face_bbox + side_keypoints 안내 블록 추가.
  // 두 단계 좌표(bbox + bbox-relative)로 모델 정확도를 끌어올린다.
  const sideKeypointsBlock = providedViews.includes("side")
    ? `

[측면 키포인트 출력 지시 — face_bbox + side_keypoints]
1단계) \`face_bbox\` — 측면 사진에서 얼굴(이마~턱~귀)을 가장 작게 감싸는 axis-aligned 사각형을 원본 사진 기준 [0, 1] 정규화 좌표로 출력. 형식 \`{ "x_min", "y_min", "x_max", "y_max" }\`. 머리카락/배경 제외, **얼굴 살갗 윤곽**만. 측면이 아니거나 가려졌으면 \`null\`.
2단계) \`side_keypoints\` — face_bbox **내부 상대 좌표**로 7개 앵커 출력. (0,0)=bbox 좌상단, (1,1)=bbox 우하단. 원본 사진 좌표가 아닌 **bbox 내부 비율** [0, 1]. 7개 앵커: \`forehead\`, \`nose_bridge\`, \`nose_tip\`, \`philtrum\`, \`lower_lip\`, \`chin\`, \`ear_front\`. 각 값 \`{ "x": <0~1>, "y": <0~1> }\`.
- 코끝(nose_tip)과 턱(chin)은 측면 윤곽이 향한 쪽 가장자리에 가까워야 하고, 귀(ear_front)는 그 반대쪽에 위치해야 자연스럽습니다. 이 패턴이 깨지면 좌표를 다시 검토하세요.
- 확실한 키포인트가 3개 미만이면 \`side_keypoints\`를 \`null\`로 반환 (부분 객체 금지). 측면이 아니거나 흐리면 \`face_bbox\`도 \`side_keypoints\`도 모두 \`null\`.
- **자연어 필드(face_shape, head_shape, professional_analysis, key_features)에는 어떤 좌표·숫자도 절대 포함하지 않습니다.**`
    : "";

  return `다음은 한 고객의 사진과 시술 옵션입니다. 시스템 프롬프트의 분석 절차에 따라 분석해 주세요.

${imageBlock}

[옵션]
- 성별: ${gender}
- 기장 변화 선호: ${lengthPreference}

[제공 사진 안내]
${missingNote}${metricsBlock}${sideKeypointsBlock}

[수행 지시]
- 사고 과정은 내부적으로만 수행하고 출력에 포함하지 마세요.
- 누락된 뷰가 있더라도 분석을 거부하지 말고, 제공된 정보 안에서 가장 적합한 스타일을 한 가지 선정해 주세요.
- **반드시 칭찬 위주 톤**으로 분석합니다. 단점/보완 표현 금지, 강점/매력 표현만 사용.
- \`professional_analysis\`는 고객의 매력에 대한 따뜻한 칭찬으로 시작합니다.
- 검색 키워드는 실제 인터넷에서 레퍼런스 이미지가 잘 검색될 수 있도록 작성하세요.
  (예: "남성 둥근형 얼굴 투블럭 미디엄", "women oval face long layered bob")
- 모든 자연어 필드는 반드시 한국어로 작성합니다.
- 마지막 응답은 아래 JSON 스키마 한 개의 객체만 포함해야 합니다. JSON 앞뒤에 어떤 텍스트나 코드 블록 마커도 붙이지 마세요.

[출력 JSON 형식 예시]
${OUTPUT_EXAMPLE}
`;
}

/* ----------------------------- Schemas ----------------------------- */

export const RecommendedStyleSchema = z.object({
  name: z.string().min(1, "스타일 이름이 비어 있습니다."),
  length: z.string().min(1, "기장 정보가 비어 있습니다."),
  key_features: z
    .array(z.string())
    .min(1, "핵심 포인트가 최소 1개 필요합니다."),
});

/**
 * 측면 프로파일 4각도 — 모두 optional, 측면 사진이 있을 때만 의미 있다.
 * `.strict()`을 쓰지 않는 이유: 모델이 새 필드를 추가해도 기존 응답을 깨뜨리지 않기 위함.
 */
export const HeadShapeMetricsSchema = z
  .object({
    nasofrontal_angle: z.number().optional(),
    mentolabial_angle: z.number().optional(),
    facial_convexity: z.number().optional(),
    jaw_angle: z.number().optional(),
  })
  .optional();

/**
 * 단일 측면 키포인트 — 원본 사진 기준 정규화 [0,1] 좌표.
 * x=0(왼쪽 가장자리), y=0(위쪽 가장자리). CSS box가 아니라 원본 픽셀 영역.
 */
export const SideKeypointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * 측면 키포인트 7개 묶음. 모델이 자신 있는 부분 집합만 채울 수 있고,
 * 3개 미만이면 \`null\`을 반환해야 한다(SYSTEM_PROMPT 명시).
 *
 * - 모델이 키 누락 → optional, 객체 자체 누락 → optional, 명시 \`null\` → nullable
 *   세 경우 모두 허용. 클라이언트는 `result.side_keypoints ?? null`로 정규화한다.
 */
export const SideKeypointsSchema = z
  .object({
    forehead: SideKeypointSchema.optional(),
    nose_bridge: SideKeypointSchema.optional(),
    nose_tip: SideKeypointSchema.optional(),
    philtrum: SideKeypointSchema.optional(),
    lower_lip: SideKeypointSchema.optional(),
    chin: SideKeypointSchema.optional(),
    ear_front: SideKeypointSchema.optional(),
  })
  .nullable()
  .optional();

/**
 * 얼굴 영역 axis-aligned bounding box — 원본 측면 사진 기준 정규화 [0, 1].
 * side_keypoints의 좌표는 이 bbox 내부의 상대 좌표로 표현된다.
 * Claude가 절대 정규화 좌표를 짚을 때보다 정확도가 2-3배 향상됨.
 */
export const FaceBboxSchema = z
  .object({
    x_min: z.number(),
    y_min: z.number(),
    x_max: z.number(),
    y_max: z.number(),
  })
  .nullable()
  .optional();

export const AnalysisResultSchema = z.object({
  face_shape: z.string().min(1),
  /**
   * 6분류 enum. 모델이 누락하거나 미지원 라벨을 보내면 optional로 두고
   * 클라이언트의 `classifyFaceShape`가 텍스트/landmarks 기반 폴백으로 보강한다.
   */
  face_shape_category: z.enum(FACE_SHAPE_CATEGORIES).optional(),
  head_shape: z.string().min(1),
  recommended_style: RecommendedStyleSchema,
  professional_analysis: z.string().min(1),
  search_keywords: z
    .array(z.string())
    .min(3, "검색 키워드는 최소 3개 필요합니다.")
    .max(5, "검색 키워드는 최대 5개까지 허용합니다."),
  head_shape_metrics: HeadShapeMetricsSchema,
  face_bbox: FaceBboxSchema,
  side_keypoints: SideKeypointsSchema,
});

export type RecommendedStyle = z.infer<typeof RecommendedStyleSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
export type SideKeypoints = z.infer<typeof SideKeypointsSchema>;
export type SideKeypoint = z.infer<typeof SideKeypointSchema>;
export type FaceBbox = z.infer<typeof FaceBboxSchema>;

/** UI/응답에서 활용하는 입력 메타데이터 */
export interface AnalysisRequestMeta {
  gender: Gender;
  lengthPreference: LengthPreference;
  providedViews: ViewKey[];
}
