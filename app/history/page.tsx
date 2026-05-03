/**
 * /history — Phase A에서는 proxy 보호가 동작하는지 확인하기 위한 stub.
 * 실제 본인 분석 기록 표시는 Phase C에서 구현 (Firestore 쿼리 + 렌더링).
 */
import { CoconutLogo } from "@/components/coconut-logo";

export const metadata = {
  title: "히스토리 · TEAM COCONUT",
};

export default function HistoryPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pb-24 pt-16 sm:pt-24">
      <header className="flex flex-col items-center text-center">
        <CoconutLogo className="h-12 w-12 opacity-70" />
        <h1 className="mt-8 font-sans text-[32px] font-bold tracking-[-0.025em] sm:text-[40px]">
          히스토리
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          본인의 분석 기록이 여기에 표시됩니다. (Phase C에서 구현 예정)
        </p>
      </header>

      <section className="mt-16 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border/60 px-6 py-14 text-center">
        <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-muted-foreground">
          Coming Soon
        </p>
        <p className="text-sm text-muted-foreground/80">
          분석을 진행하면 결과가 자동으로 저장되고 이 페이지에서 다시 볼 수 있게 됩니다.
        </p>
      </section>
    </main>
  );
}
