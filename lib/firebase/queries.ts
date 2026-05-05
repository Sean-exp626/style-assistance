/**
 * Firestore 읽기 헬퍼 — Phase C (`/history`, `/admin`).
 *
 * 책임:
 *  - `hairAnalyses` 컬렉션을 Admin SDK로 조회
 *  - Server Component → Client Component 직렬화 경계에서 안전한 plain object로 변환
 *    (Firestore Timestamp는 클라이언트 boundary를 넘지 못하므로 epoch ms로 변환한다)
 *
 * 호출 측 가정:
 *  - 모든 함수는 Node.js runtime의 Server Component / Route Handler에서만 호출된다
 *  - Edge runtime에서는 import조차 금지 (admin.ts 참조)
 *  - 본인/관리자 권한 체크는 *호출 측의 책임* — 이 모듈은 단순 데이터 접근 계층
 */
import { adminDb } from "@/lib/firebase/admin";
import {
  SIDE_KEYPOINT_NAMES,
  type SideProfileLandmarks,
  type SideProfileMetrics,
} from "@/lib/face-shape";
import type {
  AnalysisResultDoc,
  ProvidedView,
} from "@/lib/firebase/types";
import type { Gender, LengthPreference } from "@/lib/prompts";
import type { ReferenceImage } from "@/lib/search";

/**
 * 직렬화 가능한 형태의 분석 레코드.
 *
 * - `createdAt`은 epoch ms (Firestore Timestamp → toMillis())
 *   → Server Component에서 그대로 client component props로 전달 가능
 * - 그 외 필드는 Firestore 문서와 동일
 */
export interface HairAnalysisRecord {
  id: string;
  uid: string;
  userEmail: string | null;
  userDisplayName: string | null;
  userPhotoURL: string | null;
  /** epoch milliseconds — `new Date(createdAt)`로 복원 */
  createdAt: number;
  durationMs: number;
  gender: Gender;
  lengthPreference: LengthPreference;
  providedViews: ProvidedView[];
  result: AnalysisResultDoc;
  references: ReferenceImage[];
  /** 정면 MediaPipe landmarks (있을 때만). 분류기/시각화 재현에 사용. */
  frontLandmarks?: number[][];
  /** 측면 sparse keypoint (있을 때만). UI에는 노출하지 않는다. */
  sideLandmarks?: SideProfileLandmarks;
  /** 측면 4각도 메트릭 (있을 때만). UI에는 노출하지 않는다. */
  sideMetrics?: SideProfileMetrics;
}

const COLLECTION = "hairAnalyses";
const DEFAULT_USER_LIMIT = 50;
const DEFAULT_ADMIN_LIMIT = 100;

interface FetchAllOptions {
  /** 이메일 부분 일치(대소문자 무시) — 비어있으면 전체 */
  emailFilter?: string;
  limit?: number;
}

/**
 * 특정 사용자의 분석 기록을 최신순으로 반환.
 *
 * 인덱스: `uid ASC + createdAt DESC` (firestore.indexes.json에 배포됨)
 */
export async function fetchUserAnalyses(
  uid: string,
  limit: number = DEFAULT_USER_LIMIT,
): Promise<HairAnalysisRecord[]> {
  const snapshot = await adminDb
    .collection(COLLECTION)
    .where("uid", "==", uid)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map(toRecord);
}

/**
 * 전체 분석 기록을 최신순으로 반환 (관리자 전용).
 *
 * - `emailFilter`는 Firestore where로 처리하지 않는다:
 *   Firestore의 `==`는 대소문자/부분일치를 지원하지 않아 "ge" 같은 부분 입력으로
 *   필터링하려면 클라이언트(여기서는 서버)측 후처리가 가장 단순하고 비용이 작다.
 *   100~200건 규모에서는 in-memory 필터로 충분.
 */
export async function fetchAllAnalyses(
  opts: FetchAllOptions = {},
): Promise<HairAnalysisRecord[]> {
  const { emailFilter, limit = DEFAULT_ADMIN_LIMIT } = opts;

  const snapshot = await adminDb
    .collection(COLLECTION)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const records = snapshot.docs.map(toRecord);
  const needle = emailFilter?.trim().toLowerCase();
  if (!needle) return records;

  return records.filter((r) =>
    (r.userEmail ?? "").toLowerCase().includes(needle),
  );
}

/* ------------------------------ helpers ------------------------------ */

interface FirestoreDocLike {
  id: string;
  data(): Record<string, unknown>;
}

/**
 * Firestore DocSnapshot → 직렬화 가능 record.
 *
 * 누락 필드는 보수적인 기본값으로 채워서 UI가 깨지지 않도록 한다 (legacy doc 대비).
 */
