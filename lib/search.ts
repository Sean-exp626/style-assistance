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
 * 봇 차단(YouTube/Cloudflare 등)으로 og:image도 thum.io 스크린샷도
 * 의미 있는 헤어 사진 대신 "확인 페이지" 스크린샷을 반환하는 도메인.
 * 결과에서 제외해 갤러리 품질을 유지한다.
 */
const BLOCKED_DOMAINS = new Set([
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
 * 검색 프롬프트 — 헤어 사진 og:image가 잘 잡히는 페이지 위주로 유도.
 *
 * - 네이버 블로그 / Pinterest / Instagram 포스트 / 헤어샵 사이트 / 매거진 위주
 * - YouTube / 위키 / SNS 캡차 페이지는 봇 차단 때문에 의미 없는 이미지가 잡혀 제외
 */
function buildSearchPrompt(keywords: string[], numResults: number): string {
  const keywordBlock = keywords.map((kw) => `"${kw}"`).join(", ");
  const minHits = Math.max(numResults * 2, 10);
  return (
    "다음 헤어스타일 키워드로 **헤어 사진이 본문에 직접 박혀 있는 한국 페이지**를 찾아 주세요.\n\n" +
    `키워드: ${keywordBlock}\n\n` +
    "우선순위가 높은 출처:\n" +
    "- 네이버 블로그 (blog.naver.com) — 헤어 시술 후기 포스트\n" +
    "- Pinterest (pinterest.com / kr.pinterest.com) — 헤어 핀\n" +
    "- 헤어샵/디자이너 사이트 (designersays, juno hair, chahong 등) — 시술 사례 페이지\n" +
    "- 패션/뷰티 매거진 (allure, elle, vogue, marieclaire 등) — 헤어 기사\n" +
    "- 티스토리 / 브런치 / 다음 카페 — 헤어 후기 글\n\n" +
    "**제외할 출처 (반드시 검색 결과에 포함하지 마세요)**:\n" +
    "- youtube.com / m.youtube.com / youtu.be (봇 차단으로 썸네일 추출 불가)\n" +
    "- namu.wiki / wikipedia.org (백과사전, 대표 이미지가 헤어 사진 아님)\n" +
    "- tiktok.com / facebook.com / twitter.com / x.com (캡차 페이지)\n\n" +
    `web_search 도구로 최소 ${minHits}건 이상의 결과를 모으되, 위 우선 출처에서 골고루 ` +
    "다양한 도메인에서 가져와 주세요. 영상이 아닌 사진 게시물 위주로."
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
