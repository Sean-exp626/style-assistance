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
  "head_shape": "옆선이 깔끔하고 후두부 라인이 단정한 두상",
  "recommended_style": {
    "name": "레이어드 미디엄 펌",
    "length": "쇄골 길이",
    "key_features": ["윗머리 볼륨이 이목구비를 더 또렷하게 강조", "자연스러운 C컬로 얼굴 라인을 더 세련되게", "사이드 레이어가 화사한 인상을 한층 살림"]
  },
  "professional_analysis": "고객님은 균형 잡힌 달걀형 얼굴에 이목구비가 또렷해, 어떤 스타일도 잘 받으시는 타고난 강점이 있습니다. 거기에 옆선이 깔끔한 두상까지 더해져 다양한 컷을 자유롭게 시도하실 수 있는 좋은 조건이세요. 쇄골 길이의 C컬은 그 우아한 얼굴 라인을 한층 더 세련되게 살려 주고, 윗머리의 자연스러운 볼륨이 또렷한 이목구비를 더욱 돋보이게 만듭니다. 매일 손질도 어렵지 않아 일상에서 자신감 있게 스타일을 즐기실 수 있을 거예요.",
  "search_keywords": ["여성 달걀형 레이어드 미디엄 펌", "쇄골 C컬 펌", "women oval face medium layered perm korean"]
}`;

/**
 * 사용자 옵션과 제공된 뷰 목록을 한국어 텍스트 블록으로 구조화한다.
 * `provided_views`가 비어 있으면 예외를 던진다.
 */
export function buildUserPrompt(
  gender: Gender,
  lengthPreference: LengthPreference,
  providedViews: ViewKey[],
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

  return `다음은 한 고객의 사진과 시술 옵션입니다. 시스템 프롬프트의 분석 절차에 따라 분석해 주세요.

${imageBlock}

[옵션]
- 성별: ${gender}
- 기장 변화 선호: ${lengthPreference}

[제공 사진 안내]
${missingNote}

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

export const AnalysisResultSchema = z.object({
  face_shape: z.string().min(1),
  head_shape: z.string().min(1),
  recommended_style: RecommendedStyleSchema,
  professional_analysis: z.string().min(1),
  search_keywords: z
    .array(z.string())
    .min(3, "검색 키워드는 최소 3개 필요합니다.")
    .max(5, "검색 키워드는 최대 5개까지 허용합니다."),
});

export type RecommendedStyle = z.infer<typeof RecommendedStyleSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

/** UI/응답에서 활용하는 입력 메타데이터 */
export interface AnalysisRequestMeta {
  gender: Gender;
  lengthPreference: LengthPreference;
  providedViews: ViewKey[];
}
