"use client";

/**
 * TEAM COCONUT · Hair Style Assistant
 *
 * Phase 3 — 디자인 전면 재구성.
 *
 * 페이지 구성:
 *  1) 브랜드 영역(헤더): 인라인 SVG 코코넛 마크 + 워드마크 + 태그라인 + 페이지 타이틀
 *  2) 상담 카드: 3개 PhotoUploader 그리드 + SegmentedControl(성별) + ChipGroup(기장) + CTA
 *  3) 결과 영역: 빈 상태 / 로딩 스켈레톤 / 분석 탭 (ANALYSIS / KEYWORDS / REFERENCES)
 *
 * 책임 분리:
 *  - 페이지는 "조립 + 폼 상태 관리"만. 시각 컴포넌트는 모두 외부 파일로 분리.
 *  - 분석 응답의 `search_keywords`로 자동 체이닝하여 References 탭이 곧바로 채워진다.
 */

import { useEffect, useMemo, useState, useTransition } from "react";
import { ArrowRight, Loader2, Quote, Sparkles } from "lucide-react";

import { ChipGroup } from "@/components/chip-group";
import { CoconutLogo, CoconutWordmark } from "@/components/coconut-logo";
import { FaceMeshOverlay } from "@/components/face-mesh-overlay";
import { FaceShapeClassifier } from "@/components/face-shape-classifier";
import { PhotoUploader } from "@/components/photo-uploader";
import { ReferenceGallery } from "@/components/reference-gallery";
import { SegmentedControl } from "@/components/segmented-control";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { classifyFaceShape } from "@/lib/face-shape";
import { convertHeicToJpeg } from "@/lib/heic";
import { resizeImage } from "@/lib/image-utils";
import type {
  AnalysisResult,
  Gender,
  LengthPreference,
  ViewKey,
} from "@/lib/prompts";
import type { ReferenceImage } from "@/lib/search";

/* -------------------------- 정적 매핑 / 옵션 -------------------------- */

const VIEW_LABELS: Record<ViewKey, string> = {
  front: "정면",
  side: "측면",
  back: "뒷면",
};

const VIEW_HINTS: Record<ViewKey, string> = {
  front: "얼굴이 정면을 향한 사진",
  side: "옆모습이 보이는 사진",
  back: "뒤통수가 보이는 사진",
};

const VIEW_KEYS: readonly ViewKey[] = ["front", "side", "back"] as const;

const GENDER_OPTIONS = [
  { value: "여성" as Gender, label: "여성" },
  { value: "남성" as Gender, label: "남성" },
] as const;

const LENGTH_OPTIONS = [
  { value: "현재 유지" as LengthPreference, label: "현재 유지" },
  { value: "더 짧게" as LengthPreference, label: "더 짧게" },
  { value: "더 길게" as LengthPreference, label: "더 길게" },
] as const;

interface AnalyzeResponse {
  result: AnalysisResult;
  providedViews: ViewKey[];
  /** Firestore에 저장된 분석 문서 ID. write 실패 시 undefined일 수 있다. */
  analysisId?: string;
}

/* ============================== Page ============================== */

