/**
 * Claude Vision 호출과 응답 파싱.
 *
 * Streamlit 원본 `ai_logic.py`의 `analyze_customer`를 TypeScript로 포팅.
 * - 모델 ID는 정확히 `claude-opus-4-7` (변경 금지)
 * - 시스템 프롬프트에 prompt caching 적용 (`cache_control: ephemeral`)
 * - 이미지는 base64로 인코딩하고 PNG/JPEG 매직 바이트로 MIME 자동 감지
 * - 응답 텍스트 → JSON 파싱은 4단계 폴백 (그대로 / fence / 첫 { ~ 마지막 })
 * - zod로 검증, 에러는 한국어 메시지로 변환
 *
 * Phase 1에서는 web_search 도구를 사용하지 않는다 (Phase 2 작업).
 */
import Anthropic from "@anthropic-ai/sdk";

import {
  AnalysisResultSchema,
  buildUserPrompt,
  SYSTEM_PROMPT,
  type AnalysisResult,
  type Gender,
  type LengthPreference,
  type SideMetricsHint,
  type ViewKey,
} from "./prompts";

const MODEL_NAME = "claude-opus-4-7" as const;
const MAX_TOKENS = 4096;
const DEFAULT_MEDIA_TYPE = "image/jpeg" as const;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

const VIEW_LABELS: Record<ViewKey, string> = {
  front: "정면사진",
  side: "측면사진",
  back: "뒷면사진",
};

const VIEW_ORDER: readonly ViewKey[] = ["front", "side", "back"] as const;

type SupportedMediaType = "image/jpeg" | "image/png";

function detectMediaType(bytes: Buffer): SupportedMediaType {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (bytes.length >= JPEG_SIGNATURE.length && bytes.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) {
    return "image/jpeg";
  }
  return DEFAULT_MEDIA_TYPE;
}

/* ----------------------------- JSON 파싱 ----------------------------- */

const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/;

function tryParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Claude 응답 텍스트에서 JSON 객체를 4단계 폴백으로 추출한다.
 * 1) 그대로 파싱
 * 2) ```json ... ``` 코드펜스 안쪽
 * 3) 첫 `{` ~ 마지막 `}` 슬라이스
 * 실패 시 한국어 메시지로 throw.
 */
function parseJsonPayload(rawText: string): Record<string, unknown> {
  const stripped = rawText.trim();

  const direct = tryParseObject(stripped);
  if (direct) return direct;

  const fenceMatch = stripped.match(FENCED_JSON_RE);
  if (fenceMatch) {
    const fenced = tryParseObject(fenceMatch[1]);
    if (fenced) return fenced;
  }

  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    const sliced = tryParseObject(stripped.slice(first, last + 1));
    if (sliced) return sliced;
  }

  throw new Error("Claude 응답에서 JSON 객체를 찾지 못했습니다. 다시 시도해 주세요.");
}

/* ----------------------------- 메시지 빌드 ----------------------------- */

type ImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: SupportedMediaType;
    data: string;
  };
};

type TextBlock = { type: "text"; text: string };

type UserContentBlock = TextBlock | ImageBlock;

function buildImageBlock(bytes: Buffer): ImageBlock {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: detectMediaType(bytes),
      data: bytes.toString("base64"),
    },
  };
}

function buildMessages(
  images: Partial<Record<ViewKey, Buffer>>,
  gender: Gender,
  lengthPreference: LengthPreference,
  sideMetrics?: SideMetricsHint,
): Array<{ role: "user"; content: UserContentBlock[] }> {
  const orderedKeys = VIEW_ORDER.filter((k): k is ViewKey => images[k] !== undefined);
  if (orderedKeys.length === 0) {
    throw new Error("정면/측면/뒷면 중 최소 한 장의 사진이 필요합니다.");
  }

  const content: UserContentBlock[] = [];
  for (const key of orderedKeys) {
    const buf = images[key];
    if (!buf) continue; // narrow
    content.push({ type: "text", text: `[${VIEW_LABELS[key]}]` });
    content.push(buildImageBlock(buf));
  }
  content.push({
    type: "text",
    text: buildUserPrompt(gender, lengthPreference, orderedKeys, sideMetrics),
  });

  return [{ role: "user", content }];
}

/* ----------------------------- 진입점 ----------------------------- */

export interface AnalyzeCustomerParams {
  images: Partial<Record<ViewKey, Buffer>>;
  gender: Gender;
  lengthPreference: LengthPreference;
  /**
   * 측면 사진 MediaPipe 분석에서 추출된 4각도 hint (선택).
   * 모델은 이 수치를 참고하되 본인 시각 분석으로 override 가능.
   */
  sideMetrics?: SideMetricsHint;
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다. Vercel 환경 변수를 확인해 주세요.");
  }
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

/**
 * 사진(최소 1장)과 옵션을 받아 헤어스타일 분석 결과를 반환한다.
 * 호출 측은 `AnalysisResult`만 받는다 — 모델 ID, max_tokens 등 인프라 세부는 노출하지 않는다.
 */
export async function analyzeCustomer(
  params: AnalyzeCustomerParams,
): Promise<AnalysisResult> {
  const client = getClient();
  const messages = buildMessages(
    params.images,
    params.gender,
    params.lengthPreference,
    params.sideMetrics,
  );

  let response;
  try {
    response = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: MAX_TOKENS,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
    });
  } catch (err: unknown) {
    throw mapAnthropicError(err);
  }

  const textChunks: string[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      textChunks.push(block.text);
    }
  }
  if (textChunks.length === 0) {
    throw new Error("Claude 응답에 텍스트 블록이 없습니다.");
  }

  const payload = parseJsonPayload(textChunks.join("\n"));

  const validation = AnalysisResultSchema.safeParse(payload);
  if (!validation.success) {
    const firstIssue = validation.error.issues[0];
    const reason = firstIssue?.message ?? "스키마 불일치";
    throw new Error(
      `AI 응답이 예상한 형식과 다릅니다. 사진을 바꿔 다시 시도해 주세요. (사유: ${reason})`,
    );
  }
  return validation.data;
}

function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error("Anthropic API 키가 유효하지 않습니다. Vercel 환경 변수를 확인해 주세요.");
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error("Anthropic API 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.");
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API 호출 중 오류가 발생했습니다: ${err.message}`);
  }
  if (err instanceof Error) {
    return new Error(`알 수 없는 오류: ${err.message}`);
  }
  return new Error("알 수 없는 오류가 발생했습니다.");
}
