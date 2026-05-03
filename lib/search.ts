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

/**
 * 결과에서 제외할 도메인 모음.
 *
 * - 봇 차단/캡차 (YouTube, namu.wiki, Cloudflare 보호 사이트)
 * - 쇼핑몰/가격비교 (다나와, 쿠팡 등) — 상품 사진이 잡혀 시술 레퍼런스로 부적절
 * - 가발/익스텐션 쇼핑몰 — 실제 시술 사진이 아님
 * - SNS 캡차 페이지 (TikTok, FB, X)
 */
const BLOCKED_DOMAINS = new Set([
  // 봇 차단 / 캡차
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "namu.wiki",
  "wikipedia.org",
  "ko.wikipedia.org",
  "en.wikipedia.org",
  "tiktok.com",
  "www.tiktok.com",
  "facebook.com",
  "www.facebook.com",
  "twitter.com",
  "x.com",

  // 쇼핑몰 / 가격비교 — 상품 페이지 제외
  "danawa.com",
  "search.danawa.com",
  "prod.danawa.com",
  "coupang.com",
  "www.coupang.com",
  "11st.co.kr",
  "www.11st.co.kr",
  "gmarket.co.kr",
  "www.gmarket.co.kr",
  "auction.co.kr",
  "www.auction.co.kr",
  "ssg.com",
  "www.ssg.com",
  "lotteon.com",
  "www.lotteon.com",
  "smartstore.naver.com",
  "shopping.naver.com",
  "search.shopping.naver.com",
  "tmon.co.kr",
  "wemakeprice.com",
  "interpark.com",
  "www.interpark.com",

  // 가발 / 익스텐션 쇼핑몰 — 시술 레퍼런스 아님
  "gabalnara.com",
  "www.gabalnara.com",
  "hairfit.co.kr",
  "wigko.com",

  // 해외 쇼핑
  "amazon.com",
  "www.amazon.com",
  "aliexpress.com",
  "www.aliexpress.com",
  "ebay.com",
  "www.ebay.com",
  "qoo10.com",
  "www.qoo10.com",
]);

/**
 * 페이지 도메인을 기준으로 결과에 포함시킬지 판단.
 * www. 접두사 / 모바일 서브도메인 등 변형도 차단 목록에 매칭되도록 한다.
 */
function isBlockedDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  if (BLOCKED_DOMAINS.has(d)) return true;
  // 서브도메인 매칭 (예: m.youtube.com → youtube.com)
  for (const blocked of BLOCKED_DOMAINS) {
    if (d.endsWith(`.${blocked}`)) return true;
  }
  return false;
}

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

/**
 * 검색 프롬프트 — Google Image Search를 활용해 실제 헤어 사진이 박힌 페이지를 모은다.
 *
 * - 디자이너 시술 사례 / 매거진 헤어 기사 / 블로그 후기 위주
 * - 쇼핑몰 / 가격비교 / 가발 / 캡차 페이지 명시적 제외
 */
