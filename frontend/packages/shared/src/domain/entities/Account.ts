/** 관리자는 서버에서 SQL이나 개발용 로그인으로만 지정됩니다. */
export type AccountRole = 'USER' | 'ADMIN'

/**
 * 화면 권한을 정하는 확인 단계입니다. 서버가 계정 상태로 계산해 내려 주며 앱은 이 값을 믿고 라우트를 지킵니다.
 * `COMPANY`는 사업자등록번호 조회를 통과한 기업을 등록하면 내려옵니다.
 */
export type AccountTier = 'MEMBER' | 'COMPANY' | 'ADMIN'

/** 로그인한 계정입니다. 비밀번호·토큰은 포함하지 않습니다. */
export type Account = {
  email: string
  role: AccountRole
  tier: AccountTier
  emailVerified: boolean
  /** 등록한 기업 요약입니다. 없으면 null이며 사이드바는 이메일만 보여 줍니다. */
  company: AccountCompanySummary | null
  /** 거짓이면 소셜 로그인으로만 가입해 비밀번호가 없는 계정입니다. 프로필은 비밀번호 항목을 숨기고 계정 삭제는 비밀번호를 묻지 않습니다. */
  hasPassword: boolean
}

export type AccountCompanySummary = {
  companyName: string
  businessNumber: string
}

const tierRank: Record<AccountTier, number> = { MEMBER: 1, COMPANY: 2, ADMIN: 3 }

/** 계정이 요구 단계 이상인지 확인합니다. 관리자는 모든 단계를 포함합니다. */
export function meetsTier(account: Account, minimum: AccountTier): boolean {
  return tierRank[account.tier] >= tierRank[minimum]
}
