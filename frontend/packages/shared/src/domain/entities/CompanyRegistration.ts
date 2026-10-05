import type { BusinessLookup, BusinessStatusCode } from './Company'

/**
 * 사업자 조회 결과로 기업 등록 여부를 정하는 규칙과 그 안내 문구입니다. 웹 프로필·온보딩과 모바일 기업 화면이 같은 규칙을 쓰며,
 * 서버도 등록 시점에 사업자를 다시 조회해 같은 기준(계속·휴업은 등록, 폐업은 거절)으로 검사합니다.
 */

/** 조회한 사업자를 등록할 수 있는지입니다. 계속·휴업은 되고 폐업은 안 됩니다. */
export function canRegisterBusiness(business: BusinessLookup): boolean {
  return business.canRegister
}

/** 사업자등록번호 입력·조회와 등록 가능 여부를 알리는 문구입니다. */
export const companyRegistrationMessages = {
  businessNumberInvalid: '사업자등록번호는 숫자 10자리로 입력해 주세요.',
  businessNotFound: '국세청에 등록되지 않은 번호예요. 숫자 10자리를 다시 확인해 주세요.',
  businessClosed: (status: string | null) =>
    status === null ? '폐업한 사업자는 등록할 수 없어요.' : `${status} 상태의 사업자는 등록할 수 없어요.`,
  lookupRequired: '사업자등록번호를 먼저 조회해 주세요.',
  businessNumberTaken: '이 사업자는 다른 계정에 등록돼 있어요. 담당자가 바뀌었다면 알려 주세요.',
} as const

/** 조회 결과에 붙는 상태별 안내입니다. 내부 코드 대신 무엇을 할 수 있는지로 말합니다. */
export const businessStatusNotes: Record<BusinessStatusCode, string> = {
  '01': '국세청 등록 정보로 확인했어요. 상호는 바꿀 수 없고, 아래 정보만 적어 주세요.',
  '02': '등록은 할 수 있어요. 파트너 모집글과 제안은 사업을 다시 시작한 뒤 쓸 수 있어요.',
  '03': '폐업한 사업자는 등록할 수 없어요. 다른 번호를 조회하거나 개인 회원으로 이용해 주세요.',
}