function buildSearchPrompt(keywords: string[], numResults: number): string {
  const keywordBlock = keywords.map((kw) => `"${kw}"`).join(", ");
  const minHits = Math.max(numResults * 2, 10);
  const googleQuery = keywords.join(" ");
  return (
    "다음 헤어스타일 키워드로 **실제 사람의 헤어 사진(시술 사례)** 이 본문에 들어 있는 페이지를 찾아 주세요.\n\n" +
    `키워드: ${keywordBlock}\n\n` +
    "검색 방법:\n" +
    `1) 우선 Google Images에서 \`${googleQuery}\`로 이미지 검색을 수행해 본 뒤, ` +
    "이미지가 게시된 원본 페이지 URL을 후보로 모읍니다.\n" +
    "2) 또는 일반 web_search로 다음 우선 출처에서 헤어 사진 포스트를 찾습니다:\n" +
    "   - 네이버 블로그 (blog.naver.com) — 시술 후기 포스트\n" +
    "   - Pinterest (kr.pinterest.com / pinterest.com) — 헤어 핀 페이지\n" +
    "   - 헤어 디자이너 인스타그램/블로그\n" +
    "   - 매거진 헤어 기사 (allure, elle, vogue, marieclaire, 1stlook, hapers 등)\n" +
    "   - 티스토리 / 브런치 / 다음 카페 헤어 후기\n\n" +
    "**반드시 제외할 출처 (검색 결과에 절대 포함하지 마세요)**:\n" +
    "- 쇼핑몰 / 가격비교: danawa.com, coupang.com, 11st.co.kr, gmarket.co.kr, " +
    "auction.co.kr, smartstore.naver.com, ssg.com, lotteon.com 등 모든 쇼핑/판매 사이트\n" +
    "- 가발 / 익스텐션 쇼핑몰: gabalnara.com, hairfit.co.kr 등 (실제 시술 사진이 아님)\n" +
    "- 동영상 / 백과사전: youtube.com, namu.wiki, wikipedia.org\n" +
    "- 캡차 페이지: tiktok.com, facebook.com, twitter.com, x.com\n\n" +
    `web_search 도구로 최소 ${minHits}건 이상의 결과를 모아 주세요. ` +
    "**상품 사진이 아니라 사람의 실제 헤어 시술 사진**이어야 하고, " +
    "도메인이 다양하게 분포되도록 합니다. 영상이 아닌 사진 게시물 위주로."
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
  let blockedCount = 0;

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

      // 봇 차단 도메인은 og:image도 thum.io 스크린샷도 의미 없는 페이지가 잡히므로 제외
      if (isBlockedDomain(domainOf(url))) {
        blockedCount += 1;
        continue;
      }

      seen.add(url);
      results.push({ url, title });
    }
  }

  if (blockedCount > 0) {
    console.log(`[search] blocked ${blockedCount} candidates (youtube/wiki 등)`);
  }
  return results;
}

/**
 * 추출 결과(ExtractResult)에서 갤러리 카드용 image_url을 결정.
 *
 * - kind="ok": og:image URL 그대로 사용
 * - kind="miss": 페이지는 정상이지만 메타 이미지 없음 → thum.io 페이지 스크린샷 폴백
 * - kind="challenge": 봇 차단/캡차 페이지 → thum.io도 같은 페이지를 찍을 가능성 높아 null
 *   호출 측에서 이 후보를 결과에서 제외
 */
type ExtractKind = { kind: "ok"; url: string } | { kind: "miss" } | { kind: "challenge" };

function imageUrlFromExtract(pageUrl: string, ex: ExtractKind | undefined): string | null {
  if (!ex) return THUMBNAIL_FALLBACK(pageUrl); // 미실행 — fallback
  if (ex.kind === "ok") return ex.url;
  if (ex.kind === "miss") return THUMBNAIL_FALLBACK(pageUrl);
  return null; // challenge → 결과에서 제외
}

/**
 * 후보 리스트를 도메인 다양성을 고려해 numResults개로 추린다.
 *
 * 1차: 같은 도메인이 이미 들어 있고 final이 절반 이상 찼으면 스킵
 * 2차: 부족하면 도메인 중복 허용으로 채움
 * 봇 차단(challenge) 후보는 어떤 단계에서도 결과에 포함되지 않는다.
 */
