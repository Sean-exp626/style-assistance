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
 *
 * 봇 차단 차단 (캡차/봇 보호 페이지의 og:image가 갤러리 카드로 새는 것 방지):
 *   - HTTP status 403/429/503 → challenge
 *   - Cloudflare 헤더(`cf-mitigated`, `cf-chl-bypass`) + Cloudflare 쿠키만 있고 본문이 짧으면 challenge
 *   - HTML 본문에 캡차 시그니처(영어/한국어 모두) → challenge
 *   - 추출된 og:image URL이 캡차 CDN / 로고/플레이스홀더 키워드면 challenge로 격하
 */

const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 200 * 1024; // 200KB
const SHORT_BODY_THRESHOLD = 5 * 1024; // 5KB — Cloudflare 인터스티셜이 보통 이 이하
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
 *
 * 200KB 잘림 + Cloudflare는 <head>에 og:image를 두는 구조라, body 시그니처만 보면
 * 캡차 페이지의 og:image가 그대로 통과되는 사고가 있었다. 이제 응답 전체 + <head>를
 * 별도로 검사한다.
 */
const CHALLENGE_SIGNATURES: readonly RegExp[] = [
  // 영어 캡차 / 봇 보호 (Cloudflare, hCaptcha, reCAPTCHA, 일반)
  /Just a moment\.{3}/i,
  /Checking your browser/i,
  /Verifying you are human/i,
  /Sign in to confirm you/i, // YouTube
  /cf-challenge-running/i, // Cloudflare class
  /challenge-platform/i, // Cloudflare 신형 인터스티셜
  /Performing security verification/i,
  /Please complete the security check/i,
  /are you a robot/i,
  /attention required/i, // Cloudflare 1020 차단 페이지 타이틀
  /Captcha required/i,
  /__cf_chl_/i, // Cloudflare challenge 쿼리/쿠키
  /_cf_chl_opt/i, // 신형 challenge 글로벌
  /data-cf-beacon/i, // Cloudflare bot mgmt 비콘
  /\bCloudflare\b[^<]{0,40}(Ray ID|to access)/i, // 차단 footer 패턴

  // 한국어 캡차 / 차단 / 인증 인터스티셜
  /자동등록방지/, // 일반 PHP 게시판/스팸 차단
  /로봇이\s*아닙니다/, // reCAPTCHA 한글 라벨
  /보안\s*인증/,
  /접근이\s*제한/, // "접근이 제한되었습니다" 류
  /비정상적인\s*접근/,
] as const;

function looksLikeChallenge(html: string): boolean {
  for (const re of CHALLENGE_SIGNATURES) {
    if (re.test(html)) return true;
  }
  return false;
}

/**
 * 응답 헤더만으로 봇 차단을 판정.
 * Cloudflare는 본문을 못 받기 전에 헤더로 신호를 주는 경우가 많다.
 */
function looksLikeChallengeHeaders(response: Response): boolean {
  const h = response.headers;
  if (h.get("cf-mitigated")) return true;
  if (h.get("cf-chl-bypass")) return true;

  const status = response.status;
  const server = (h.get("server") || "").toLowerCase();
  if (server.includes("cloudflare") && (status === 403 || status === 429 || status === 503)) {
    return true;
  }
  return false;
}

/**
 * og:image URL 자체가 캡차/로고/플레이스홀더로 보이는 경우 거부한다.
 * head 영역을 검사해도 일부 캡차 페이지(예: hcaptcha/recaptcha frame)의
 * og:image는 외부 CDN 호스팅이라 시그니처로 못 잡힌다.
 */
const CHALLENGE_IMAGE_HOST_PATTERNS: readonly RegExp[] = [
  /(^|\.)challenges\.cloudflare\.com$/i,
  /(^|\.)hcaptcha\.com$/i,
  /(^|\.)recaptcha\.net$/i,
  /(^|\.)gstatic\.com$/i, // reCAPTCHA 자산 호스트
] as const;

