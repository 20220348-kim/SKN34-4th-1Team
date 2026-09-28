import type { BusinessStatusCode } from './Company'

/** 관리자는 서버에서 SQL이나 개발용 로그인으로만 지정됩니다. */
export type AccountRole = 'USER' | 'ADMIN'

/**
 * 화면 권한을 정하는 확인 단계입니다. 서버가 계정 상태로 계산해 내려 주며 앱은 이 값을 믿고 라우트를 지킵니다.
 * `COMPANY`는 사업자등록번호 조회를 통과한 기업을 등록하면 내려옵니다.
 */
export type AccountTier = 'MEMBER' | 'COMPANY' | 'ADMIN'

/** 환영 화면에서 고르는 회원 유형입니다. 사업자등록번호가 있으면 기업, 아직 없으면 개인입니다. */
export type AccountType = 'INDIVIDUAL' | 'BUSINESS'

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
  /** 환영 화면에서 고른 회원 유형입니다. 아직이면 null입니다. */
  accountType: AccountType | null
  /** 거짓이면 로그인 뒤 다른 작업 화면보다 먼저 `/app/welcome`을 보여 줍니다. */
  onboarded: boolean
}

export type AccountCompanySummary = {
  companyName: string
  businessNumber: string
  /** 국세청 사업자 상태 코드. `01` 계속사업자만 파트너 모집글·제안을 쓸 수 있고, `02` 휴업자는 둘러보기만 됩니다. */
  businessStatusCode: BusinessStatusCode
}

/** 파트너 모집글·제안을 쓸 수 있는 기업인지입니다. 기업이 없거나 휴업이면 거짓입니다. */
export function hasActiveBusiness(account: Account): boolean {
  return account.company !== null && account.company.businessStatusCode === '01'
}

const tierRank: Record<AccountTier, number> = { MEMBER: 1, COMPANY: 2, ADMIN: 3 }

/** 계정이 요구 단계 이상인지 확인합니다. 관리자는 모든 단계를 포함합니다. */
export function meetsTier(account: Account, minimum: AccountTier): boolean {
  return tierRank[account.tier] >= tierRank[minimum]
}