function toRecord(doc: FirestoreDocLike): HairAnalysisRecord {
  const data = doc.data();
  return {
    id: doc.id,
    uid: stringField(data.uid),
    userEmail: nullableString(data.userEmail),
    userDisplayName: nullableString(data.userDisplayName),
    userPhotoURL: nullableString(data.userPhotoURL),
    createdAt: timestampToMillis(data.createdAt),
    durationMs: typeof data.durationMs === "number" ? data.durationMs : 0,
    gender: (data.gender as Gender) ?? "여성",
    lengthPreference: (data.lengthPreference as LengthPreference) ?? "현재 유지",
    providedViews: Array.isArray(data.providedViews)
      ? (data.providedViews as ProvidedView[])
      : [],
    result: ((): AnalysisResultDoc => {
      const raw = data.result;
      // legacy doc 안전망 — result 필드 자체가 없으면 빈 골격 반환
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return {
          face_shape: "",
          head_shape: "",
          recommended_style: { name: "", length: "", key_features: [] },
          professional_analysis: "",
          search_keywords: [],
        };
      }
      // V1 추가 필드 side_keypoints 방어적 파싱: 형식이 깨졌어도 history UI를 깨뜨리지 않는다.
      const base = raw as AnalysisResultDoc & Record<string, unknown>;
      const sideKp = parseSideKeypointsField(base.side_keypoints);
      // Firestore에 저장된 실제 키만 보존 — undefined면 결과 객체에서 키 자체를 빼준다.
      if (sideKp === undefined) {
        const { side_keypoints: _omit, ...rest } = base;
        void _omit;
        return rest as AnalysisResultDoc;
      }
      return { ...base, side_keypoints: sideKp };
    })(),
    references: Array.isArray(data.references)
      ? (data.references as ReferenceImage[])
      : [],
    frontLandmarks: Array.isArray(data.frontLandmarks)
      ? (data.frontLandmarks as number[][])
      : undefined,
    sideLandmarks: parseSideLandmarksField(data.sideLandmarks),
    sideMetrics: parseSideMetricsField(data.sideMetrics),
  };
}

/**
 * Firestore에 저장된 sideLandmarks 필드를 안전하게 복원한다.
 * - 형식이 맞지 않으면 undefined (예외 throw 금지 — 한 문서 망가졌다고 history UI를 깨뜨리지 않음).
 */
function parseSideLandmarksField(v: unknown): SideProfileLandmarks | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const yaw = obj.yaw;
  if (yaw !== "left" && yaw !== "right" && yaw !== "near-frontal") return undefined;
  const kpRaw = obj.keypoints;
  if (!kpRaw || typeof kpRaw !== "object" || Array.isArray(kpRaw)) return undefined;
  const out: SideProfileLandmarks["keypoints"] = {};
  for (const [k, val] of Object.entries(kpRaw as Record<string, unknown>)) {
    if (!(SIDE_KEYPOINT_NAMES as readonly string[]).includes(k)) return undefined;
    if (
      !Array.isArray(val) ||
      val.length !== 3 ||
      !val.every((n) => typeof n === "number" && Number.isFinite(n))
    ) {
      return undefined;
    }
    out[k as keyof SideProfileLandmarks["keypoints"]] = val as [number, number, number];
  }
  return { yaw, keypoints: out };
}

/**
 * Firestore `result.side_keypoints` 필드를 안전하게 복원한다.
 *
 * 반환 규약 (Firestore의 3-state 표현을 그대로 보존):
 *   - 입력이 명시적 `null`     → `null`           (모델이 자신 없음)
 *   - 입력이 undefined/형식깨짐 → `undefined`     (legacy doc 또는 손상 → 키 자체 제거)
 *   - 입력이 정상 객체         → 7-key 화이트리스트 + [0,1] 검증한 부분 객체
 *
 * 살아남은 키가 0개면 `undefined`로 떨어뜨려 UI가 빈 객체를 처리하지 않게 한다.
 */
function parseSideKeypointsField(
  v: unknown,
):
  | NonNullable<AnalysisResultDoc["side_keypoints"]>
  | null
  | undefined {
  if (v === null) return null;
  if (v === undefined || typeof v !== "object" || Array.isArray(v)) return undefined;

  const allowed = [
    "forehead",
    "nose_bridge",
    "nose_tip",
    "philtrum",
    "lower_lip",
    "chin",
    "ear_front",
  ] as const;
  const obj = v as Record<string, unknown>;
  const out: NonNullable<AnalysisResultDoc["side_keypoints"]> = {};
  let any = false;
  for (const key of allowed) {
    const val = obj[key];
    if (!val || typeof val !== "object" || Array.isArray(val)) continue;
    const xy = val as Record<string, unknown>;
    const x = xy.x;
    const y = xy.y;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      x >= 0 &&
      x <= 1 &&
      y >= 0 &&
      y <= 1
    ) {
      out[key] = { x, y };
      any = true;
    }
  }
  return any ? out : undefined;
}

function parseSideMetricsField(v: unknown): SideProfileMetrics | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const obj = v as Record<string, unknown>;
  const allowed = [
    "nasofrontal_angle",
    "mentolabial_angle",
    "facial_convexity",
    "jaw_angle",
  ] as const;
  const out: SideProfileMetrics = {};
  let any = false;
  for (const key of allowed) {
    const val = obj[key];
    if (val === undefined) continue;
    if (typeof val === "number" && Number.isFinite(val) && val >= 0 && val <= 180) {
      out[key] = val;
      any = true;
    }
  }
  return any ? out : undefined;
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function nullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === "string" ? v : null;
}

/**
 * Firestore Timestamp → epoch ms.
 *
 * Admin SDK Timestamp는 `toMillis()` 보유. 일부 legacy 문서가 raw Date/number로
 * 들어있을 가능성에 대비해 방어적으로 처리.
 */
function timestampToMillis(v: unknown): number {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  if (typeof maybe.seconds === "number") {
    return maybe.seconds * 1000 + Math.floor((maybe.nanoseconds ?? 0) / 1e6);
  }
  return 0;
}