function pickWithDomainDiversity(
  candidates: RawCandidate[],
  extracted: Map<string, ExtractKind>,
  numResults: number,
): ReferenceImage[] {
  const final: ReferenceImage[] = [];
  const seenDomains = new Set<string>();
  const halfThreshold = Math.floor(numResults / 2);

  for (const cand of candidates) {
    const imageUrl = imageUrlFromExtract(cand.url, extracted.get(cand.url));
    if (imageUrl === null) continue; // challenge — 제외
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
      const imageUrl = imageUrlFromExtract(cand.url, extracted.get(cand.url));
      if (imageUrl === null) continue;
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

/* ------------------------- Google Custom Search ------------------------- */

const GOOGLE_CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const GOOGLE_CSE_TIMEOUT_MS = 6000;

/**
 * Google Custom Search Engine `image` 검색을 호출한다.
 *
 * - GOOGLE_CSE_API_KEY + GOOGLE_CSE_ID 환경변수가 둘 다 있으면 활성화
 * - 직접 image URL을 받기 때문에 og:image 추출 단계가 불필요 → 가장 신뢰도 높음
 * - 차단 도메인 + thumbnail 추출 + 다양성 dedup은 그대로 적용
 * - 환경변수 없거나 호출 실패 시 빈 배열 반환 (호출 측에서 Anthropic web_search 폴백)
 */
async function searchViaGoogleImages(
  keywords: string[],
  numResults: number,
): Promise<ReferenceImage[]> {
  const apiKey = process.env.GOOGLE_CSE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cseId) return [];

  // 후보 풀은 차단 도메인 필터로 줄어드므로 여유 있게 가져옴 (Google은 한 번에 최대 10건)
  const requested = Math.min(Math.max(numResults * 2, 10), 10);

  const params = new URLSearchParams({
    key: apiKey,
    cx: cseId,
    q: keywords.join(" "),
    searchType: "image",
    num: String(requested),
    safe: "active",
    hl: "ko",
  });

  let response: Response;
  try {
    response = await fetch(`${GOOGLE_CSE_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(GOOGLE_CSE_TIMEOUT_MS),
    });
  } catch (err) {
    console.error("[search] Google CSE 호출 실패:", err);
    return [];
  }
  if (!response.ok) {
    console.error("[search] Google CSE 응답 비정상:", response.status);
    return [];
  }
  const payload = (await response.json()) as {
    items?: Array<{
      title?: string;
      link?: string; // 이미지 URL
      displayLink?: string;
      image?: { contextLink?: string };
    }>;
  };
  const items = payload.items ?? [];

  const final: ReferenceImage[] = [];
  const seenDomains = new Set<string>();
  const halfThreshold = Math.floor(numResults / 2);

  for (const item of items) {
    const imageUrl = (item.link ?? "").trim();
    const pageUrl = (item.image?.contextLink ?? imageUrl).trim();
    if (!imageUrl) continue;
    const pageDomain = domainOf(pageUrl);
    if (isBlockedDomain(pageDomain)) continue;

    if (pageDomain && seenDomains.has(pageDomain) && final.length >= halfThreshold) {
      continue;
    }
    seenDomains.add(pageDomain);

    final.push({
      title: item.title || "레퍼런스",
      url: pageUrl,
      image_url: imageUrl,
      source: item.displayLink || pageDomain,
    });
    if (final.length >= numResults) break;
  }
  return final;
}

/* ------------------------- 진입점 ------------------------- */

/**
 * 키워드에 맞는 레퍼런스 이미지 후보를 반환한다.
 *
 * 1순위: Google Custom Search (env 설정 시) — 직접 이미지 URL, 가장 신뢰도 높음
 * 2순위: Anthropic web_search → 페이지에서 og:image 병렬 추출 → thum.io 폴백
 *
 * - 빈 keywords → 빈 배열
 * - API 키 없음 / API 호출 실패 → 빈 배열 (UI는 빈 상태로 분기)
 * - 후보 풀은 max(numResults*2, numResults+2)만큼 잘라낸 뒤 og:image 병렬 페치
 * - 결과 image_url은 항상 채워짐 (실패 시 thum.io 스크린샷, challenge면 제외)
 */
export async function searchReferenceImages(
  keywords: string[],
  numResults: number = DEFAULT_NUM_RESULTS,
): Promise<ReferenceImage[]> {
  if (!keywords || keywords.length === 0) {
    return [];
  }

  // 1순위 — Google CSE (env가 있으면)
  const fromGoogle = await searchViaGoogleImages(keywords, numResults);
  if (fromGoogle.length > 0) {
    return fromGoogle;
  }

  // 2순위 — Anthropic web_search → og:image 추출
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
  const extracted = new Map<string, ExtractKind>();
  const settled = await Promise.allSettled(
    candidates.map((c) => extractImageFromPage(c.url)),
  );
  candidates.forEach((cand, idx) => {
    const r = settled[idx];
    if (r.status === "fulfilled") {
      extracted.set(cand.url, r.value);
    } else {
      // 페치 자체 실패는 miss로 취급 → thum.io 폴백 시도
      extracted.set(cand.url, { kind: "miss" });
    }
  });

  return pickWithDomainDiversity(candidates, extracted, numResults);
}
