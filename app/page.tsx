"use client";

/**
 * TEAM COCONUT · Style Assistance
 *
 * 분석 응답의 `search_keywords`로 자동 체이닝하여 레퍼런스 갤러리(`/api/references`)를
 * 표시한다.
 *  - 분석 성공 직후 곧바로 갤러리 fetch 시작 (사용자 추가 클릭 없이)
 *  - 결과 영역은 ANALYSIS / KEYWORDS / REFERENCES 3개 탭으로 구성
 *  - 갤러리 로딩 중에는 5개 스켈레톤 표시
 */
import { useMemo, useState, useTransition } from "react";

import { ReferenceGallery } from "@/components/reference-gallery";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { convertHeicToJpeg } from "@/lib/heic";
import { resizeImage } from "@/lib/image-utils";
import type {
  AnalysisResult,
  Gender,
  LengthPreference,
  ViewKey,
} from "@/lib/prompts";
import type { ReferenceImage } from "@/lib/search";

const VIEW_LABELS: Record<ViewKey, string> = {
  front: "정면",
  side: "측면",
  back: "뒷면",
};

const VIEW_KEYS: readonly ViewKey[] = ["front", "side", "back"] as const;

interface AnalyzeResponse {
  result: AnalysisResult;
  providedViews: ViewKey[];
}

