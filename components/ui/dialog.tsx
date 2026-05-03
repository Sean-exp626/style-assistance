"use client";

/**
 * Dialog 프리미티브 — base-ui Dialog의 얇은 wrapper.
 *
 * Why base-ui (not shadcn/Radix):
 *   이 프로젝트는 이미 `@base-ui/react`를 다른 컴포넌트(dropdown-menu 등)에서 쓰고 있다.
 *   디자인 토큰(`--color-tc-*`) + Tailwind v4 utility를 한 자리에 묶기 위해 같은
 *   primitive 스택으로 통일.
 *
 * 사용 예:
 *   <Dialog>
 *     <DialogTrigger render={<button>열기</button>} />
 *     <DialogContent>
 *       <DialogTitle>제목</DialogTitle>
 *       <DialogDescription>설명</DialogDescription>
 *       ...본문...
 *       <DialogClose render={<button>닫기</button>} />
 *     </DialogContent>
 *   </Dialog>
 */
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

interface DialogContentProps extends DialogPrimitive.Popup.Props {
  /** 우측 상단 닫기(X) 버튼을 숨길 때 */
  hideCloseButton?: boolean;
  /** Backdrop 추가 className */
  backdropClassName?: string;
  /** Popup 내부 자식 */
  children?: React.ReactNode;
}

/**
 * 표준 모달 콘텐츠.
 *
 *  - Backdrop (어둡고 살짝 블러)
 *  - 중앙 정렬된 Popup (모바일에선 화면 가까이 꽉 채우고, sm 이상에서 max-w-2xl)
 *  - 우측 상단 닫기 버튼
 *  - data-open / data-closed 애니메이션
 */
function DialogContent({
  className,
  backdropClassName,
  hideCloseButton = false,
  children,
  ...props
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={cn(
          "fixed inset-0 z-50 bg-black/70 backdrop-blur-sm",
          "data-open:animate-in data-open:fade-in-0",
          "data-closed:animate-out data-closed:fade-out-0",
          backdropClassName,
        )}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
          "flex max-h-[92vh] w-[calc(100vw-2rem)] max-w-2xl flex-col",
          "overflow-hidden rounded-2xl border border-border/70 bg-card text-card-foreground",
          "shadow-[0_40px_120px_-30px_rgba(0,0,0,0.85)] outline-none",
          "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
          "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        {hideCloseButton ? null : (
          <DialogPrimitive.Close
            aria-label="닫기"
            className={cn(
              "absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full",
              "text-muted-foreground transition-colors hover:bg-[color:var(--color-tc-surface-2)] hover:text-foreground",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-tc-accent-hi)]",
            )}
          >
            <X className="h-4 w-4" strokeWidth={2.2} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({
  className,
  ...props
}: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-sans text-lg font-bold tracking-[-0.02em] text-foreground sm:text-xl",
        className,
      )}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogDescription,
};
