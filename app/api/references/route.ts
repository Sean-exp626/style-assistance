/**
 * POST /api/references
 *
 * 분석 응답의 `search_keywords`를 받아 레퍼런스 이미지 갤러리를 반환한다.
 * 분석 호출(`/api/analyze`)과는 분리된 엔드포인트로, 단일 책임을 명확히 한다.
 *
 * 입력 (JSON):
 *   { keywords: string[]; num_results?: number; analysisId?: string }
 *     - analysisId가 주어지면 해당 hairAnalyses 문서의 `references` 필드를 update한다
 *       (분석 시점에는 빈 배열로 저장됨 → 갤러리 로딩 후 보강).
 *
 * 응답:
 *   200 OK { references: ReferenceImage[] }
 *     - keywords가 비었거나 검색 실패 시에도 200 + 빈 배열 (UI에서 분기)
 *   400 Bad Request { error: string }  // 잘못된 입력 (JSON 파싱 실패 / 타입 불일치)
 *   401 Unauthorized { error: string }
 *
 * 도메인 로직은 `lib/search.ts`로 위임 — 라우터는 입력 검증/직렬화 + 인증/로깅만 담당.
 */
import { adminDb, verifySessionCookieFromRequest } from "@/lib/firebase/admin";
import { searchReferenceImages, type ReferenceImage } from "@/lib/search";

// Anthropic web_search + 6개 페이지 병렬 og 페치는 메모리/시간 모두 nodejs 런타임 필요
export const runtime = "nodejs";
// web_search 호출(최대 ~25초) + 6개 페이지 병렬 페치 (각 4s timeout) 여유로 60초 확보
export const maxDuration = 60;

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 12;
const MAX_KEYWORD_LEN = 200;
const MAX_KEYWORDS = 10;
// Firestore document ID는 보통 20자 자동생성. 외부 입력이므로 안전망 상한.
const MAX_ANALYSIS_ID_LEN = 128;

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

function unauthorized(error: string): Response {
  return Response.json({ error }, { status: 401 });
}

function ok(references: ReferenceImage[]): Response {
  return Response.json({ references }, { status: 200 });
}

interface ReferencesRequest {
  keywords: string[];
  num_results: number;
  analysisId?: string;
}

/**
 * 입력 본문을 검증해 정규화된 형태로 반환한다.
 * - keywords: string[] (1~MAX_KEYWORDS, 각 1~MAX_KEYWORD_LEN자)
 * - num_results: 1~MAX_NUM_RESULTS, 정수
 * - analysisId: 선택 — 비어있지 않은 짧은 문자열
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

  let analysisId: string | undefined;
  if (obj.analysisId !== undefined && obj.analysisId !== null) {
    if (typeof obj.analysisId !== "string") {
      throw new Error("analysisId는 문자열이어야 합니다.");
    }
    const trimmed = obj.analysisId.trim();
    if (trimmed.length > 0) {
      if (trimmed.length > MAX_ANALYSIS_ID_LEN) {
        throw new Error("analysisId가 너무 깁니다.");
      }
      analysisId = trimmed;
    }
  }

  return { keywords, num_results: numResults, analysisId };
}

/**
 * 검색된 references를 hairAnalyses/{analysisId} 문서에 update.
 *
 * 보안:
 *  - 다른 사용자의 doc을 건드리지 못하도록 update 전 read 후 uid 일치를 검증한다.
 *  - Firestore 보안 규칙은 write를 admin-only로 막아둔 상태이므로 클라이언트 우회는 없지만,
 *    서버 자신이 잘못된 analysisId를 받아도 cross-user contamination을 막아야 한다.
 *
 * 실패는 절대로 사용자 응답을 막지 않는다 — console.error만 남긴다.
 */
async function updateAnalysisReferences(
  analysisId: string,
  uid: string,
  references: ReferenceImage[],
): Promise<void> {
  try {
    const docRef = adminDb.collection("hairAnalyses").doc(analysisId);
    const snap = await docRef.get();
    if (!snap.exists) {
      console.error(
        `/api/references update skipped: analysisId=${analysisId} not found`,
      );
      return;
    }
    const data = snap.data();
    if (!data || data.uid !== uid) {
      console.error(
        `/api/references update skipped: uid mismatch (doc=${analysisId})`,
      );
      return;
    }
    await docRef.update({ references });
  } catch (err) {
    console.error("/api/references firestore update failed:", err);
  }
}

export async function POST(req: Request): Promise<Response> {
  // 1) 인증 게이트 — 비로그인 요청은 즉시 401
  const authed = await verifySessionCookieFromRequest(req);
  if (!authed) {
    return unauthorized("로그인이 필요합니다.");
  }
  const { uid } = authed;

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

  let references: ReferenceImage[];
  try {
    references = await searchReferenceImages(
      parsed.keywords,
      parsed.num_results,
    );
  } catch (err) {
    // 도메인 로직 단에서 예외를 던지더라도 UI 흐름은 끊지 않도록 빈 배열로 응답한다.
    console.error("/api/references failed:", err);
    references = [];
  }

  // analysisId가 있으면 해당 doc에 references를 보강 — 응답 전송과 무관하게 best-effort
  if (parsed.analysisId) {
    await updateAnalysisReferences(parsed.analysisId, uid, references);
  }

  return ok(references);
}