export default function Home() {
  const [files, setFiles] = useState<Partial<Record<ViewKey, File>>>({});
  const [gender, setGender] = useState<Gender>("여성");
  const [lengthPref, setLengthPref] = useState<LengthPreference>("현재 유지");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [references, setReferences] = useState<ReferenceImage[] | null>(null);
  const [isLoadingRefs, setIsLoadingRefs] = useState(false);
  const [isPending, startTransition] = useTransition();
  /**
   * 정면 사진의 MediaPipe FaceLandmarker 결과 (478개 트리플렛).
   * PhotoUploader 안의 FaceMeshOverlay에서 흘러 들어와 onSubmit이 폼에 동봉.
   */
  const [frontLandmarks, setFrontLandmarks] = useState<number[][] | null>(null);
  /**
   * 분석 결과 패널의 mesh 재현용 ObjectURL.
   * - PhotoUploader가 만든 미리보기 URL은 file 변경 시점에 revoke되어 결과 패널에 살릴 수 없다.
   * - 따라서 onSubmit 시점에 resized JPEG에서 별도 ObjectURL을 만들어 부모가 직접 관리한다.
   * - 다음 분석/언마운트 시 revoke.
   */
  const [frontPreviewUrl, setFrontPreviewUrl] = useState<string | null>(null);
  const [sidePreviewUrl, setSidePreviewUrl] = useState<string | null>(null);

  // 컴포넌트 unmount 시 ObjectURL 해제
  useEffect(() => {
    return () => {
      if (frontPreviewUrl) URL.revokeObjectURL(frontPreviewUrl);
      if (sidePreviewUrl) URL.revokeObjectURL(sidePreviewUrl);
    };
    // unmount 시점의 최신 URL을 잡기 위한 ref 패턴이 깔끔하지만, 단일 페이지 라우트라
    // unmount 빈도가 낮아 effect cleanup의 stale closure 위험은 무시 가능.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasAnyFile = useMemo(
    () => VIEW_KEYS.some((k) => files[k] !== undefined),
    [files],
  );

  function onPickFile(view: ViewKey, file: File | null) {
    setFiles((prev) => {
      const next = { ...prev };
      if (file) next[view] = file;
      else delete next[view];
      return next;
    });
  }

  async function fetchReferences(keywords: string[], analysisId?: string) {
    setIsLoadingRefs(true);
    try {
      const res = await fetch("/api/references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // analysisId 동봉 → 서버가 hairAnalyses 문서의 references 필드를 보강한다.
        body: JSON.stringify({ keywords, num_results: 5, analysisId }),
      });
      const json = (await res.json()) as {
        references?: ReferenceImage[];
        error?: string;
      };
      setReferences(json.references ?? []);
    } catch (err) {
      console.error("References fetch failed:", err);
      setReferences([]);
    } finally {
      setIsLoadingRefs(false);
    }
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setResult(null);
    setReferences(null);
    setIsLoadingRefs(false);
    if (!hasAnyFile) {
      setError("정면 / 측면 / 뒷면 중 최소 한 장의 사진이 필요합니다.");
      return;
    }

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("gender", gender);
        formData.set("length", lengthPref);

        // 결과 패널 mesh 재현용 — 직전 URL 해제 후 정면/측면 슬롯의 resized blob에서 새 URL 발급
        let nextFrontPreviewUrl: string | null = null;
        let nextSidePreviewUrl: string | null = null;

        for (const view of VIEW_KEYS) {
          const original = files[view];
          if (!original) continue;
          // HEIC → JPEG → long-edge 1568px 리사이즈
          const jpeg = await convertHeicToJpeg(original);
          const resized = await resizeImage(jpeg);
          formData.set(view, resized);
          if (view === "front") {
            nextFrontPreviewUrl = URL.createObjectURL(resized);
          } else if (view === "side") {
            nextSidePreviewUrl = URL.createObjectURL(resized);
          }
        }

        // landmarks를 잡았으면 동봉 (없으면 서버는 silent ignore)
        if (frontLandmarks) {
          formData.set("frontLandmarks", JSON.stringify(frontLandmarks));
        }

        // 직전 URL revoke 후 새 URL 보관
        setFrontPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextFrontPreviewUrl;
        });
        setSidePreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextSidePreviewUrl;
        });

        const res = await fetch("/api/analyze", {
          method: "POST",
          body: formData,
        });
        const json = (await res.json()) as {
          result?: AnalysisResult;
          providedViews?: ViewKey[];
          analysisId?: string;
          error?: string;
        };
        if (!res.ok || !json.result) {
          throw new Error(json.error ?? "분석에 실패했습니다.");
        }
        setResult({
          result: json.result,
          providedViews: json.providedViews ?? [],
          analysisId: json.analysisId,
        });
        // 분석 성공 → 갤러리 fire-and-forget. analysisId가 있으면 서버가 doc도 보강.
        void fetchReferences(json.result.search_keywords, json.analysisId);
      } catch (err) {
        console.error("Analysis failed:", err);
        let message = "분석 중 알 수 없는 오류가 발생했습니다.";
        if (err instanceof Error && err.message) {
          message = err.message;
        } else if (err && typeof err === "object") {
          const obj = err as Record<string, unknown>;
          if (typeof obj.message === "string" && obj.message.length > 0) {
            message = obj.message;
          } else if (typeof obj.code !== "undefined") {
            message = `오류 코드: ${String(obj.code)}`;
          }
        } else if (typeof err === "string" && err.length > 0) {
          message = err;
        }
        setError(message);
      }
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 pb-24 pt-10 sm:px-8 sm:pt-14 lg:pt-20">
      <BrandHeader />

      <div className="mt-16 sm:mt-24 lg:mt-28">
        <ConsultationCard
          files={files}
          onPickFile={onPickFile}
          gender={gender}
          setGender={setGender}
          lengthPref={lengthPref}
          setLengthPref={setLengthPref}
          isPending={isPending}
          hasAnyFile={hasAnyFile}
          onSubmit={onSubmit}
          onFrontLandmarks={setFrontLandmarks}
        />
      </div>

      {error ? (
        <div className="mt-8">
          <Alert variant="destructive">
            <AlertTitle>분석에 실패했습니다</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      <div className="mt-12">
        {isPending ? (
          <ResultLoading />
        ) : result ? (
          <ResultTabs
            result={result.result}
            providedViews={result.providedViews}
            references={references}
            isLoadingRefs={isLoadingRefs}
            frontPreviewUrl={frontPreviewUrl}
            frontLandmarks={frontLandmarks}
            sidePreviewUrl={sidePreviewUrl}
          />
        ) : !error ? (
          <EmptyState />
        ) : null}
      </div>

      <Footer />
    </main>
  );
}

