/**
 * HEIC → JPEG 변환 (클라이언트 전용).
 *
 * iPhone 카메라 사진은 기본 HEIC 포맷이고 Anthropic Vision은 이를 지원하지 않는다.
 * `heic2any`는 번들이 무거우므로 동적 import로 코드 스플리팅한다.
 *
 * Phase 1 결정: 변환은 클라이언트에서 수행 → Vercel 서버리스 메모리 한도 보호.
 * Streamlit 원본은 서버측 Pillow + pillow_heif로 처리했지만, 서버리스 콜드스타트와
 * 메모리 비용을 고려해 책임을 클라이언트로 옮긴다.
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
    const heic2any = (await import("heic2any")).default;
    const result = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });
    const jpegBlob = Array.isArray(result) ? result[0] : result;
    const newName = file.name.replace(HEIC_EXT_RE, ".jpg");
    return new File([jpegBlob], newName, { type: "image/jpeg" });
  } catch (err: unknown) {
    // heic2any는 실패 시 {code, message} plain object를 throw → Error로 정규화
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
