function classes(...groups: string[]) {
  return groups.join(' ')
}

// 색상이나 CSS 속성이 아니라 로그인·회원가입·비밀번호 찾기 화면에서 맡는 UI 역할을 이름으로 사용합니다.
// 네 화면은 테두리 없는 가운데 열(로고·구분선·입력·버튼·링크)이라는 같은 껍데기를 공유하고 입력 항목만 달라집니다.
export const authPageStyles = {
  page: 'flex min-h-screen flex-col items-center justify-center bg-white px-5 py-10 text-app-ink max-chat:py-8',
  logo: classes(
    'mb-7 flex items-center gap-3 self-center rounded-xl text-app-ink no-underline',
    'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-primary',
  ),
  // 로그인·회원가입은 로고 마크와 이름 둘만 두므로 공개 헤더보다 한 단계 크게 씁니다.
  logoMark:
    'grid size-14 shrink-0 place-items-center rounded-2xl bg-brand-accent text-[1.8rem] font-black text-brand-primary',
  logoTitle: 'block text-[1.75rem] font-extrabold leading-none tracking-[-0.05em]',
  // 입력·버튼 폭 444px은 참고한 로그인 화면과 같습니다.
  formPanel: 'flex w-full max-w-[444px] min-w-0 flex-col justify-center',
  card: 'flex min-w-0 w-full flex-col gap-3',
  cardHeader: 'flex flex-col gap-2',
  cardEyebrow:
    'm-0 text-[0.7rem] font-extrabold tracking-[0.12em] text-brand-primary uppercase',
  cardTitle: 'm-0 text-[1.7rem] font-bold tracking-[-0.04em] text-sample-heading',
  cardDescription: 'm-0 text-[0.9rem] leading-[1.65] text-sample-muted',
  fields: 'flex flex-col gap-3',
  field: 'flex flex-col gap-2 text-[0.9rem] font-bold text-app-ink',
  // 항목 이름은 placeholder가 대신하고 낭독기에만 읽히게 숨깁니다.
  fieldName: 'sr-only',
  fieldControl: classes(
    'box-border min-h-14 w-full rounded-xl border px-4 py-[0.9rem] text-base font-normal',
    'border-sample-border bg-white text-app-ink placeholder:text-sample-muted',
    'focus:border-brand-primary focus:shadow-[0_0_0_3px_rgb(8_127_70_/_15%)] focus:outline-0',
  ),
  // 이메일·인증번호 칸 오른쪽에 "인증번호 받기"·"확인" 버튼을 같은 줄로 붙입니다. 버튼은 입력칸과 같은 높이·모서리입니다.
  inlineRow: 'flex items-stretch gap-2',
  inlineButton: classes(
    'min-h-14 shrink-0 cursor-pointer whitespace-nowrap rounded-xl border border-brand-primary bg-white px-4 text-[0.9rem] font-bold text-brand-primary',
    'hover:bg-brand-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary disabled:cursor-default disabled:opacity-60',
  ),
  verifiedTag: 'inline-flex min-h-14 shrink-0 items-center rounded-xl bg-brand-accent px-4 text-[0.9rem] font-extrabold text-brand-primary',
  fieldHint: 'm-0 text-center text-[0.75rem] font-medium text-sample-muted',
  fieldError: 'm-0 text-[0.82rem] font-medium text-[#9a3947]',
  notice: 'm-0 rounded-xl bg-brand-accent px-4 py-3 text-[0.88rem] leading-[1.6] text-app-ink',
  optionsRow: 'flex flex-wrap items-center justify-between gap-4',
  checkboxLabel: 'inline-flex items-center gap-2 text-[0.82rem] font-normal text-sample-muted',
  checkbox: 'size-[1.05rem] accent-brand-primary',
  // 로그인·회원가입·비밀번호 변경 버튼은 입력칸·소셜 버튼과 같은 모서리(rounded-xl)를 씁니다. 아이콘을 둔 버튼도 글자는
  // 가운데에 오도록 relative flex로 둡니다. 바탕은 브랜드색(#087f46)보다 조금 연한 #1a8752로, 흰 글자 대비 4.5:1(WCAG AA)을
  // 넘기는 가장 연한 쪽에 맞추고, 누르려 할 때는 원래 브랜드색으로 돌아갑니다.
  submitButton: classes(
    'relative flex min-h-14 w-full cursor-pointer items-center justify-center rounded-xl border-0 bg-[#1a8752] px-4 py-[0.9rem]',
    'text-base font-extrabold text-white hover:bg-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
    'disabled:cursor-default disabled:opacity-60',
  ),
  primaryLink: classes(
    'inline-flex min-h-14 w-full items-center justify-center rounded-xl bg-[#1a8752] px-4 py-[0.9rem]',
    'text-base font-extrabold text-white no-underline hover:bg-brand-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  linksRow: 'm-0 mt-3 flex flex-wrap items-center justify-center gap-3 text-[0.95rem]',
  linksLead: 'text-sample-muted',
  linkSeparator: 'h-4 w-px bg-sample-border',
  footerLink: 'rounded font-bold text-app-ink no-underline hover:text-brand-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-primary',
  // 소셜 로그인 버튼은 두 공급자 가이드대로 같은 크기로 두고 색은 공급자가 정한 값만 씁니다.
  socialButtons: 'flex flex-col gap-3',
  // 카카오 로그인 디자인 가이드: 컨테이너 #FEE500, 심볼 #000000, 레이블 #000000 85%, 모서리 12px
  kakaoButton: classes(
    'relative flex min-h-14 w-full items-center justify-center rounded-xl bg-[#FEE500] px-12',
    'text-base font-bold text-black/85 no-underline hover:brightness-95',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // Sign in with Google 가이드: 흰 바탕, #747775 테두리, #1F1F1F 레이블, 표준 G 로고
  googleButton: classes(
    'relative flex min-h-14 w-full items-center justify-center rounded-xl border border-[#747775] bg-white px-12',
    'text-base font-bold text-[#1F1F1F] no-underline hover:bg-[#F8F9FA]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-primary',
  ),
  // 소셜·이메일 버튼의 아이콘은 모두 왼쪽 같은 자리에 둡니다.
  buttonIcon: 'absolute left-5 size-6',
  // 소셜 버튼과 이메일 입력 사이의 수평선입니다.
  sectionRule: 'my-3 h-px w-full border-0 bg-sample-border',
} as const
