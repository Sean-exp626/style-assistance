# KAI JUNG HAIR · Style Assistance

강남 KAI JUNG HAIR 원장 페르소나로 고객의 정면·측면·뒷면 사진을 분석해 어울리는 헤어스타일을 추천하는 AI 어시스턴트.

원본 Streamlit 프로토타입 (`../hair-style-ai/`)을 **Next.js 16 + Vercel** 스택으로 옮긴 마이그레이션 프로젝트로, 모바일(iPhone) 우선과 서버리스 친화 운영을 목표로 한다. Powered by **TEAM COCONUT**.

## Phase 진행 상황

- **Phase 1 — MVP** (현재): Next.js 초기화, `/api/analyze` Route Handler, 단순 결과 카드, Vercel 배포
- **Phase 2 — 갤러리**: web_search + og:image 추출 + thum.io 폴백
- **Phase 3 — 디자인 폴리싱**: Cormorant Garamond, 그라디언트 헤더, 펄스 애니메이션 등 KAI JUNG HAIR 다크 무드 완성

상세 마이그레이션 플랜: [`../kaijunghair-migration-plan.md`](../kaijunghair-migration-plan.md)

## 기술 스택

| 영역 | 선택 |
| --- | --- |
| 런타임 | Next.js 16 App Router · React 19 · TypeScript 5 |
| 스타일 | Tailwind CSS v4 · shadcn/ui (다크 고정) |
| LLM | Anthropic Claude `claude-opus-4-7` (Vision + prompt caching) |
| 검증 | zod |
| 이미지 | 클라이언트 HEIC 변환 (`heic2any`) + canvas long-edge 1568px 리사이즈 |
| 배포 | Vercel (Node.js runtime, `maxDuration = 60`) |

## 디렉토리 구조

```
kaijunghair/
├── app/
│   ├── api/analyze/route.ts   # POST 엔드포인트 (multipart/form-data)
│   ├── globals.css            # KAI JUNG HAIR 다크 토큰 + shadcn 매핑
│   ├── layout.tsx
│   └── page.tsx               # Phase 1 MVP 폼 + 결과 카드
├── lib/
│   ├── prompts.ts             # SYSTEM_PROMPT, buildUserPrompt, zod 스키마
│   ├── analyze.ts             # Anthropic Vision 호출 + JSON 파싱 4단계 폴백
│   ├── heic.ts                # 클라이언트 HEIC → JPEG 변환
│   ├── image-utils.ts         # 클라이언트 long-edge 1568px 리사이즈
│   └── utils.ts               # shadcn cn() 헬퍼
└── components/ui/             # shadcn/ui 컴포넌트
```

## 로컬 실행

```bash
# 1. 의존성 설치
npm install

# 2. 환경 변수 설정
cp .env.example .env.local
#   → .env.local 의 ANTHROPIC_API_KEY 값을 본인 키로 채우세요.

# 3. 개발 서버
npm run dev   # http://localhost:3000
```

iPhone에서 같은 Wi-Fi로 테스트하려면:

```bash
npm run dev -- --hostname 0.0.0.0
# 그 후 휴대폰 브라우저에서 http://<맥의 IP>:3000
```

## 환경 변수

| 키 | 필수 | 설명 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | O | Anthropic Console에서 발급한 `sk-ant-...` 키 |

`.env.local`은 git ignored. `.env.example`을 참고해서 채우세요.

## 빌드 / Lint

```bash
npm run build
npm run lint
```

## 배포 (Vercel)

```bash
# 처음 1회만 — 프로젝트 링크
vercel link

# 환경 변수 등록 (production / preview / development)
vercel env add ANTHROPIC_API_KEY production
vercel env add ANTHROPIC_API_KEY preview
vercel env add ANTHROPIC_API_KEY development

# 프로덕션 배포
vercel --prod
```

## 주의 사항

- 모델 ID는 `claude-opus-4-7`로 고정 (변경 금지).
- SYSTEM_PROMPT의 한국어 톤 가이드라인(`prompts.py` → `lib/prompts.ts`)은 의역/축약 금지. 칭찬 위주 톤이 핵심 가치.
- Phase 1 범위에서는 web_search / 갤러리 미구현. Phase 2에서 추가.

## 관련

- 원본 Streamlit 코드: [`../hair-style-ai/`](../hair-style-ai/)
- 원본 아키텍처 문서: [`../hair-style-ai/architecture.md`](../hair-style-ai/architecture.md)
- 마이그레이션 플랜: [`../kaijunghair-migration-plan.md`](../kaijunghair-migration-plan.md)
