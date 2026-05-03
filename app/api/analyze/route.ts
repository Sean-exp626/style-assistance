/**
 * POST /api/analyze
 *
 * multipart/form-data 폼을 받아 헤어스타일 분석 결과를 반환한다.
 *
 * 입력 필드:
 *   - front, side, back: File (모두 선택, 최소 1장 필요)
 *   - gender: "남성" | "여성"
 *   - length: "현재 유지" | "더 짧게" | "더 길게"
 *
 * 응답:
 *   200 OK { result: AnalysisResult, providedViews: ViewKey[] }
 *   400 Bad Request { error: string }
 *   500 Internal Server Error { error: string }
 *
 * 책임 분리: 라우터는 입력 검증/직렬화만 담당하고 도메인 로직은 `lib/analyze.ts`로 위임한다.
 */
import { analyzeCustomer } from "@/lib/analyze";
import type {
  Gender,
  LengthPreference,
  ViewKey,
} from "@/lib/prompts";

// Anthropic Vision 호출은 Edge runtime의 메모리/실행시간 한도로는 부족함
export const runtime = "nodejs";
// Anthropic Vision 호출 30~50초 + 파일 처리 여유. Vercel 무료 플랜 한도가 60초이므로 60에 맞춤.
export const maxDuration = 60;

const VIEW_KEYS: readonly ViewKey[] = ["front", "side", "back"] as const;
const VIEW_LABELS: Record<ViewKey, string> = {
  front: "정면",
  side: "측면",
  back: "뒷면",
};

const GENDERS: readonly Gender[] = ["남성", "여성"] as const;
const LENGTHS: readonly LengthPreference[] = [
  "현재 유지",
  "더 짧게",
  "더 길게",
] as const;

// Vercel Function payload 한계 + Anthropic Vision 권장 크기 고려한 서버측 안전망 (10MB)
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function isGender(value: unknown): value is Gender {
  return typeof value === "string" && (GENDERS as readonly string[]).includes(value);
}

function isLengthPreference(value: unknown): value is LengthPreference {
  return typeof value === "string" && (LENGTHS as readonly string[]).includes(value);
}

export async function POST(req: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return badRequest("요청 본문을 읽을 수 없습니다. multipart/form-data 형식으로 보내주세요.");
  }

  const gender = formData.get("gender");
  const length = formData.get("length");
  if (!isGender(gender)) {
    return badRequest("성별 값이 잘못되었습니다. ('남성' 또는 '여성')");
  }
  if (!isLengthPreference(length)) {
    return badRequest("기장 변화 값이 잘못되었습니다. ('현재 유지' / '더 짧게' / '더 길게')");
  }

  const images: Partial<Record<ViewKey, Buffer>> = {};
  const providedViews: ViewKey[] = [];

  for (const view of VIEW_KEYS) {
    const file = formData.get(view);
    if (!file) continue;
    if (!(file instanceof File) || file.size === 0) {
      // 빈 input은 폼이 빈 Blob을 보낼 수 있으므로 무시
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      return badRequest(
        `${VIEW_LABELS[view]} 사진이 10MB를 초과합니다. 더 작은 파일로 업로드해 주세요.`,
      );
    }
    const buf = Buffer.from(await file.arrayBuffer());
    images[view] = buf;
    providedViews.push(view);
  }

  if (providedViews.length === 0) {
    return badRequest("정면/측면/뒷면 중 최소 한 장의 사진이 필요합니다.");
  }

  try {
    const result = await analyzeCustomer({
      images,
      gender,
      lengthPreference: length,
    });
    return Response.json({ result, providedViews }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류가 발생했습니다.";
    // 4xx와 5xx 구분이 어려우므로 보수적으로 500으로 통일하되 메시지는 한국어로 노출
    console.error("/api/analyze failed:", err);
    return Response.json({ error: message }, { status: 500 });
  }
}
