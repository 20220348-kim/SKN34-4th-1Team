import type { AccountType } from '../../../../domain/entities/Account'

/** 선택 카드에 붙는 아이콘 이름입니다. */
export type OnboardingIcon = 'user' | 'building'

/** 환영 화면의 선택지입니다. 내부 이름 대신 판단 기준("사업자등록번호가 있으면")을 사용자 말로 줍니다. */
export const accountTypeOptions: { value: AccountType; icon: OnboardingIcon; title: string; description: string; note: string }[] = [
  {
    value: 'INDIVIDUAL',
    icon: 'user',
    title: '개인 회원',
    description: '예비창업자·프리랜서·1인 사업자. 창업 지원사업과 개인 대상 지원금을 찾아요.',
    note: '사업자등록번호 없이 바로 시작',
  },
  {
    value: 'BUSINESS',
    icon: 'building',
    title: '기업 회원',
    description: '사업자등록번호로 기업을 등록하면 컨소시엄 모집글과 제안까지 쓸 수 있어요.',
    note: '다음 단계에서 번호 조회 · 건너뛸 수 있어요',
  },
]
