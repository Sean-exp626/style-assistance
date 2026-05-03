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

  const heic2any = (await import("heic2any")).default;
  const result = await heic2any({
    blob: file,
    toType: "image/jpeg",
    quality: 0.9,
  });
  const jpegBlob = Array.isArray(result) ? result[0] : result;

  const newName = file.name.replace(HEIC_EXT_RE, ".jpg");
  return new File([jpegBlob], newName, { type: "image/jpeg" });
}