export default function Home() {
  const [files, setFiles] = useState<Partial<Record<ViewKey, File>>>({});
  const [gender, setGender] = useState<Gender>("여성");
  const [lengthPref, setLengthPref] = useState<LengthPreference>("현재 유지");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [references, setReferences] = useState<ReferenceImage[] | null>(null);
  const [isLoadingRefs, setIsLoadingRefs] = useState(false);
  const [isPending, startTransition] = useTransition();

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

  async function fetchReferences(keywords: string[]) {
    setIsLoadingRefs(true);
    try {
      const res = await fetch("/api/references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords, num_results: 5 }),
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
      setError("정면/측면/뒷면 중 최소 한 장의 사진이 필요합니다.");
      return;
    }

    startTransition(async () => {
      try {
        const formData = new FormData();
        formData.set("gender", gender);
        formData.set("length", lengthPref);

        for (const view of VIEW_KEYS) {
          const original = files[view];
          if (!original) continue;
          // HEIC → JPEG → long-edge 1568px 리사이즈 순. 이미 JPEG여도 정규화 차원에서 리사이즈 1회 수행
          const jpeg = await convertHeicToJpeg(original);
          const resized = await resizeImage(jpeg);
          formData.set(view, resized);
        }

        const res = await fetch("/api/analyze", {
          method: "POST",
          body: formData,
        });
        const json = (await res.json()) as {
          result?: AnalysisResult;
          providedViews?: ViewKey[];
          error?: string;
        };
        if (!res.ok || !json.result) {
          throw new Error(json.error ?? "분석에 실패했습니다.");
        }
        setResult({
          result: json.result,
          providedViews: json.providedViews ?? [],
        });
        // 분석 성공 → 즉시 갤러리 페치 시작 (await 하지 않고 fire-and-forget)
        // 사용자는 ANALYSIS / KEYWORDS 탭을 먼저 보고 REFERENCES 탭으로 넘어가면 됨
        void fetchReferences(json.result.search_keywords);
      } catch (err) {
        // heic2any 등 일부 라이브러리는 plain object를 throw → 메시지 추출을 강화한다.
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
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-10 sm:px-6 sm:py-14">
      <header className="flex flex-col items-center gap-4 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/team-coconut-logo.jpeg"
          alt="TEAM COCONUT"
          className="h-32 w-auto sm:h-40"
        />
        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.32em] text-muted-foreground">
            AI / AX Driven · Product Innovation · Design
          </p>
          <h1 className="text-2xl font-semibold sm:text-3xl">
            AI 헤어스타일 분석 어시스턴트
          </h1>
          <p className="text-sm text-muted-foreground">
            정면 · 측면 · 뒷면 사진 중 가능한 만큼 업로드해 주세요. 20년 경력 베테랑 원장의 시선으로 분석해 드립니다.
          </p>
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">고객 정보 입력</CardTitle>
          <CardDescription>
            iPhone HEIC 사진은 자동으로 JPEG로 변환되어 업로드됩니다. (최대 10MB · 한 장 이상)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-6" onSubmit={onSubmit}>
            <div className="grid gap-4 sm:grid-cols-3">
              {VIEW_KEYS.map((view) => (
                <div key={view} className="space-y-2">
                  <Label htmlFor={`file-${view}`}>{VIEW_LABELS[view]} 사진</Label>
                  <input
                    id={`file-${view}`}
                    type="file"
                    accept="image/*,.heic,.heif"
                    capture="environment"
                    onChange={(e) =>
                      onPickFile(view, e.target.files?.[0] ?? null)
                    }
                    className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:text-secondary-foreground hover:file:bg-secondary/80"
                  />
                  {files[view] ? (
                    <p className="truncate text-xs text-muted-foreground" title={files[view]?.name}>
                      {files[view]?.name}
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground/70">선택 안 됨</p>
                  )}
                </div>
              ))}
            </div>

            <Separator />

            <div className="grid gap-6 sm:grid-cols-2">
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">성별</legend>
                <RadioGroup
                  value={gender}
                  onValueChange={(v) => setGender(v as Gender)}
                  className="flex gap-6"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id="g-female" value="여성" />
                    <Label htmlFor="g-female" className="cursor-pointer">여성</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id="g-male" value="남성" />
                    <Label htmlFor="g-male" className="cursor-pointer">남성</Label>
                  </div>
                </RadioGroup>
              </fieldset>

              <div className="space-y-3">
                <Label htmlFor="length">기장 변화 선호</Label>
                <Select
                  value={lengthPref}
                  onValueChange={(v) => setLengthPref(v as LengthPreference)}
                >
                  <SelectTrigger id="length" className="w-full">
                    <SelectValue placeholder="기장 변화 선호" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="현재 유지">현재 유지</SelectItem>
                    <SelectItem value="더 짧게">더 짧게</SelectItem>
                    <SelectItem value="더 길게">더 길게</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={isPending || !hasAnyFile}
            >
              {isPending ? "분석 중…" : "분석 시작"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>분석에 실패했습니다</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {isPending ? <ResultSkeleton /> : null}

      {result && !isPending ? (
        <ResultTabs
          result={result.result}
          providedViews={result.providedViews}
          references={references}
          isLoadingRefs={isLoadingRefs}
        />
      ) : null}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function ResultTabs({
  result,
  providedViews,
  references,
  isLoadingRefs,
}: {
  result: AnalysisResult;
  providedViews: ViewKey[];
  references: ReferenceImage[] | null;
  isLoadingRefs: boolean;
}) {
  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-semibold">분석 결과</h2>
        <p className="text-xs text-muted-foreground">
          분석된 뷰: {providedViews.length > 0
            ? providedViews.map((v) => VIEW_LABELS[v]).join(" · ")
            : "—"}
        </p>
      </header>

      <Tabs defaultValue="analysis">
        <TabsList className="w-full">
          <TabsTrigger
            value="analysis"
            className="text-xs uppercase tracking-[0.16em]"
          >
            Analysis
          </TabsTrigger>
          <TabsTrigger
            value="keywords"
            className="text-xs uppercase tracking-[0.16em]"
          >
            Keywords
          </TabsTrigger>
          <TabsTrigger
            value="references"
            className="text-xs uppercase tracking-[0.16em]"
          >
            References
          </TabsTrigger>
        </TabsList>

        <TabsContent value="analysis" className="mt-4 space-y-4">
          <AnalysisPanel result={result} />
        </TabsContent>

        <TabsContent value="keywords" className="mt-4">
          <KeywordsPanel keywords={result.search_keywords} />
        </TabsContent>

        <TabsContent value="references" className="mt-4">
          <ReferenceGallery refs={references} isLoading={isLoadingRefs} />
        </TabsContent>
      </Tabs>
    </section>
  );
}

function AnalysisPanel({ result }: { result: AnalysisResult }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>얼굴형</CardDescription>
            <CardTitle className="text-base">{result.face_shape}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>두상</CardDescription>
            <CardTitle className="text-base">{result.head_shape}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>추천 스타일</CardDescription>
          <CardTitle className="text-lg">
            {result.recommended_style.name}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            기장: {result.recommended_style.length}
          </p>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-sm font-medium">핵심 포인트</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {result.recommended_style.key_features.map((feature, i) => (
              <li key={i}>{feature}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardDescription>원장님 한 마디</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="whitespace-pre-line text-sm leading-relaxed">
            {result.professional_analysis}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function KeywordsPanel({ keywords }: { keywords: string[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>레퍼런스 검색 키워드</CardDescription>
        <p className="text-xs text-muted-foreground">
          References 탭의 갤러리는 이 키워드들로 자동 생성됩니다.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {keywords.map((kw) => (
            <Badge key={kw} variant="secondary">
              {kw}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
