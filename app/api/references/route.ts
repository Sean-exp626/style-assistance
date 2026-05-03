/**
 * POST /api/references
 *
 * 분석 응답의 `search_keywords`를 받아 레퍼런스 이미지 갤러리를 반환한다.
 * 분석 호출(`/api/analyze`)과는 분리된 엔드포인트로, 단일 책임을 명확히 한다.
 *
 * 입력 (JSON):
 *   { keywords: string[]; num_results?: number }
 *
 * 응답:
 *   200 OK { references: ReferenceImage[] }
 *     - keywords가 비었거나 검색 실패 시에도 200 + 빈 배열 (UI에서 분기)
 *   400 Bad Request { error: string }  // 잘못된 입력 (JSON 파싱 실패 / 타입 불일치)
 *
 * 도메인 로직은 `lib/search.ts`로 위임 — 라우터는 입력 검증/직렬화만 담당.
 */
import { searchReferenceImages, type ReferenceImage } from "@/lib/search";

// Anthropic web_search + 6개 페이지 병렬 og 페치는 메모리/시간 모두 nodejs 런타임 필요
export const runtime = "nodejs";
// web_search 호출(최대 ~25초) + 6개 페이지 병렬 페치 (각 4s timeout) 여유로 60초 확보
export const maxDuration = 60;

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 12;
const MAX_KEYWORD_LEN = 200;
const MAX_KEYWORDS = 10;

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function ok(references: ReferenceImage[]): Response {
  return Response.json({ references }, { status: 200 });
}

interface ReferencesRequest {
  keywords: string[];
  num_results: number;
}

/**
 * 입력 본문을 검증해 정규화된 형태로 반환한다.
 * - keywords: string[] (1~MAX_KEYWORDS, 각 1~MAX_KEYWORD_LEN자)
 * - num_results: 1~MAX_NUM_RESULTS, 정수
 * 잘못된 형식이면 Error throw.
 */
function parseRequest(body: unknown): ReferencesRequest {
  if (body === null || typeof body !== "object") {
    throw new Error("요청 본문은 JSON 객체여야 합니다.");
  }
  const obj = body as Record<string, unknown>;

  const rawKeywords = obj.keywords;
  if (!Array.isArray(rawKeywords)) {
    throw new Error("keywords는 문자열 배열이어야 합니다.");
  }
  if (rawKeywords.length > MAX_KEYWORDS) {
    throw new Error(`keywords는 최대 ${MAX_KEYWORDS}개까지 허용합니다.`);
  }
  const keywords: string[] = [];
  for (const kw of rawKeywords) {
    if (typeof kw !== "string") {
      throw new Error("keywords의 각 요소는 문자열이어야 합니다.");
    }
    const trimmed = kw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_KEYWORD_LEN) {
      throw new Error(`키워드가 너무 깁니다 (최대 ${MAX_KEYWORD_LEN}자).`);
    }
    keywords.push(trimmed);
  }

  let numResults = DEFAULT_NUM_RESULTS;
  if (obj.num_results !== undefined && obj.num_results !== null) {
    const n = obj.num_results;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error("num_results는 정수여야 합니다.");
    }
    if (n < 1 || n > MAX_NUM_RESULTS) {
      throw new Error(`num_results는 1~${MAX_NUM_RESULTS} 범위여야 합니다.`);
    }
    numResults = n;
  }

  return { keywords, num_results: numResults };
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("요청 본문을 JSON으로 파싱할 수 없습니다.");
  }

  let parsed: ReferencesRequest;
  try {
    parsed = parseRequest(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "잘못된 요청입니다.";
    return badRequest(message);
  }

  // 빈 키워드는 정상 응답으로 처리 — UI는 빈 갤러리로 표시
  if (parsed.keywords.length === 0) {
    return ok([]);
  }

  try {
    const references = await searchReferenceImages(
      parsed.keywords,
      parsed.num_results,
    );
    return ok(references);
  } catch (err) {
    // 도메인 로직 단에서 예외를 던지더라도 UI 흐름은 끊지 않도록 빈 배열로 응답한다.
    console.error("/api/references failed:", err);
    return ok([]);
  }
}
