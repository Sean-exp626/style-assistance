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
    result: (data.result as AnalysisResultDoc) ?? {
      face_shape: "",
      head_shape: "",
      recommended_style: { name: "", length: "", key_features: [] },
      professional_analysis: "",
      search_keywords: [],
    },
    references: Array.isArray(data.references)
      ? (data.references as ReferenceImage[])
      : [],
  };
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