/* ============================ Sub-views ============================ */

function BrandHeader() {
  return (
    <header className="flex flex-col items-center text-center animate-in fade-in duration-700">
      <CoconutLogo className="h-16 w-16 sm:h-20 sm:w-20" />

      <div className="mt-5 flex items-center gap-3">
        <span className="h-px w-6 bg-border" />
        <CoconutWordmark className="text-[12px] sm:text-[14px]" />
        <span className="h-px w-6 bg-border" />
      </div>

      <p className="mt-3 text-[10px] uppercase tracking-[0.32em] text-muted-foreground sm:text-[11px]">
        AI / AX Driven · Product Innovation · Design
      </p>

      <h1 className="mt-10 font-sans text-[40px] font-bold leading-[0.98] tracking-[-0.035em] text-foreground sm:text-[56px] lg:text-[68px]">
        Hair Style Assistant
      </h1>
      <p className="mt-3 max-w-xl text-sm text-muted-foreground sm:text-[15px]">
        20년 경력 베테랑 원장의 시선으로, 당신의 얼굴형과 두상에 가장 잘 어울리는 스타일을 찾아 드립니다.
      </p>
    </header>
  );
}

interface ConsultationCardProps {
  files: Partial<Record<ViewKey, File>>;
  onPickFile: (view: ViewKey, file: File | null) => void;
  gender: Gender;
  setGender: (g: Gender) => void;
  lengthPref: LengthPreference;
  setLengthPref: (l: LengthPreference) => void;
  isPending: boolean;
  hasAnyFile: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  /** 정면 슬롯의 mesh 검출 결과 콜백 — Home에서 setState를 그대로 흘린다. */
  onFrontLandmarks: (lm: number[][] | null) => void;
}

