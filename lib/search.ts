/**
 * 레퍼런스 이미지 검색 로직.
 *
 * Streamlit 원본 `search_logic.py`의 `_search_via_anthropic` + 헬퍼들을 TypeScript로 포팅.
 *
 * 흐름:
 *   1) Anthropic Messages API에 `web_search_20250305` 도구를 붙여 호출
 *   2) 응답 content에서 `web_search_tool_result` 블록 → 내부 `web_search_result` 항목 수집
 *   3) 후보 URL에 대해 `extractImageFromPage`를 병렬 페치 (Promise.allSettled)
 *   4) 추출 실패 시 thum.io 페이지 스크린샷 폴백 → image_url은 항상 존재
 *   5) 도메인 다양성 확보 (같은 도메인은 갤러리의 절반까지만, 부족하면 채움)
 *
 * 관심사 분리:
 *   - 이 모듈은 "도메인 로직"이며 HTTP 인터페이스에서 분리 — `app/api/references/route.ts`가 호출
 *   - HTML 파싱/네트워크 I/O 디테일은 `lib/og-image.ts`에 위임
 *   - 분석(`lib/analyze.ts`)과 검색(`lib/search.ts`)은 단일 책임 원칙으로 명확히 분리
 *     → 분석은 web_search 없이 깔끔하게 유지, 검색은 별도 엔드포인트로 호출
 */
import Anthropic from "@anthropic-ai/sdk";

const MODEL_NAME = "claude-opus-4-7" as const;
const MAX_TOKENS = 1024;
const DEFAULT_NUM_RESULTS = 5;

const THUMBNAIL_FALLBACK = (url: string): string =>
  `https://image.thum.io/get/width/600/maxAge/12/${url}`;

export interface ReferenceImage {
  /** 페이지 제목 (없으면 "레퍼런스") */
  title: string;
  /** 원문 페이지 URL — 카드의 "원문 보기" 링크가 가리킬 곳 */
  url: string;
  /** 카드에 표시할 이미지 URL — 추출 실패 시 thum.io 스크린샷 */
  image_url: string;
  /** 페이지 도메인 (디스플레이 + 다양성 dedup용) */
  source: string;
}

interface RawCandidate {
  url: string;
  title: string;
}

let cachedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다.");
  }
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

