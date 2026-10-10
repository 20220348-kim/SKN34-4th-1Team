// 무료(모든 회원)·플러스·프리미엄(30일 이용권) 세 단계입니다. 요금제의 차이는 기능이 아니라 횟수라 카드마다 한도를
// 적습니다. 무료는 "하루 10회·월 3건"처럼 기간과 함께, 유료는 가격 뒤의 이용 기간(`pricePeriod`, "/ 30일")에 쓰는 총량만 적습니다.
// 한도 숫자는 Core `planusage/domain/PlanCode.kt`가 원본이며 바꾸면 함께 고칩니다. 지금은 결제·구독을 받지 않습니다.
// 카드의 상태 배지는 고정 문구를 두지 않고, 로그인한 회원의 지금 요금제에만 "이용 중"을 붙입니다.
export const pricingPlans = [
  {
    id: 'free',
    code: 'FREE',
    label: 'FREE',
    name: '무료',
    description: '우리 기업에 맞는 지원사업을 찾고, 공고 조건 확인과 신청 준비를 직접 해 보고 싶다면.',
    price: '0원',
    pricePeriod: null,
    priceNote: '회원가입 후 바로 이용',
    limits: [
      'AI 대화 검색 하루 10회',
      '공고 원문 질문 하루 10회',
      '신청 문서 초안 월 3건',
      '중복 지원·수혜 검토 월 3회',
    ],
    footerNote: '로그인하지 않아도 AI 대화 검색을 하루 2회 써 볼 수 있어요.',
    isFeatured: false,
  },
  {
    id: 'plus',
    code: 'PLUS',
    label: 'PLUS',
    name: '플러스',
    description: '신청 시즌에 여러 공고를 비교하고 신청 문서까지 꾸준히 준비한다면.',
    price: '9,900원',
    pricePeriod: '/ 30일',
    priceNote: '부가세 포함',
    limits: [
      'AI 대화 검색 500회',
      '공고 원문 질문 500회',
      '신청 문서 초안 5건',
      '중복 지원·수혜 검토 10회',
    ],
    footerNote: '30일 동안 쓰는 이용권이에요. 자동으로 갱신되지 않아요.',
    isFeatured: true,
  },
  {
    id: 'premium',
    code: 'PREMIUM',
    label: 'PREMIUM',
    name: '프리미엄',
    description: '여러 사업을 함께 준비하거나 신청 문서를 많이 만든다면.',
    price: '29,000원',
    pricePeriod: '/ 30일',
    priceNote: '부가세 포함',
    limits: [
      'AI 대화 검색 1,500회',
      '공고 원문 질문 1,500회',
      '신청 문서 초안 20건',
      '중복 지원·수혜 검토 40회',
    ],
    footerNote: '30일 동안 쓰는 이용권이에요. 자동으로 갱신되지 않아요.',
    isFeatured: false,
  },
] as const

/** 모든 요금제에서 횟수를 세지 않는 기능입니다. */
export const pricingUnlimitedNote = '필터 검색, 공고 상세와 첨부 받기, 관심 공고 관리, 도우미 질문은 요금제와 관계없이 횟수를 세지 않아요.'

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
    description: '기업마당·K-Startup 공고 상세에서 궁금한 내용을 질문하고, 답변의 근거를 원문과 함께 확인하세요.',
  },
] as const

export const pricingFrequentlyAskedQuestions = [
  {
    question: '무료 요금제에서는 무엇을 할 수 있나요?',
    answer: '회원가입 후 AI 대화 검색과 공고 원문 질문을 하루 10회씩, 신청 문서 초안과 중복 지원·수혜 검토를 월 3건·3회씩 쓸 수 있습니다. 필터 검색, 공고 상세, 관심 공고 관리는 횟수를 세지 않고, 로그인하지 않아도 AI 대화 검색을 하루 2회 써 볼 수 있습니다.',
  },
  {
    question: '플러스와 프리미엄은 무엇이 다르고, 지금 쓸 수 있나요?',
    answer: '기능은 같고 쓸 수 있는 횟수가 다릅니다. 플러스와 프리미엄은 30일 동안 카드에 적은 횟수까지 씁니다. 아직 결제는 받지 않으며, 지금은 회원이 요금제마다 한 번 14일 동안 무료로 체험할 수 있습니다. 결제 수단을 받지 않으므로 체험이 끝나면 자동 결제 없이 무료로 돌아갑니다. 결제는 정식 출시 때 열고 가격도 그때 확정합니다.',
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
export type PricingPlan = typeof pricingPlans[number]

export const pricingTitle = '기업의 다음 단계에 맞는 요금제'
