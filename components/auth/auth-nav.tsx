/**
 * 모든 페이지 우측 상단에 고정되는 사용자 메뉴 nav bar.
 *
 * - 페이지 콘텐츠와 겹치지 않도록 fixed가 아닌 상단 절대 위치(layout 안의 wrapper에 대해 absolute) 가
 *   아니라, 단순한 wrapper-flex로 노출 (모바일에서 BrandHeader와 겹침 방지)
 * - layout.tsx에서 body 직속으로 mount되어 모든 라우트(`/`, `/login`, `/history`, `/admin`)에서
 *   동일하게 보인다
 */
import { UserMenu } from "@/components/auth/user-menu";

export function AuthNav() {
  return (
    <div className="absolute right-4 top-4 z-50 sm:right-6 sm:top-6">
      <UserMenu />
    </div>
  );
}