function ConsultationCard({
  files,
  onPickFile,
  gender,
  setGender,
  lengthPref,
  setLengthPref,
  isPending,
  hasAnyFile,
  onSubmit,
  onFrontLandmarks,
}: ConsultationCardProps) {
  return (
    <section className="animate-in fade-in duration-700">
      <div
        className={cnCard(
          "relative overflow-hidden rounded-2xl border border-border/70 bg-card/80 p-6 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.7)] backdrop-blur-sm sm:p-8 lg:p-10",
        )}
      >
        {/* 카드 상단 - 미세한 틸 라인 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[color:var(--color-tc-accent)]/40 to-transparent" />

        <form className="space-y-10" onSubmit={onSubmit}>
          {/* 사진 업로더 그리드 */}
          <div className="space-y-4">
            <SectionLabel title="Photos" hint="최소 1장 · iPhone HEIC 자동 변환" />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {VIEW_KEYS.map((view) => (
                <PhotoUploader
                  key={view}
                  label={VIEW_LABELS[view]}
                  hint={VIEW_HINTS[view]}
                  file={files[view] ?? null}
                  onChange={(f) => onPickFile(view, f)}
                  // 측면은 업로드 카드에서 시각 분석을 노출하지 않는다 — Consultation
                  // Result 패널의 Side Profile Detection 카드에서만 검출/표시.
                  // 정면(face)/뒷면(head)은 기존 그대로 업로드 시점 시각 피드백 유지.
                  withFaceMesh={view !== "side"}
                  meshMode={view === "back" ? "head" : "face"}
                  onLandmarks={view === "front" ? onFrontLandmarks : undefined}
                />
              ))}
            </div>
          </div>

          {/* 옵션 영역 */}
          <div className="grid gap-8 sm:grid-cols-2">
            <div className="space-y-3">
              <SectionLabel title="Sex" />
              <SegmentedControl<Gender>
                ariaLabel="성별 선택"
                value={gender}
                options={GENDER_OPTIONS}
                onChange={setGender}
              />
            </div>

            <div className="space-y-3">
              <SectionLabel title="Length" />
              <ChipGroup<LengthPreference>
                ariaLabel="기장 변화 선호"
                value={lengthPref}
                options={LENGTH_OPTIONS}
                onChange={setLengthPref}
              />
            </div>
          </div>

          {/* CTA */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isPending || !hasAnyFile}
              className={[
                "group inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl",
                "bg-gradient-to-r from-[color:var(--color-tc-accent)] to-[color:var(--color-tc-accent-hi)]",
                "text-[14px] font-semibold uppercase tracking-[0.18em] text-[color:var(--color-tc-accent-fg)]",
                "shadow-[0_10px_30px_-12px_var(--color-tc-accent)] transition-all",
                "hover:-translate-y-px hover:shadow-[0_14px_36px_-12px_var(--color-tc-accent-hi)]",
                "active:translate-y-0",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
                "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:shadow-[0_10px_30px_-12px_var(--color-tc-accent)]",
              ].join(" ")}
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />
                  분석 중…
                </>
              ) : (
                <>
                  Begin Analysis
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    strokeWidth={2.5}
                  />
                </>
              )}
            </button>
            {!hasAnyFile ? (
              <p className="mt-3 text-center text-[11px] text-muted-foreground">
                정면 · 측면 · 뒷면 중 최소 한 장의 사진을 업로드해 주세요
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}

function SectionLabel({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
        {title}
      </span>
      {hint ? (
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

/* ----------------------- Empty / Loading -------------------------- */

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-border/60 px-6 py-14 text-center animate-in fade-in duration-700">
      <CoconutLogo className="h-10 w-10 opacity-40" />
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
          Awaiting Consultation
        </p>
        <p className="mt-2 text-sm text-muted-foreground/80">
          사진과 옵션을 입력한 뒤 Begin Analysis를 눌러 주세요.
        </p>
      </div>
    </div>
  );
}

function ResultLoading() {
  return (
    <section className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center gap-3">
        <Sparkles
          className="h-4 w-4 text-[color:var(--color-tc-accent-hi)] animate-pulse"
          strokeWidth={2}
        />
        <p className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
          AI Analyzing
        </p>
        <span className="text-[11px] text-muted-foreground">원장님이 사진을 살펴보고 있습니다…</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </section>
  );
}

/* ============================= Result ============================= */

function ResultTabs({
  result,
  providedViews,
  references,
  isLoadingRefs,
  frontPreviewUrl,
  frontLandmarks,
  sidePreviewUrl,
}: {
  result: AnalysisResult;
  providedViews: ViewKey[];
  references: ReferenceImage[] | null;
  isLoadingRefs: boolean;
  frontPreviewUrl: string | null;
  frontLandmarks: number[][] | null;
  sidePreviewUrl: string | null;
}) {
  return (
    <section className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-sans text-2xl font-bold tracking-[-0.025em] sm:text-3xl">
          Consultation Result
        </h2>
        <p className="text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
          Analyzed Views ·{" "}
          {providedViews.length > 0
            ? providedViews.map((v) => VIEW_LABELS[v]).join(" / ")
            : "—"}
        </p>
      </header>

      <Tabs defaultValue="analysis">
        <TabsList variant="line" className="gap-6 border-b border-border/70 px-0">
          {[
            { v: "analysis", l: "Analysis" },
            { v: "keywords", l: "Keywords" },
            { v: "references", l: "References" },
          ].map((t) => (
            <TabsTrigger
              key={t.v}
              value={t.v}
              className="px-0 text-[11px] font-semibold uppercase tracking-[0.28em] text-muted-foreground data-active:text-[color:var(--color-tc-accent-hi)]"
            >
              {t.l}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="analysis" className="mt-8">
          <AnalysisPanel
            result={result}
            frontPreviewUrl={frontPreviewUrl}
            frontLandmarks={frontLandmarks}
            sidePreviewUrl={sidePreviewUrl}
          />
        </TabsContent>

        <TabsContent value="keywords" className="mt-8">
          <KeywordsPanel keywords={result.search_keywords} />
        </TabsContent>

        <TabsContent value="references" className="mt-8">
          <ReferenceGallery refs={references} isLoading={isLoadingRefs} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function AnalysisPanel({
  result,
  frontPreviewUrl,
  frontLandmarks,
  sidePreviewUrl,
}: {
  result: AnalysisResult;
  frontPreviewUrl: string | null;
  frontLandmarks: number[][] | null;
  sidePreviewUrl: string | null;
}) {
  // 4단계 폴백 분류기 — useMemo는 분류 비용이 작아 생략 가능하지만 의도 명시.
  const matched = useMemo(
    () => classifyFaceShape(result, frontLandmarks),
    [result, frontLandmarks],
  );
  return (
    <div className="space-y-6">
      {/* Face Detection — 정면 사진이 있을 때만 mesh 재현 */}
      {frontPreviewUrl ? (
        <Card>
          <CardContent className="space-y-3 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
                Face Detection
              </span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                478 landmarks · MediaPipe
              </span>
            </div>
            <FaceMeshOverlay source={frontPreviewUrl} variant="readonly" />
          </CardContent>
        </Card>
      ) : null}

      {/* Side Profile Detection — 측면 사진이 있을 때만 sparse keypoint mesh 재현 */}
      {sidePreviewUrl ? (
        <Card>
          <CardContent className="space-y-3 p-3 sm:p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
                Side Profile Detection
              </span>
              <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                sparse keypoints · MediaPipe
              </span>
            </div>
            <FaceMeshOverlay
              source={sidePreviewUrl}
              variant="readonly"
              mode="profile"
            />
          </CardContent>
        </Card>
      ) : null}

      {/* Face Shape 6분류 아틀라스 */}
      <FaceShapeClassifier matched={matched} faceShapeText={result.face_shape} />

      {/* 메트릭 카드 3개 */}
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Face Shape" value={result.face_shape} />
        <MetricCard label="Head Profile" value={result.head_shape} />
        <MetricCard
          label="Length"
          value={result.recommended_style.length}
        />
      </div>

      {/* 추천 스타일 */}
      <Card className="overflow-hidden">
        <CardContent className="space-y-5 p-6 sm:p-8">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
              Recommended Style
            </span>
            <h3 className="font-sans text-2xl font-bold tracking-[-0.025em] sm:text-3xl">
              {result.recommended_style.name}
            </h3>
          </div>

          <ul className="space-y-2.5">
            {result.recommended_style.key_features.map((feature, i) => (
              <li key={i} className="flex items-start gap-3 text-[14px] leading-relaxed">
                <span
                  aria-hidden
                  className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-tc-accent-hi)] shadow-[0_0_10px_var(--color-tc-accent)]"
                />
                <span className="text-foreground/90">{feature}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 원장님 한 마디 — 좌측 틸 보더 인용 스타일 */}
      <div className="relative overflow-hidden rounded-xl border border-border/80 bg-[color:var(--color-tc-surface)]/70 p-6 sm:p-7">
        <div className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-[color:var(--color-tc-accent-hi)] to-[color:var(--color-tc-accent)]" />
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
          <Quote className="h-3 w-3" strokeWidth={2.2} />
          Director&apos;s Note
        </div>
        <p className="mt-4 whitespace-pre-line text-[14.5px] leading-[1.85] text-foreground/90">
          {result.professional_analysis}
        </p>
      </div>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/80 bg-card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 text-[15px] font-medium leading-snug text-foreground">
        {value}
      </p>
    </div>
  );
}

function KeywordsPanel({ keywords }: { keywords: string[] }) {
  return (
    <Card>
      <CardContent className="space-y-4 p-6 sm:p-7">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-[color:var(--color-tc-accent-hi)]">
            Search Keywords
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground">
            References 탭의 갤러리는 이 키워드들로 자동 생성됩니다.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {keywords.map((kw) => (
            <Badge
              key={kw}
              variant="outline"
              className="h-7 border-border/80 bg-[color:var(--color-tc-surface-2)] px-3 text-[12px] font-normal"
            >
              {kw}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Footer() {
  return (
    <footer className="mt-24 flex flex-col items-center gap-2 text-center">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span className="h-px w-6 bg-border" />
        <span>Powered by TEAM COCONUT</span>
        <span className="h-px w-6 bg-border" />
      </div>
      <p className="text-[11px] text-muted-foreground/60">
        AI / AX Driven · Product Innovation · Design
      </p>
    </footer>
  );
}

/* ----------------------------- helpers ----------------------------- */

// Card 베이스에 추가 클래스를 합치기 위한 박막 헬퍼.
// shadcn `Card`를 그대로 쓰면 padding/radius가 고정되는데,
// 상담 카드만 더 큰 radius/패딩이 필요해 native div에 같은 토큰을 직접 적용한다.
function cnCard(extra: string) {
  return extra;
}