const PLACEHOLDER_PATH_KEYWORDS: readonly string[] = [
  "logo",
  "favicon",
  "default",
  "placeholder",
  "og-default",
  "share-default",
  "no-image",
  "blank",
  "spacer",
  "transparent",
  "1x1",
] as const;

function isUnusableImageUrl(imageUrl: string): boolean {
  if (!imageUrl) return true;
  // data URI / 1픽셀 GIF는 유의미한 썸네일이 아님
  if (imageUrl.startsWith("data:")) return true;

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return true;
  }

  const host = parsed.host.toLowerCase();
  for (const re of CHALLENGE_IMAGE_HOST_PATTERNS) {
    if (re.test(host)) return true;
  }

  // path + filename 키워드 매칭. 쿼리스트링에 우연히 'logo' 들어가는 케이스 회피하기 위해
  // pathname만 본다.
  const path = parsed.pathname.toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? "";
  for (const kw of PLACEHOLDER_PATH_KEYWORDS) {
    if (lastSegment.includes(kw)) return true;
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
 *
 * 누적 바이트 수도 함께 돌려준다 — Cloudflare 인터스티셜처럼 본문이 5KB 미만일 때
 * 헤더와 결합해 challenge 판정에 쓴다.
 */
async function readLimited(response: Response): Promise<{ html: string; bytes: number }> {
  if (!response.body) {
    return { html: "", bytes: 0 };
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
  return { html, bytes: received };
}

/**
 * Cloudflare 보호 쿠키만 있고 본문이 짧으면 인터스티셜로 간주.
 * Set-Cookie는 Headers.getSetCookie()로 노출되지만 일부 런타임은 안 줘서 raw도 본다.
 */
function hasOnlyCloudflareCookies(response: Response): boolean {
  const setCookies: string[] = [];
  const getter = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getter === "function") {
    setCookies.push(...getter.call(response.headers));
  } else {
    const raw = response.headers.get("set-cookie");
    if (raw) setCookies.push(raw);
  }
  if (setCookies.length === 0) return false;
  return setCookies.every((c) => /__cf_bm|cf_clearance/i.test(c));
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

  // 헤더 단계 차단: Cloudflare/봇 차단은 본문보다 헤더가 더 정확하다
  if (looksLikeChallengeHeaders(response)) {
    response.body?.cancel().catch(() => {});
    return { kind: "challenge" };
  }

  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    if (
      response.status === 403 ||
      response.status === 429 ||
      response.status === 503
    ) {
      return { kind: "challenge" };
    }
    return { kind: "miss" };
  }

  const { html, bytes } = await readLimited(response);
  if (!html) return { kind: "miss" };

  // Cloudflare 쿠키 + 짧은 본문 = 인터스티셜
  if (bytes < SHORT_BODY_THRESHOLD && hasOnlyCloudflareCookies(response)) {
    return { kind: "challenge" };
  }

  // <head>를 우선 검사 — Cloudflare 인터스티셜은 head에 og:image와 함께
  // 캡차 시그니처를 두는 경우가 있다 (200KB 자르기 전에 잡아내야 함)
  const headEnd = html.search(/<\/head>/i);
  const headBlock = headEnd >= 0 ? html.slice(0, headEnd) : html.slice(0, Math.min(html.length, 32 * 1024));
  if (looksLikeChallenge(headBlock)) {
    return { kind: "challenge" };
  }

  // 전체 본문 시그니처도 함께 확인
  if (looksLikeChallenge(html)) {
    return { kind: "challenge" };
  }

  for (const regex of EXTRACT_REGEXES) {
    const match = html.match(regex);
    if (match && match[1]) {
      const resolved = resolveUrl(pageUrl, match[1]);
      // og:image가 추출돼도 캡차 CDN / 로고 / 플레이스홀더면 challenge로 격하.
      // 본문 시그니처를 회피한 캡차 페이지의 마지막 안전망.
      if (isUnusableImageUrl(resolved)) {
        return { kind: "challenge" };
      }
      return { kind: "ok", url: resolved };
    }
  }
  return { kind: "miss" };
}
