/**
 * HEIC → JPEG 변환 (클라이언트 전용).
 *
 * iPhone 카메라 사진은 기본 HEIC 포맷이고 Anthropic Vision은 이를 지원하지 않는다.
 * `heic-to`는 libheif-js WASM 기반으로 iPhone의 최신 HEIC 변형(HEVC multi-frame, HDR 등)
 * 까지 폭넓게 지원한다. 번들이 크므로 동적 import로 코드 스플리팅한다.
 *
 * Phase 1 결정: 변환은 클라이언트에서 수행 → Vercel 서버리스 메모리 한도 보호.
 * (이전에 사용하던 heic2any는 ERR_LIBHEIF format not supported로 실패하는
 *  케이스가 많아 heic-to로 교체했다.)
 */

const HEIC_EXT_RE = /\.heic$|\.heif$/i;
const HEIC_MIMES = new Set(["image/heic", "image/heif"]);

export function isHeic(file: File): boolean {
  if (HEIC_MIMES.has(file.type.toLowerCase())) return true;
  // iOS Safari가 빈 type을 보낼 때를 대비해 확장자도 체크
  return HEIC_EXT_RE.test(file.name);
}

export async function convertHeicToJpeg(file: File): Promise<File> {
  if (!isHeic(file)) return file;

  try {
    const { heicTo } = await import("heic-to");
    const jpegBlob = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: 0.9,
    });
    const newName = file.name.replace(HEIC_EXT_RE, ".jpg");
    return new File([jpegBlob], newName, { type: "image/jpeg" });
  } catch (err: unknown) {
    // 일부 라이브러리는 plain object를 throw → Error로 정규화
    const detail = extractMessage(err);
    throw new Error(
      `HEIC 사진 변환에 실패했습니다 (${detail}). ` +
        `iPhone 설정 → 카메라 → 포맷에서 '호환성 우선'으로 바꾼 뒤 다시 촬영하시거나, ` +
        `사진 앱에서 JPG로 내보낸 파일을 업로드해 주세요.`,
    );
  }
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "알 수 없음";
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.code !== "undefined") return `code=${String(obj.code)}`;
  }
  return "알 수 없음";
}
