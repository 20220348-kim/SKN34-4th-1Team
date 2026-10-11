import type { AssistantHelpEntryInput } from '@govbiz/shared/domain/repositories/AssistantRepository'
import { screenTitles } from '@govbiz/shared/design/screenTitles'

export type AssistantHelpTopic = '검색' | '관심 공고' | '리포트' | '신청문서' | '협업' | '계정'
export type MobileAssistantHelp = AssistantHelpEntryInput & { topic: AssistantHelpTopic; companyAction?: boolean; contextual?: 'program-question' }
export const assistantHelpTopics: AssistantHelpTopic[] = ['검색', '관심 공고', '리포트', '신청문서', '협업', '계정']

export const assistantHelpEntries: MobileAssistantHelp[] = [
  { id: 'mobile-program-question', topic: '검색', title: '선택 공고의 원문 질문', question: '이 공고의 원문에 질문하고 싶어요.',
    summary: '선택한 공고의 원문을 근거로 답변과 인용을 확인할 수 있어요.', body: ['공고 상세의 원문에 질문하기에서 궁금한 점을 입력하고 직접 전송하세요. 도우미에서 화면을 열어도 질문을 자동으로 실행하지 않아요.'],
    limitation: '원문 질문을 지원하지 않는 제공처 공고는 공식 원문에서 확인하세요.', audience: 'member', status: 'available', action: { label: '공고 검색 열기', to: '/app/chat' }, contextual: 'program-question' },
  { id: 'mobile-search-confirm', topic: '검색', title: 'AI 검색 조건 확인', question: '검색이 왜 바로 안 되나요?',
    summary: 'AI가 정리한 조건을 확인한 뒤 검색해요.', body: ['검색 탭의 AI 대화 검색에 회사의 지역·업종과 필요한 지원을 입력하세요. 정보가 부족하면 추가 질문에 답하고, 제안한 조건을 확인한 뒤 이 조건으로 검색을 누르세요.'],
    limitation: '조건 확인 전에는 검색을 실행하지 않아요.', audience: 'public', status: 'available', action: { label: 'AI 검색 화면 열기', to: '/app/chat' } },
  { id: 'mobile-search-score', topic: '검색', title: '관련도와 신청 자격', question: '관련도 점수가 높으면 신청할 수 있나요?',
    summary: '관련도는 추천 순서용 점수예요. 신청 자격이나 선정 확률이 아니에요.', body: ['공고 상세의 지원 대상과 원문 근거를 확인하세요. 원문에 질문하기는 지원하는 제공처 공고에서 이용할 수 있어요.'],
    limitation: '최종 신청 조건은 공식 공고 원문에서 확인하세요.', audience: 'public', status: 'available', action: { label: '검색 화면 열기', to: '/app/chat' } },
  { id: 'mobile-saved-programs', topic: '관심 공고', title: '관심 공고함 사용법', question: '저장한 공고는 어디서 보나요?',
    summary: '하단 관심함에서 담은 공고와 신청 준비를 이어갈 수 있어요.', body: ['검색 결과나 공고 상세에서 공고를 저장하세요. 관심 공고함에서 목록·달력·진행 관리와 신청 준비를 확인할 수 있어요.'],
    limitation: null, audience: 'member', status: 'available', action: { label: '관심 공고함 열기', to: '/app/saved-programs' } },
  { id: 'mobile-reports', topic: '리포트', title: '맞춤 리포트 확인', question: '맞춤 리포트는 어떻게 확인하나요?',
    summary: '등록한 기업 정보를 바탕으로 하단 리포트에서 추천 공고를 확인해요.', body: ['리포트 위쪽 연필 버튼에서 기업 정보를 확인하세요. 알림 설정에서는 이메일과 이 기기의 앱 알림을 각각 선택할 수 있어요.'],
    limitation: '도우미를 열어도 새 리포트가 자동 생성되지 않아요.', audience: 'company', status: 'available', action: { label: '리포트 열기', to: '/app/reports' } },
  { id: 'mobile-report-settings', topic: '리포트', title: '리포트와 마감 알림 설정', question: '리포트·마감 알림은 어디에서 설정하나요?',
    summary: '리포트의 수신 설정에서 알림 설정을 열어 이메일과 기기 앱 알림을 각각 선택하세요.', body: ['리포트의 수신 설정을 펼치고 알림 설정을 누르세요. 관심 공고 마감 알림과 리포트 이메일·앱 알림을 설정할 수 있어요. 저장 결과와 기기의 알림 권한을 함께 확인하세요.'],
    limitation: '앱 알림을 켜도 기기 권한이나 서버 발송 설정이 준비되지 않으면 받을 수 없어요.', audience: 'member', status: 'available', action: { label: '리포트 열기', to: '/app/reports' } },
  { id: 'mobile-application-documents', topic: '신청문서', title: '신청문서 초안 작성', question: '신청문서 초안은 어떻게 만드나요?',
    summary: '공고·공식 양식 선택, 문항 답변, 검토를 거쳐 초안을 생성해요.', body: [`메뉴의 ${screenTitles.applicationPreparations}에서 ${screenTitles.applicationPreparationNew}를 시작하세요. 공고와 공식 양식을 선택하고 문항별 답변을 저장한 뒤 검토 화면에서 직접 초안 생성을 요청하세요.`],
    limitation: '생성 파일은 초안이에요. 최종 제출은 공식 신청 경로에서 직접 진행하세요.', audience: 'member', status: 'available', action: { label: `${screenTitles.applicationPreparationNew} 시작`, to: '/app/application-preparations/new' } },
  { id: 'mobile-document-job', topic: '신청문서', title: '문서 생성 결과 확인', question: '문서 생성 결과를 확인하지 못했어요.',
    summary: '기존 작업 상태를 먼저 확인하고 같은 요청을 중복 생성하지 마세요.', body: [`${screenTitles.applicationPreparationDocuments} 화면에서 작업 상태 확인을 이용하세요. 접수 여부가 불명확하면 보관된 요청으로 기존 작업을 확인하고, 완료된 파일은 초안 다운로드로 받으세요.`],
    limitation: '도우미에서 문서 생성을 대신 실행하지 않아요.', audience: 'member', status: 'available', action: { label: `${screenTitles.applicationPreparations} 열기`, to: '/app/application-preparations' } },
  { id: 'mobile-document-answers', topic: '신청문서', title: '신청문서 답변 저장과 검토', question: '작성한 답변은 어떻게 저장하고 검토하나요?',
    summary: `${screenTitles.applicationPreparationEditor} 화면의 저장 상태를 확인하고 필수 문항을 검토한 뒤 초안을 생성하세요.`, body: ['입력한 답변은 자동 저장합니다. 저장 오류나 충돌이 있으면 현재 입력을 유지한 채 저장 상태를 먼저 확인하세요. 모르는 내용은 미정으로 표시하고, 검토 화면에서 필수 입력과 저장된 답변을 확인하세요.'],
    limitation: '도우미가 빈 답변을 기업 사실로 만들어 채우거나 문서를 자동 제출하지 않아요.', audience: 'member', status: 'available', action: { label: `${screenTitles.applicationPreparations} 열기`, to: '/app/application-preparations' } },
  { id: 'mobile-online-form', topic: '신청문서', title: '구글폼 입력 도우미', question: '구글폼 제출도 자동으로 되나요?',
    summary: '저장된 답변을 복사하거나 내보내고 공식 구글폼에서 직접 제출해요.', body: ['구글폼 입력 도우미에서 저장된 답변을 확인하고 복사·TXT 내보내기를 이용하세요. 공식 구글폼을 열어 입력 내용을 확인한 뒤 직접 제출하세요.'],
    limitation: '지원되는 구글폼 신청 경로에서만 제공하며 자동 제출하지 않아요.', audience: 'member', status: 'available', action: null },
  { id: 'mobile-combination-review', topic: '신청문서', title: screenTitles.combinationReviews, question: '두 공고의 중복 지원은 어떻게 검토하나요?',
    summary: `메뉴의 ${screenTitles.combinationReviews}에서 공고를 선택하고 검토를 요청하세요.`, body: ['검토 결과의 근거와 확인 필요 항목을 함께 읽으세요. 최종 중복 지원·수혜 허용 여부는 공식 공고와 담당 기관에 확인하세요.'],
    limitation: '검토 결과는 최종 승인이나 법적 판단이 아니에요.', audience: 'member', status: 'available', action: { label: `${screenTitles.combinationReviews} 열기`, to: '/app/combination-reviews' } },
  { id: 'mobile-partners', topic: '협업', title: '파트너와 제안 관리', question: '파트너와 받은 제안은 어디서 보나요?',
    summary: `메뉴의 ${screenTitles.publicPartners}과 ${screenTitles.partnerManagement}에서 협업을 이어가세요.`, body: [`${screenTitles.publicPartners}에서 함께할 파트너를 찾아보세요. ${screenTitles.partnerManagement}에서 받은 제안·보낸 제안과 내 모집글을 확인할 수 있어요.`],
    limitation: '모집글 작성 등 기업 기능은 기업 등록 상태를 확인해요.', audience: 'member', status: 'available', action: { label: '받은 제안 열기', to: '/app/proposals' } },
  { id: 'mobile-company-profile', topic: '계정', title: '기업 정보와 계정 관리', question: '기업 정보는 어디서 수정하나요?',
    summary: `${screenTitles.profile} 또는 리포트에서 기업 프로필을 열어 등록·수정할 수 있어요.`, body: [`메뉴의 ${screenTitles.profile}에서 이메일과 로그인 정보를 확인하세요. ${screenTitles.companyProfile}에서 사업자 조회와 기업 정보 등록·수정을 진행하세요.`],
    limitation: '도우미가 계정이나 기업 정보를 임의로 변경하지 않아요.', audience: 'member', status: 'available', action: { label: `${screenTitles.companyProfile} 열기`, to: '/app/profile' }, companyAction: true },
  { id: 'mobile-company-registration', topic: '계정', title: '기업 정보 등록', question: '기업 등록은 어떻게 하나요?',
    summary: '기업 프로필에서 사업자 정보를 조회하고 기업 정보를 등록하세요.', body: [`${screenTitles.profile}이나 리포트에서 기업 프로필을 열고 사업자 조회 결과를 확인하세요. 등록·수정 결과를 저장한 뒤 기업 맞춤 리포트 등 기업 기능을 이용하세요.`],
    limitation: '사업자 상태에 따라 등록 가능 여부를 확인하며 조회 실패를 임의 기업 정보로 대체하지 않아요.', audience: 'member', status: 'available', action: { label: `${screenTitles.companyProfile} 열기`, to: '/app/profile' }, companyAction: true },
  { id: 'mobile-account', topic: '계정', title: '로그인과 계정 관리', question: '비밀번호와 계정 정보는 어디서 관리하나요?',
    summary: `메뉴의 ${screenTitles.profile}에서 로그인 정보와 비밀번호·탈퇴 항목을 확인하세요.`, body: [`${screenTitles.profile}에서 필요한 항목을 선택하고 본인 확인을 진행하세요. 계정 삭제는 삭제 대상을 확인하고 명시적으로 요청한 뒤 처리합니다.`],
    limitation: '도우미에서 비밀번호를 받거나 계정 삭제를 대신 실행하지 않아요.', audience: 'member', status: 'available', action: { label: `${screenTitles.profile} 열기`, to: '/app/profile' } },
  { id: 'mobile-pricing', topic: '계정', title: '요금제 기능 안내', question: '요금제별 기능은 어디서 확인하나요?',
    summary: '요금제 화면에서 각 요금제의 기능과 이용 안내를 확인하세요.', body: ['메뉴의 요금제에서 표시된 기능과 최신 안내를 비교하세요. 실제 제공 상태와 준비 중인 항목을 구분해서 읽어 주세요.'],
    limitation: '도우미에서 결제나 요금제 변경을 처리하지 않아요.', audience: 'member', status: 'available', action: { label: '요금제 열기', to: '/app/pricing' } },
]

