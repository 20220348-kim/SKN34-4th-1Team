// 비로그인 공개 화면의 껍데기입니다. 로그인 뒤 작업 화면(AppSidebar.styles의 layout·workspace)과 같은 규칙으로
// 바깥은 화면 높이에 고정된 흰 배경, 안쪽 칸이 스크롤합니다. 문서(html)는 스크롤하지 않아 두 상태의 스크롤과 바탕색이 같습니다.
export const publicLayoutStyles = {
  shell: 'flex h-dvh flex-col overflow-hidden bg-white text-app-ink',
  scrollArea: 'flex min-h-0 flex-1 flex-col overflow-y-auto',
} as const
