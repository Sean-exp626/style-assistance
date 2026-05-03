/**
 * 페이지 HTML에서 대표 이미지를 추출.
 *
 * Streamlit 원본 `search_logic.py`의 `_extract_image_from_page` + `_resolve_url`을
 * TypeScript로 포팅한 모듈. 의존성을 늘리지 않기 위해 cheerio/jsdom 같은 HTML 파서 대신
 * 정규식 4단계 (og:image / og:image:secure_url / twitter:image / 첫 <img>)만 사용한다.
 *
 * 추출 우선순위:
 *   1) <meta property="og:image" content="..."> (og:image:secure_url 포함)
 *   2) 같은 의미지만 속성 순서가 뒤바뀐 경우 (content가 먼저 오는 패턴)
 *   3) <meta name="twitter:image" content="...">
 *   4) 본문 첫 <img src="...jpg|jpeg|png|webp">
 *
 * 모든 단계에서 추출 실패 시 `null` 반환 (throw 금지). 호출 측에서 thum.io 폴백을 사용.
 *
 * 안정성:
 *   - 4초 타임아웃 (`AbortSignal.timeout(4000)`)
 *   - 응답 본문은 200KB만 읽고 reader.cancel()로 조기 종료 (긴 페이지 방어)
 *   - HTTP 에러 / 네트워크 에러 모두 null로 정상 종료
 */

const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 200 * 1024; // 200KB
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/17.0 Safari/605.1.15 KAI-JUNG-HAIR-StyleBot/1.0";

const OG_IMAGE_RE_1 =
  /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i;
const OG_IMAGE_RE_2 =
  /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i;
const TWITTER_IMAGE_RE =
  /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i;
const FIRST_IMG_RE =
  /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp))/i;

const EXTRACT_REGEXES: readonly RegExp[] = [
  OG_IMAGE_RE_1,
  OG_IMAGE_RE_2,
  TWITTER_IMAGE_RE,
  FIRST_IMG_RE,
] as const;

/**
 * 봇 차단/캡차 페이지 시그니처. 이 패턴이 HTML에 보이면 og:image를 뽑아도
 * 의미 없는 캡차/사인인 페이지 이미지일 가능성이 높아 추출을 포기한다.
 * (호출 측에서도 thum.io 폴백을 건너뛰도록 별도 시그널을 줘야 함)
 */
const CHALLENGE_SIGNATURES: readonly RegExp[] = [
  /Just a moment\.{3}/i,
  /Checking your browser/i,
  /Verifying you are human/i,
  /Sign in to confirm you/i, // YouTube
  /cf-challenge-running/i, // Cloudflare class
  /Please complete the security check/i,
  /are you a robot/i,
  /Captcha required/i,
  /__cf_chl_/i, // Cloudflare challenge query/cookie
] as const;

function looksLikeChallenge(html: string): boolean {
  for (const re of CHALLENGE_SIGNATURES) {
    if (re.test(html)) return true;
  }
  return false;
}

/**
 * 상대 URL을 절대 URL로 보정한다.
 *
 * - 이미 절대 URL이면 그대로 반환
 * - `//cdn.example.com/...` → `https://cdn.example.com/...`
 * - `/path` → `{scheme}://{host}/path`
 * - `relative` → `{scheme}://{host}/relative`
 *
 * `base`가 잘못된 URL이라 호스트를 알 수 없으면 `target`을 그대로 돌려준다.
 */
export function resolveUrl(base: string, target: string): string {
  if (!target) return "";
  const trimmed = target.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return "https:" + trimmed;
  }

  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
  } catch {
    return trimmed;
  }
  if (!parsedBase.host) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `${parsedBase.protocol}//${parsedBase.host}${trimmed}`;
  }
  return `${parsedBase.protocol}//${parsedBase.host}/${trimmed}`;
}

/**
 * Response body를 streaming으로 읽되 최대 `MAX_HTML_BYTES`까지만 누적한다.
 * 본문이 그보다 크면 reader.cancel()을 호출해 다운로드를 끊는다.
 */
async function readLimited(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let html = "";
  let received = 0;
  try {
    while (received < MAX_HTML_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (received >= MAX_HTML_BYTES) {
        await reader.cancel().catch(() => {
          /* swallow */
        });
        break;
      }
    }
    html += decoder.decode();
  } catch {
    // 스트림 도중 에러는 지금까지 받은 만큼만 반환
  }
  return html;
}

/**
 * 추출 결과 — image_url 또는 명시적 차단(challenge) 시그널.
 *
 * - `{ kind: "ok", url }` 정상 추출
 * - `{ kind: "challenge" }` 봇 차단/캡차 페이지 → thum.io 폴백도 무의미하므로 호출 측이
 *   결과에서 아예 제외하도록 한다
 * - `{ kind: "miss" }` 페이지는 정상이지만 og:image 등을 못 찾음 → thum.io 폴백 시도 가능
 */
export type ExtractResult =
  | { kind: "ok"; url: string }
  | { kind: "challenge" }
  | { kind: "miss" };

/**
 * 페이지 URL에서 대표 이미지를 한 장 추출한다.
 *
 * - 정상 추출 → `{kind: "ok", url}`
 * - 페이지 자체가 봇 차단/캡차 → `{kind: "challenge"}` (thum.io 폴백도 같은 페이지를 찍을 가능성 높아 제외 권장)
 * - 페이지 정상이지만 메타 이미지 없음 → `{kind: "miss"}` (호출 측에서 thum.io 폴백 사용 가능)
 * - HTTP/네트워크 실패 → `{kind: "miss"}`
 */
export async function extractImageFromPage(pageUrl: string): Promise<ExtractResult> {
  let response: Response;
  try {
    response = await fetch(pageUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ko,en;q=0.9",
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      },
    });
  } catch {
    return { kind: "miss" };
  }

  if (!response.ok) {
    // 본문을 읽지 않더라도 connection 누수를 막기 위해 정리
    response.body?.cancel().catch(() => {});
    // 403/503은 보통 봇 차단 응답
    if (response.status === 403 || response.status === 503) {
      return { kind: "challenge" };
    }
    return { kind: "miss" };
  }

  const html = await readLimited(response);
  if (!html) return { kind: "miss" };

  // 봇 차단 페이지면 og:image도 의미 없는 캡차 이미지일 가능성 높음
  if (looksLikeChallenge(html)) {
    return { kind: "challenge" };
  }

  for (const regex of EXTRACT_REGEXES) {
    const match = html.match(regex);
    if (match && match[1]) {
      return { kind: "ok", url: resolveUrl(pageUrl, match[1]) };
    }
  }
  return { kind: "miss" };
}
