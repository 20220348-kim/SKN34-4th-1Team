// 무료(지금 누구나)·플러스(우리 회사 하나를 관리, 정식 출시 전까지 회원 무료)·프리미엄(출시 준비 중) 세 단계입니다.
// 가격은 출시 시 확정하며, 현재 결제·구독은 받지 않습니다.
export const pricingPlans = [
  {
    id: 'free',
    label: 'FREE',
    name: '무료',
    status: '지금 이용 가능',
    description: '우리 기업에 맞는 지원사업을 찾고, 공고의 조건부터 확인하고 싶다면.',
    price: '0원',
    priceNote: '기본 기능 · 회원가입 없이 시작',
    featureHeading: '지금 제공하는 기능',
    features: [
      'AI 대화 검색과 필터 검색',
      '입력한 기업 조건으로 자격 조건 확인',
      '공고 원문 근거 질문과 답변',
      '도우미 안내와 공개 파트너 모집글 열람',
    ],
    footerNote: '로그인 후 이용할 수 있습니다.',
    action: 'search',
    isAvailable: true,
    isFeatured: false,
  },
  {
    id: 'plus',
    label: 'PLUS',
    name: '플러스',
    status: '지금 이용 가능',
    description: '공고를 모아 진행을 관리하고, 맞춤 리포트·중복 검토·신청 문서까지 이어가고 싶다면.',
    price: '월 9,900원',
    priceNote: '정식 출시 전까지 회원 무료',
    featureHeading: '제공 기능',
    features: [
      '기업 맞춤 리포트',
      '신청 문서 작성',
      '관심 공고 진행 관리',
      '중복 지원·수혜 검토',
    ],
    footerNote: '정식 출시 전까지 회원에게 무료로 제공하며, 가격은 출시 시 확정합니다.',
    action: 'pro',
    isAvailable: true,
    isFeatured: true,
  },
  {
    id: 'premium',
    label: 'PREMIUM',
    name: '프리미엄',
    status: '출시 예정',
    description: '신청서 초안까지 AI가 먼저 채우고, 검색과 해석을 더 빠르게 받고 싶다면.',
    price: '월 29,000원',
    priceNote: '출시 준비 중',
    featureHeading: '출시 준비 방향',
    features: [
      '신청서 항목별 AI 초안 자동 채움과 원문 대조',
      '검색·조건 해석 우선 처리와 넉넉한 요청 한도',
    ],
    footerNote: '가격과 제공 범위는 출시 시 안내합니다.',
    action: 'pending',
    isAvailable: false,
    isFeatured: false,
  },
] as const

export const pricingSearchSteps = [
  {
    number: '01',
    title: '필요한 지원사업 찾기',
    description: '지역, 업종, 지원 목적을 자연스럽게 입력하고 관련 공고를 찾아보세요.',
  },
  {
    number: '02',
    title: '기업 조건과 비교하기',
    description: '입력한 조건을 바탕으로 공고의 자격 조건과 추가 확인이 필요한 부분을 살펴보세요.',
  },
  {
    number: '03',
    title: '원문을 근거로 질문하기',
    description: '기업마당 공고 상세에서 궁금한 내용을 질문하고, 답변의 근거를 원문과 함께 확인하세요.',
  },
] as const

export const pricingFrequentlyAskedQuestions = [
  {
    question: '무료 요금제에서는 무엇을 할 수 있나요?',
    answer: 'AI 대화 검색과 필터 검색, 입력한 기업 조건을 바탕으로 한 자격 조건 확인, 공고 원문 근거 질문, 도우미 안내, 공개 파트너 모집글 열람을 로그인 후 이용할 수 있습니다.',
  },
  {
    question: '플러스와 프리미엄은 지금 신청할 수 있나요?',
    answer: '플러스의 기업 맞춤 리포트, 신청 문서 작성, 관심 공고 진행 관리, 중복 지원·수혜 검토는 정식 출시 전까지 회원에게 무료로 열려 있어 별도 신청 없이 바로 이용할 수 있습니다. 프리미엄은 출시 준비 중이며, 표시한 가격은 예정가로 제공 범위와 이용 정책은 출시 시 확정합니다. 현재는 결제나 구독 신청을 받지 않습니다.',
  },
  {
    question: 'AI가 지원 자격이나 선정을 보장하나요?',
    answer: '아니요. AI의 조건 확인과 답변은 공고를 살펴보기 위한 참고 정보입니다. 조건 확인은 공식 API 본문을 기준으로 하며 첨부파일은 검증하지 않으므로, 지원 자격·접수 상태·신청 방법은 공고 원문과 담당 기관에서 최종 확인해야 합니다.',
  },
  {
    question: '공고 출처는 어디인가요?',
    answer: '기업마당, K-Startup, 과학기술정보통신부, 충청남도 온라인수출지원시스템의 공식 API에서 공고를 받아 주기적으로 갱신합니다. 각 공고에는 원문 보기 링크가 있어 상세 조건과 첨부파일을 제공 기관 페이지에서 바로 확인할 수 있습니다.',
  },
  {
    question: '기업 정보는 저장되나요? 계정을 삭제하면 어떻게 되나요?',
    answer: '기업 프로필은 계정에 저장됩니다. 계정을 삭제하면 기업 프로필·대화 기록·로그인 정보가 지워지며, 진행 중이던 모집글은 마감되고 보낸 제안은 철회됩니다.',
  },
  {
    question: '파트너 모집글은 누가 올릴 수 있나요?',
    answer: '이메일 인증과 사업자 상태 확인을 마친 기업 등록 회원만 모집글을 올리고 제안을 보낼 수 있습니다. 회원은 모집글과 상세를 읽을 수 있고, 로그인 전에는 공개 목록만 볼 수 있습니다.',
  },
] as const

export type PricingPlanId = typeof pricingPlans[number]['id']

export const pricingTitle = '기업의 다음 단계에 맞는 요금제'

export const pricingReleaseNote = '표시한 가격은 예정가이며 출시 시 확정합니다. 플러스는 정식 출시 전까지 회원에게 무료로 제공하고, 프리미엄은 출시 예정이며, 현재 결제·구독은 제공하지 않습니다.'