/** 열린 페이지의 주요 질문만 먼저 보여 주고 전체 주제는 별도로 제공합니다. */
export function assistantPageHelp(path: string, programSelected: boolean) {
  let label: string = screenTitles.menu, ids = ['mobile-search-confirm', 'mobile-application-documents', 'mobile-account']
  if (path === '/' || path === '/chat') { label = screenTitles.supportProgramSearch; ids = ['mobile-search-confirm', 'mobile-search-score'] }
  else if (path === '/program') { label = screenTitles.supportProgramDetail; ids = programSelected ? ['mobile-program-question', 'mobile-search-score', 'mobile-application-documents'] : ['mobile-search-score', 'mobile-search-confirm'] }
  else if (path === '/saved') { label = screenTitles.savedPrograms; ids = ['mobile-saved-programs', 'mobile-report-settings', 'mobile-application-documents'] }
  else if (path === '/report') { label = screenTitles.reports; ids = ['mobile-reports', 'mobile-report-settings', 'mobile-company-profile'] }
  else if (path === '/all/settings') { label = screenTitles.notificationSettings; ids = ['mobile-report-settings', 'mobile-reports'] }
  else if (path === '/company' || path === '/all/company') { label = screenTitles.companyProfile; ids = ['mobile-company-registration', 'mobile-company-profile'] }
  else if (path === '/account' || path === '/all/account') { label = screenTitles.profile; ids = ['mobile-account', 'mobile-company-profile'] }
  else if (path === '/pricing' || path === '/all/pricing') { label = screenTitles.pricing; ids = ['mobile-pricing', 'mobile-account'] }
  else if (path === '/all/preparation' || path === '/all/preparation/new') { label = path.endsWith('/new') ? screenTitles.applicationPreparationNew : screenTitles.applicationPreparations; ids = ['mobile-application-documents', 'mobile-document-job'] }
  else if (path.startsWith('/all/preparation/')) {
    const result = path.endsWith('/documents'), online = path.endsWith('/online')
    label = result ? screenTitles.applicationPreparationDocuments : online ? screenTitles.onlineInputGuide : path.endsWith('/review') ? screenTitles.applicationPreparationReview : screenTitles.applicationPreparationEditor
    ids = result ? ['mobile-document-job', 'mobile-document-answers'] : online ? ['mobile-online-form', 'mobile-document-answers'] : ['mobile-document-answers', 'mobile-application-documents']
  } else if (path.startsWith('/all/reviews')) { label = path.endsWith('/new') ? screenTitles.combinationReviewNew : path === '/all/reviews' ? screenTitles.combinationReviews : screenTitles.combinationReviewDetail; ids = ['mobile-combination-review', 'mobile-search-score'] }
  else if (path === '/collab' || path === '/all/collab' || path.startsWith('/partner/')) {
    label = path === '/partner/new' ? screenTitles.partnerRecruitmentNew : path === '/partner/edit' ? screenTitles.partnerRecruitmentEdit : path.startsWith('/partner/') ? screenTitles.partnerRecruitmentDetail : screenTitles.publicPartners
    ids = ['mobile-partners', 'mobile-company-profile']
  }
  return { label, questions: ids.map(id => {
    const entry = assistantHelpEntries.find(value => value.id === id)
    if (!entry) throw new Error(`Missing assistant help: ${id}`)
    return entry
  }) }
}

export function assistantHelpInput(): AssistantHelpEntryInput[] {
  return assistantHelpEntries.map(({ topic: _topic, companyAction: _company, contextual: _contextual, ...entry }) => ({ ...entry, body: [...entry.body] }))
}
