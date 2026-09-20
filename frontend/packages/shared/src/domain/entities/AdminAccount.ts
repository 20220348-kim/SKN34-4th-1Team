import type { AccountRole, AccountTier } from './Account'

/** 관리자 목록에서 계정을 나누는 상태입니다. 삭제된 계정은 목록과 상세에 나오지 않습니다. */
export type AdminAccountStatus = 'ACTIVE' | 'SUSPENDED'

/** 로그인 방법입니다. 이메일은 비밀번호가 있는 계정이며 한 계정이 여러 방법을 가질 수 있습니다. */
export type AdminAccountLoginMethod = 'EMAIL' | 'KAKAO' | 'GOOGLE'

/** 목록 정렬입니다. 최근 로그인순은 로그인한 적 없는 계정을 뒤에 둡니다. */
export type AdminAccountSort = 'RECENT' | 'OLDEST' | 'LAST_LOGIN'

/** 관리자 조치 기록의 종류입니다. */
export type AdminAccountActionType = 'SUSPEND' | 'UNSUSPEND' | 'SESSIONS_REVOKE'

/** 화면에서 고르는 조치입니다. 서버 경로와 기록 종류로 바꾸는 일은 Data Layer가 맡습니다. */
export type AdminAccountActionKind = 'suspend' | 'unsuspend' | 'revoke-sessions'

/** 관리자 목록 한 줄입니다. 비밀번호·토큰은 없고 비밀번호가 있는지만 압니다. 시각은 서울 기준 `yyyy-MM-ddTHH:mm:ss`입니다. */
export type AdminAccountSummary = {
  id: number
  email: string
  role: AccountRole
  tier: AccountTier
  status: AdminAccountStatus
  emailVerified: boolean
  hasPassword: boolean
  loginMethods: AdminAccountLoginMethod[]
  company: { companyName: string; businessNumber: string } | null
  createdAt: string
  lastLoginAt: string | null
  suspendedAt: string | null
}

/** 목록 조건입니다. 상태·역할·로그인 방법이 빈 문자열이면 전체입니다. */
export type AdminAccountQuery = {
  keyword: string
  status: AdminAccountStatus | ''
  role: AccountRole | ''
  loginMethod: AdminAccountLoginMethod | ''
  sort: AdminAccountSort
  page: number
}

export const adminAccountPageSize = 20

export const defaultAdminAccountQuery: AdminAccountQuery = {
  keyword: '',
  status: '',
  role: '',
  loginMethod: '',
  sort: 'RECENT',
  page: 1,
}

export type AdminAccountPage = {
  accounts: AdminAccountSummary[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** 목록 위 요약 수치입니다. `joinedRecently`는 최근 `recentJoinDays`일 안에 가입한 계정 수입니다. */
export type AdminAccountStats = {
  total: number
  companyRegistered: number
  socialLinked: number
  suspended: number
  admins: number
  joinedRecently: number
  recentJoinDays: number
}

export type AdminAccountAction = {
  id: number
  action: AdminAccountActionType
  reason: string
  adminEmail: string
  createdAt: string
}

export type AdminAccountDetail = {
  account: AdminAccountSummary
  company: {
    companyName: string
    businessNumber: string
    region: string
    industry: string
    foundedYear: number
  } | null
  activity: {
    recruitmentCount: number
    openRecruitmentCount: number
    sentProposalCount: number
    activeSessionCount: number
  }
  /** 최근 조치부터 최대 20건입니다. */
  actions: AdminAccountAction[]
  /** 조회한 관리자 자신의 계정이면 참입니다. */
  isSelf: boolean
}

/** 조치 사유는 서버와 같이 앞뒤 공백을 뺀 1~500자입니다. */
export const adminActionReasonMaxLength = 500

export const adminAccountStatusLabels: Record<AdminAccountStatus, string> = {
  ACTIVE: '정상',
  SUSPENDED: '정지',
}

export const adminAccountRoleLabels: Record<AccountRole, string> = {
  USER: '회원',
  ADMIN: '관리자',
}

export const adminAccountLoginMethodLabels: Record<AdminAccountLoginMethod, string> = {
  EMAIL: '이메일',
  KAKAO: '카카오',
  GOOGLE: 'Google',
}

export const adminAccountSortLabels: Record<AdminAccountSort, string> = {
  RECENT: '최근 가입순',
  OLDEST: '오래된 가입순',
  LAST_LOGIN: '최근 로그인순',
}

export const adminAccountActionLabels: Record<AdminAccountActionType, string> = {
  SUSPEND: '정지',
  UNSUSPEND: '정지 해제',
  SESSIONS_REVOKE: '강제 로그아웃',
}

/** 조치할 수 있는 계정인지입니다. 자기 계정과 다른 관리자 계정에는 서버도 조치를 거절합니다. */
export function availableAdminAccountActions(detail: AdminAccountDetail): AdminAccountActionKind[] {
  if (detail.isSelf || detail.account.role === 'ADMIN') return []
  return detail.account.status === 'SUSPENDED' ? ['unsuspend'] : ['suspend', 'revoke-sessions']
}
