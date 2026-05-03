/**
 * 이미지 클라이언트 리사이즈 유틸.
 *
 * Streamlit 원본 `utils.py`의 `to_jpeg_bytes` 알고리즘을 브라우저 canvas로 포팅:
 * - long-edge 1568px 이하로 다운스케일 (원본보다 작으면 그대로)
 * - JPEG quality 0.9로 재인코딩
 * - EXIF 회전은 `createImageBitmap`의 `imageOrientation: "from-image"` 옵션이 자동 처리
 *
 * 클라이언트 처리 이유: Vercel Function payload(=4.5MB body) + 메모리 비용을 줄이고,
 * 모바일에서 큰 사진을 그대로 업로드해 네트워크가 막히는 것을 방지.
 */

const MAX_LONG_EDGE_PX = 1568;
const JPEG_QUALITY = 0.9;

/**
 * `file`을 EXIF 보정 + long-edge 1568px 이하로 리사이즈한 JPEG `File`로 반환.
 * 이미 작은 파일도 통일된 JPEG로 정규화하여 서버측 MIME 처리 분기를 단순화한다.
 */
export async function resizeImage(
  file: File,
  maxLongEdge: number = MAX_LONG_EDGE_PX,
  quality: number = JPEG_QUALITY,
): Promise<File> {
  // Safari 일부 환경에서 imageOrientation 옵션이 누락되면 EXIF 회전이 안 되지만,
  // 최신 iOS 16+/Chrome/Edge 모두 지원하므로 Phase 1 기준 OK.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    // iOS 구버전이나 일부 환경에서 imageOrientation 옵션 미지원 → 옵션 없이 재시도
    try {
      bitmap = await createImageBitmap(file);
    } catch (innerErr) {
      const detail = innerErr instanceof Error ? innerErr.message : String(innerErr);
      throw new Error(
        `사진을 불러올 수 없습니다 (${detail}). 다른 사진으로 시도해 주세요.`,
      );
    }
  }
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;

  const targetWidth = Math.round(bitmap.width * scale);
  const targetHeight = Math.round(bitmap.height * scale);

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(targetWidth, targetHeight)
      : Object.assign(document.createElement("canvas"), {
          width: targetWidth,
          height: targetHeight,
        });

  const ctx = canvas.getContext("2d") as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error("Canvas 2D 컨텍스트를 생성할 수 없습니다.");
  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  bitmap.close();

  const blob = await canvasToBlob(canvas, "image/jpeg", quality);
  const newName = file.name.replace(/\.(png|webp|heic|heif|jpe?g)$/i, ".jpg");
  return new File([blob], newName, { type: "image/jpeg" });
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if (canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("이미지 인코딩에 실패했습니다."))),
      type,
      quality,
    );
  });
}