/** Streamlit 원본 `_build_search_prompt`를 그대로 포팅한 한국어 프롬프트. */
function buildSearchPrompt(keywords: string[], numResults: number): string {
  const keywordBlock = keywords.map((kw) => `"${kw}"`).join(", ");
  const minHits = Math.max(numResults, 8);
  return (
    "다음 헤어스타일 키워드로 한국 사이트(네이버 블로그, 인스타그램, 핀터레스트, " +
    "헤어샵 사이트, 패션 매거진 등)에서 레퍼런스 사진이 들어 있는 페이지를 찾아 주세요. " +
    `키워드: ${keywordBlock}. ` +
    `web_search 도구를 사용해 최소 ${minHits}건 이상의 결과를 모아 주세요. ` +
    "검색 결과 URL이 다양한 출처에서 골고루 나오도록 합니다."
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/**
 * Claude 응답에서 web_search_tool_result 블록만 골라 (url, title) 후보 수집.
 *
 * 동일한 URL이 여러 검색 호출에서 중복으로 등장할 수 있어 dedup도 함께 한다.
 */
function collectUrlsFromResponse(
  response: Anthropic.Messages.Message,
): RawCandidate[] {
  const results: RawCandidate[] = [];
  const seen = new Set<string>();

  for (const block of response.content) {
    if (block.type !== "web_search_tool_result") continue;

    const toolResult = block as Anthropic.Messages.WebSearchToolResultBlock;
    const inner = toolResult.content;
    // content는 에러 객체 OR Array<WebSearchResultBlock>
    if (!Array.isArray(inner)) continue;

    for (const item of inner) {
      if (item.type !== "web_search_result") continue;
      const url = (item.url ?? "").trim();
      const rawTitle = (item.title ?? "").trim();
      const title = rawTitle.length > 0 ? rawTitle : "레퍼런스";

      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({ url, title });
    }
  }

  return results;
}

/**
 * 후보 리스트를 도메인 다양성을 고려해 numResults개로 추린다.
 *
 * 1차: 같은 도메인이 이미 들어 있고 final이 절반 이상 찼으면 스킵
 * 2차: 부족하면 도메인 중복 허용으로 채움
 */
function pickWithDomainDiversity(
  candidates: RawCandidate[],
  extracted: Map<string, string | null>,
  numResults: number,
): ReferenceImage[] {
  const final: ReferenceImage[] = [];
  const seenDomains = new Set<string>();
  const halfThreshold = Math.floor(numResults / 2);

  for (const cand of candidates) {
    const imageUrl = extracted.get(cand.url) || THUMBNAIL_FALLBACK(cand.url);
    const domain = domainOf(cand.url);

    if (domain && seenDomains.has(domain) && final.length >= halfThreshold) {
      continue;
    }
    seenDomains.add(domain);

    final.push({
      title: cand.title,
      url: cand.url,
      image_url: imageUrl,
      source: domain,
    });

    if (final.length >= numResults) break;
  }

  if (final.length < numResults) {
    const already = new Set(final.map((f) => f.url));
    for (const cand of candidates) {
      if (already.has(cand.url)) continue;
      const imageUrl = extracted.get(cand.url) || THUMBNAIL_FALLBACK(cand.url);
      final.push({
        title: cand.title,
        url: cand.url,
        image_url: imageUrl,
        source: domainOf(cand.url),
      });
      if (final.length >= numResults) break;
    }
  }

  return final;
}

/**
 * Anthropic web_search 도구를 호출하여 키워드에 맞는 레퍼런스 이미지 후보를 반환한다.
 *
 * - 빈 keywords → 빈 배열
 * - API 키 없음 / API 호출 실패 → 빈 배열 (UI는 빈 상태로 분기)
 * - 후보 풀은 max(numResults*2, numResults+2)만큼 잘라낸 뒤 og:image 병렬 페치
 * - 결과 image_url은 항상 채워짐 (실패 시 thum.io 스크린샷)
 */
export async function searchReferenceImages(
  keywords: string[],
  numResults: number = DEFAULT_NUM_RESULTS,
): Promise<ReferenceImage[]> {
  if (!keywords || keywords.length === 0) {
    return [];
  }

  // og-image.ts를 동적 import — 라우트 핸들러가 이 모듈만 import하면 되도록 진입점 단일화
  const { extractImageFromPage } = await import("./og-image");

  let client: Anthropic;
  try {
    client = getClient();
  } catch {
    return [];
  }

  let response: Anthropic.Messages.Message;
  try {
    response = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: MAX_TOKENS,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 3,
        },
      ],
      messages: [
        {
          role: "user",
          content: buildSearchPrompt(keywords, numResults),
        },
      ],
    });
  } catch (err) {
    console.error("[search] Anthropic web_search 호출 실패:", err);
    return [];
  }

  const raw = collectUrlsFromResponse(response);
  if (raw.length === 0) return [];

  const candidatePoolSize = Math.max(numResults * 2, numResults + 2);
  const candidates = raw.slice(0, candidatePoolSize);

  // 페이지마다 og:image 병렬 페치. 각 호출은 4초 timeout이라 전체 대기 시간이 폭주하지 않는다.
  const extracted = new Map<string, string | null>();
  const settled = await Promise.allSettled(
    candidates.map((c) => extractImageFromPage(c.url)),
  );
  candidates.forEach((cand, idx) => {
    const r = settled[idx];
    extracted.set(cand.url, r.status === "fulfilled" ? r.value : null);
  });

  return pickWithDomainDiversity(candidates, extracted, numResults);
}
