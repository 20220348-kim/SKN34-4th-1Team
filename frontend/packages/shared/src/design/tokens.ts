/**
 * 웹·모바일이 함께 쓰는 디자인 토큰입니다. 화면 코드에 16진수 색을 직접 쓰지 않고 이 이름을 씁니다.
 * 웹은 `frontend/web/src/design-tokens.css`(이 파일로 만든 Tailwind `@theme` 변수, `pnpm --filter govbiz-web tokens`)를,
 * 모바일은 이 값을 그대로 씁니다. 키는 camelCase이고 웹 변수 이름은 kebab-case입니다(brandPrimary → `--color-brand-primary`).
 */
export const colors = {
  // 브랜드(초록)는 주요 행동·선택·성공에만 씁니다.
  brandPrimary: '#087f46',
  brandHover: '#066538',
  brandSoft: '#e7f6ed',
  brandLine: '#b4ddc7',
  // 바탕과 면
  canvas: '#f5f6f7',
  surface: '#ffffff',
  surfaceMuted: '#f1f3f4',
  // 구분선과 입력칸 테두리
  line: '#e3e5e8',
  lineStrong: '#cfd4d9',
  // 글자: 본문 · 설명 · 보조(placeholder)
  ink: '#202124',
  inkMuted: '#606770',
  inkSubtle: '#838a93',
  // 상태 색은 글자(기본) · 연한 바탕(-soft) · 테두리(-line) 세 가지입니다. info는 파란색 계열입니다.
  danger: '#9a3947',
  dangerSoft: '#fff5f6',
  dangerLine: '#efc6cd',
  warning: '#8a5a00',
  warningSoft: '#fff4e0',
  warningLine: '#f1d9a6',
  info: '#1f5f99',
  infoSoft: '#eaf2fb',
  infoLine: '#bcd4ec',
  // 진행 막대·세그먼트의 바닥 칸입니다. canvas 바탕 위에서도 보이도록 surfaceMuted보다 한 단계 짙습니다.
  track: '#ebeef1',
} as const

export type ColorToken = keyof typeof colors

/** 모서리 둥글기(px)입니다. 웹 Tailwind의 같은 이름 `rounded-*` 기본값과 같으므로 웹은 따로 변수를 만들지 않습니다. */
export const radius = {
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  full: 9999,
} as const
