/**
 * 화면 경로를 한 곳에 둡니다. 로그인 전 화면은 `/` 아래 공개 경로, 로그인 뒤 화면은 `/app` 아래 내부 경로입니다.
 * 같은 내용을 두 세계에서 보여 주는 화면(요금제, 공고 상세)은 공개↔내부 경로가 1:1로 대응합니다.
 */
export const APP_PREFIX = '/app'

export const appPaths = {
  /** 가입 직후 한 번 거치는 환영 화면입니다. 사이드바 없이 단독으로 뜹니다. */
  welcome: `${APP_PREFIX}/welcome`,
  /** 환영 화면에서 기업 회원을 고른 뒤 사업자등록번호를 조회해 기업을 등록하는 2단계입니다. 건너뛸 수 있습니다. */
  welcomeCompany: `${APP_PREFIX}/welcome/company`,
  savedPrograms: `${APP_PREFIX}/saved-programs`,
  reports: `${APP_PREFIX}/reports`,
  applicationPreparations: `${APP_PREFIX}/application-preparations`,
  applicationPreparationNew: `${APP_PREFIX}/application-preparations/new`,
  applicationPreparationDetail: `${APP_PREFIX}/application-preparations/:preparationId`,
  applicationPreparationDocuments: `${APP_PREFIX}/application-preparations/:preparationId/documents`,
  combinationReviews: `${APP_PREFIX}/combination-reviews`,
  combinationReviewNew: `${APP_PREFIX}/combination-reviews/new`,
  combinationReviewDetail: `${APP_PREFIX}/combination-reviews/:reviewId`,
  combinationReviewRunResult: `${APP_PREFIX}/combination-reviews/:reviewId/runs/:runId`,
  chat: `${APP_PREFIX}/chat`,
  pricing: `${APP_PREFIX}/pricing`,
  partners: `${APP_PREFIX}/partners`,
  partnerDetail: `${APP_PREFIX}/partners/detail`,
  partnerNew: `${APP_PREFIX}/partners/new`,
  partnerEdit: `${APP_PREFIX}/partners/edit`,
  myPartners: `${APP_PREFIX}/partners/mine`,
  proposals: `${APP_PREFIX}/proposals`,
  profile: `${APP_PREFIX}/profile`,
  admin: `${APP_PREFIX}/admin`,
  adminAccounts: `${APP_PREFIX}/admin/accounts`,
  adminAccountDetail: `${APP_PREFIX}/admin/accounts/detail`,
  supportProgramDetail: `${APP_PREFIX}/support-programs/detail`,
  supportProgramQuestion: `${APP_PREFIX}/support-programs/detail/question`,
} as const

export function combinationReviewRunResultPath(reviewId: number, runId: number): string {
  return `${appPaths.combinationReviews}/${reviewId}/runs/${runId}`
}

/** 관심 공고함의 보기 방식입니다. 달력·목록·진행 관리를 주소로 기억해 공고 상세에서 돌아올 때 같은 탭을 엽니다. */
export const savedProgramsViewModes = ['calendar', 'list', 'pipeline'] as const

export type SavedProgramsViewMode = (typeof savedProgramsViewModes)[number]

/** 기본 탭인 달력은 주소에 남기지 않아 기존 `/app/saved-programs` 주소를 그대로 씁니다. */
export function savedProgramsPath(view: SavedProgramsViewMode): string {
  return view === 'calendar' ? appPaths.savedPrograms : `${appPaths.savedPrograms}?view=${view}`
}

/** 주소의 보기 방식입니다. 모르는 값이면 기본 탭인 달력으로 봅니다. */
export function readSavedProgramsViewMode(value: string | null | undefined): SavedProgramsViewMode {
  return savedProgramsViewModes.find((mode) => mode === value) ?? 'calendar'
}

export const publicPaths = {
  reportEmail: '/report-email',
  landing: '/',
  login: '/login',
  signup: '/signup',
  forgotPassword: '/forgot-password',
  resetPassword: '/reset-password',
  /** 소셜 로그인 뒤 서버가 보내는 완료 화면입니다. 세션을 확인하고 복귀 경로로 옮깁니다. */
  oauthComplete: '/oauth/complete',
  pricing: '/pricing',
  partners: '/partners',
  partnerDetail: '/partners/detail',
  supportProgramDetail: '/support-programs/detail',
  supportProgramQuestion: '/support-programs/detail/question',
} as const

export function isAppPath(pathname: string): boolean {
  return pathname === APP_PREFIX || pathname.startsWith(`${APP_PREFIX}/`)
}

/**
 * 로그인한 사용자가 공개 URL로 오면 같은 내용의 내부 화면으로 보냅니다.
 * 대응하는 내부 화면이 없는 공개 URL(랜딩 등)은 작업 채팅으로 갑니다.
 */
export function toAppPath(pathname: string, search = ''): string {
  const trimmed = pathname.replace(/\/+$/, '') || '/'
  if (trimmed === publicPaths.landing) return `${appPaths.chat}${search}`
  const mirrored = [
    publicPaths.pricing,
    publicPaths.partners,
    publicPaths.partnerDetail,
    publicPaths.supportProgramDetail,
    publicPaths.supportProgramQuestion,
  ]
  if (mirrored.includes(trimmed as (typeof mirrored)[number])) return `${APP_PREFIX}${trimmed}${search}`
  return appPaths.chat
}

/**
 * 공고 상세·질문 화면 경로입니다. 내부 화면에서 열면 사이드바를 유지하도록 `/app` 아래 경로를 씁니다.
 * 비로그인 화면은 이동 상태가 새로고침·공유에서 사라지므로, 기본 검색(`/`)이 아닌 복귀 경로만 `back`에 실어 둡니다.
 */
export function supportProgramDetailPath(identity: { sourceCode: string; sourceProgramId: string }, inApp: boolean, searchReturnTo?: string): string {
  const base = inApp ? appPaths.supportProgramDetail : publicPaths.supportProgramDetail
  return `${base}?${withSearchReturnTo(identity, inApp, searchReturnTo)}`
}

export function supportProgramQuestionPath(identity: { sourceCode: string; sourceProgramId: string }, inApp: boolean, searchReturnTo?: string): string {
  const base = inApp ? appPaths.supportProgramQuestion : publicPaths.supportProgramQuestion
  return `${base}?${withSearchReturnTo(identity, inApp, searchReturnTo)}`
}

function withSearchReturnTo(identity: { sourceCode: string; sourceProgramId: string }, inApp: boolean, searchReturnTo?: string): URLSearchParams {
  const params = new URLSearchParams(identity)
  if (!inApp && searchReturnTo && searchReturnTo !== publicPaths.landing) params.set('back', searchReturnTo)
  return params
}
