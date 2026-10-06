import { APP_PREFIX, appPaths, isAppPath, publicPaths, toAppPath } from '../routes/appPaths'
import type { HelpEntry, HelpSurface } from './helpTypes'

/**
 * 도움말 항목 한 벌입니다. 화면 문구를 여기에 모아 가이드·FAQ·매뉴얼·챗봇이 같은 내용을 씁니다.
 * 지금은 사용자가 설명 없이 오해하는 동작(blocker)부터 채웁니다. 화면별 안내는 이어서 추가합니다.
 */
export const helpEntries: readonly HelpEntry[] = [
  {
    id: 'search-confirm-card',
    title: '검색이 왜 바로 되지 않고 확인을 먼저 받나요',
    question: '검색이 왜 바로 안 되나요?',
    summary: '메시지에서 바꿀 조건을 먼저 제안하고, 확인을 눌러야 검색합니다. 잘못 해석한 조건으로 검색하지 않기 위해서입니다.',
    body: [
      '대화로 조건을 말하면 지역·업종·설립일·지원 목적 가운데 무엇을 어떻게 바꿀지 제안 카드로 보여 줍니다.',
      '카드에서 검색을 누르면 그 조건으로 검색하고, 취소하면 이전 조건이 그대로 남습니다. 확인하지 않은 제안은 적용되지 않습니다.',
      '조건이 모호하면 검색 대신 질문합니다. 예를 들어 "부산이나 대구로"처럼 하나를 고를 수 없으면 어느 쪽인지 묻고 기존 지역을 바꾸지 않습니다.',
    ],
    limitation: '확인을 건너뛰고 바로 검색하는 설정은 없습니다.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.chat],
    action: { label: '검색 화면 열기', to: appPaths.chat },
    status: 'available',
    related: ['search-score-meaning'],
    updatedOn: '2026-09-10',
  },
  {
    id: 'search-score-meaning',
    title: '점수는 무엇을 뜻하나요',
    question: '점수는 무슨 뜻인가요?',
    summary: '점수는 검색어와 공고의 관련도입니다. 신청 자격이나 선정 가능성을 뜻하지 않습니다.',
    body: [
      '점수는 검색한 내용과 공고가 의미상 얼마나 맞는지, 찾는 지원 형태와 맞는지를 합해 계산합니다.',
      '자격이 확인되지 않았다는 이유로 점수를 깎지 않습니다. 그래서 점수가 높은 공고에도 확인 필요 배지가 붙을 수 있습니다.',
      '점수는 결과의 순서를 정하기 위한 값이며 선정될 가능성이 아닙니다.',
    ],
    limitation: '선정 가능성이나 합격률은 제공하지 않습니다.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.chat],
    action: { label: '검색 화면 열기', to: appPaths.chat },
    status: 'available',
    related: ['eligibility-unknown'],
    updatedOn: '2026-09-10',
  },
  {
    id: 'eligibility-unknown',
    title: '확인 필요는 무슨 뜻인가요',
    question: '확인 필요는 왜 뜨나요?',
    summary: '공고의 공식 요약만으로 지역·대상 조건을 판단할 수 없을 때 붙어요. 자격이 없다는 뜻이 아니에요.',
    body: [
      '검색 결과 카드는 지원 대상과 지역을 각각 "본문 조건 확인" 또는 "확인 필요"로 표시해요.',
      '명백히 맞지 않는 공고는 추천에서 빼지만 확인 필요는 남겨 둬요. 정보가 부족한 것과 자격이 없는 것은 다르기 때문이에요.',
      '확인 필요 공고는 상세 화면의 [원문에 질문하기]에서 해당 조건을 직접 물어 확인할 수 있어요.',
    ],
    limitation: '첨부 파일(PDF·HWP)까지 읽은 최종 자격 판정은 아직 제공하지 않아요.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.chat, appPaths.supportProgramDetail],
    action: { label: '검색 화면 열기', to: appPaths.chat },
    status: 'available',
    related: ['search-score-meaning', 'evidence-insufficient'],
    updatedOn: '2026-10-04',
  },
  {
    id: 'status-unknown-source',
    title: '상태 확인 필요는 무엇인가요',
    question: '상태 확인 필요는 뭔가요?',
    summary: '일부 제공처는 접수 기간을 정해진 형식으로 주지 않아 접수 중인지 마감인지 확인할 수 없습니다.',
    body: [
      '과학기술정보통신부와 충청남도 온라인수출지원시스템 공고는 시작일·마감일이 구조화된 형태로 제공되지 않습니다.',
      '이런 공고는 접수 중으로도 마감으로도 표시하지 않고 상태 확인 필요로 조회합니다. 확인할 수 없는 것을 확인한 것처럼 바꾸지 않기 위해서입니다.',
      '실제 접수 여부는 공고 원문에서 확인해야 합니다.',
    ],
    limitation: '상태 확인 필요 공고를 접수 중 목록에 섞어 보여 주지 않습니다.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.chat],
    action: { label: '필터 검색 열기', to: `${appPaths.chat}?mode=filter` },
    status: 'available',
    related: ['search-score-meaning'],
    updatedOn: '2026-09-10',
  },
  {
    id: 'evidence-insufficient',
    title: '근거를 찾지 못했다고 나오는 이유',
    question: '질문에 답을 못 한다고 나와요',
    summary: '공고 원문에서 질문에 답할 근거를 찾지 못하면 추측하지 않고 근거 없음으로 알립니다.',
    body: [
      '원문 질문은 공고의 공식 원문 문단을 찾아 그 문장을 인용해 답합니다.',
      '원문에 없는 내용은 만들어 내지 않습니다. 근거를 찾지 못하면 답 대신 근거가 부족하다고 알립니다.',
      '지금은 공고 본문만 읽고 첨부 파일은 읽지 않습니다. 첨부에만 적힌 내용은 근거 없음으로 나옵니다.',
    ],
    limitation: '첨부 파일(PDF·HWP)은 아직 읽지 않습니다.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.supportProgramDetail, appPaths.supportProgramQuestion],
    action: { label: '검색 화면 열기', to: appPaths.chat },
    status: 'available',
    related: ['eligibility-unknown'],
    updatedOn: '2026-09-10',
  },
  {
    id: 'review-save-vs-run',
    title: '검토 저장과 분석 실행은 무엇이 다른가요',
    question: '저장과 분석 실행은 뭐가 다른가요?',
    summary: '입력은 단계를 넘길 때 자동 저장되고, 유료 분석은 공고 분석 단계의 [검토 실행]을 누를 때만 접수됩니다.',
    body: [
      '관심 공고함이나 전체 검색에서 공고를 정확히 2개 고르고 참여 상태를 입력합니다.',
      '[다음]으로 단계를 넘기면 제목·공고·참여 상태가 저장됩니다. 공고 분석 단계에서 [검토 실행]을 누르면 분석 대기열에 작업을 접수합니다.',
      '실행 결과는 실행 이력에 남아 나중에 다시 열어 볼 수 있습니다.',
    ],
    limitation: null,
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'company',
    routes: [appPaths.combinationReviews],
    action: { label: '중복 검토 열기', to: appPaths.combinationReviews },
    status: 'available',
    related: ['review-input-revision'],
    updatedOn: '2026-09-13',
  },
  {
    id: 'review-input-revision',
    title: '입력 버전은 무엇인가요',
    question: '입력 버전이 무엇인가요?',
    summary: '입력을 저장할 때마다 버전이 올라가요. 분석은 특정 버전을 대상으로 실행하므로 도중에 입력이 바뀌면 실행 요청을 거절해요.',
    body: [
      '분석 결과는 어떤 입력으로 나온 것인지 분명해야 해요. 그래서 실행은 저장된 입력 버전 하나를 대상으로 해요.',
      '실행을 요청한 뒤 입력이 바뀌면 그 요청은 거절돼요. 작성 중인 내용은 사라지지 않으므로 다시 저장하고 실행하면 돼요.',
      '응답을 받지 못한 요청은 그대로 보관해요. 같은 요청을 다시 확인하면 중복 실행 없이 결과를 확인해요.',
    ],
    limitation: '응답을 확인하지 못한 분석 요청이 남아 있으면 그 요청을 확인하기 전까지 입력을 저장하지 않아요.',
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'company',
    routes: [appPaths.combinationReviews],
    action: { label: '중복 검토 열기', to: appPaths.combinationReviews },
    status: 'available',
    related: ['review-save-vs-run'],
    updatedOn: '2026-10-04',
  },
  {
    id: 'partner-write-requires-company',
    title: '모집글은 누가 쓸 수 있나요',
    question: '모집글은 어떻게 쓰나요?',
    summary: '파트너 모집글은 기업을 등록한 회원만 쓸 수 있어요. 등록 전에는 [모집글 작성] 대신 [기업 등록 후 작성]이 보이고, 누르면 프로필로 가요.',
    body: [
      '모집글은 함께할 기업을 찾는 글이라 누가 올렸는지 확인할 수 있어야 해요.',
      '프로필에서 사업자등록번호를 조회하면 기업명과 사업자 상태가 채워지고, 소재지·업종·설립연도를 입력해 등록해요.',
      '등록하면 모집글 작성과 참여 제안 보내기를 쓸 수 있어요. 목록과 상세 보기는 등록 없이도 돼요.',
    ],
    limitation: null,
    category: 'blocker',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'member',
    routes: [appPaths.partners, appPaths.profile],
    action: { label: '내 프로필 열기', to: appPaths.profile },
    status: 'available',
    related: [],
    updatedOn: '2026-10-04',
  },
  {
    id: 'search-slow-or-failed',
    title: '검색이 오래 걸리거나 실패합니다',
    question: '검색이 오래 걸려요',
    summary: '검색은 정해진 시간 안에 끝나지 않으면 중단하고 오류를 알립니다. 실패를 결과 0건으로 바꾸지 않습니다.',
    body: [
      '공고 검색은 AI가 후보 공고를 하나씩 검토해 순서를 정하므로 시간이 걸립니다.',
      '시간이 초과되면 시간 초과라고 알립니다. 같은 조건으로 다시 검색할 수 있고 입력한 내용은 남습니다.',
      '짧은 시간에 요청이 많으면 잠시 제한됩니다. 잠시 뒤 다시 시도해 주세요.',
      '검색에 실패했을 때 결과가 없다고 표시하지 않습니다. 0건과 실패는 다르게 안내합니다.',
    ],
    limitation: null,
    category: 'error',
    surfaces: ['faq', 'manual', 'chatbot'],
    audience: 'public',
    routes: [appPaths.chat],
    action: { label: '검색 화면 열기', to: appPaths.chat },
    status: 'available',
    related: ['search-confirm-card'],
    updatedOn: '2026-09-10',
  },
  {
    id: 'saved-programs-pipeline',
    title: '관심 공고함에서 무엇을 할 수 있나요',
    question: '관심 공고함은 어떻게 쓰나요?',
    summary: '공고 상세에서 담은 공고를 목록·달력·진행 관리로 보고, 신청 준비 중인 공고의 진행 단계를 바꿔요.',
    body: [
      '목록(기본)은 마감 임박순으로, 달력은 접수 시작일과 마감일을 월별로 보여 줘요. 검색어와 지역·분야·대상 필터는 세 보기에 함께 적용돼요.',
      '진행 관리는 관심 → 준비 중 → 제출 완료 → 심사 중(서류·발표) → 결과(선정·미선정) 5칸이에요. 관심 칸 카드의 [신청 문서 작성]을 누르면 그 공고를 고른 새 문서 화면이 열려요.',
      '단계는 카드의 [단계 바꾸기]나 목록의 진행 단계 배지를 눌러 여는 옆 패널에서 골라 [저장]해요. 순서와 관계없이 바꿀 수 있고, 다른 곳에서 먼저 바뀐 건은 저장을 거절하니 최신 상태를 다시 불러온 뒤 바꿔 주세요.',
    ],
    limitation: '마감 알림은 내 프로필에서 켜면 마감 7일·3일·1일 전에 이메일이나 앱 알림으로 한 번씩 보내요. 서버 발송이 꺼진 환경에서는 오지 않으니 목록의 D-day나 달력, 도우미의 "관심 공고 마감 확인"에서도 확인해요.',
    category: 'screen',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'member',
    routes: [appPaths.savedPrograms],
    action: { label: '관심 공고함 열기', to: appPaths.savedPrograms },
    status: 'available',
    related: ['application-preparation-flow'],
    updatedOn: '2026-10-04',
  },
  {
    id: 'application-preparation-flow',
    title: '신청 문서 작성은 어떻게 진행되나요',
    question: '신청 문서는 어떻게 만드나요?',
    summary: '공고를 고르면 저장된 신청 양식을 보여 주고, 양식이 있으면 바로 작성을 시작해요. 없으면 [입력칸별로 분석]으로 공식 첨부에서 문항을 뽑을 수 있어요.',
    body: [
      '[새 문서]의 [공고 고르기]에서 관심 공고함이나 전체 검색의 공고를 고르면 그 공고의 저장된 양식과 상태를 보여 줘요.',
      '저장된 양식이 없으면 [입력칸별로 분석]으로 AI가 공식 첨부를 읽어 문항을 뽑아요. 유료 AI 호출이며 계정당 동시에 3건까지 할 수 있어요.',
      '문항별 답변을 확인해 저장해요. 저장할 때마다 입력 버전이 올라가며, 확인한 답변으로 공식 양식의 초안을 만들어요.',
    ],
    limitation: '최종 파일은 공식 원본의 해시가 저장된 양식과 같을 때만 만들어요. 원본이 바뀌거나 없어지면 다시 분석한 뒤 새로 작성해야 해요.',
    category: 'screen',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'member',
    routes: [appPaths.applicationPreparations],
    action: { label: '신청 문서 작성 열기', to: appPaths.applicationPreparations },
    status: 'available',
    related: ['saved-programs-pipeline', 'review-input-revision'],
    updatedOn: '2026-10-04',
  },
  {
    id: 'proposal-box',
    title: '제안함에서는 무엇을 하나요',
    question: '받은 제안은 어떻게 처리하나요?',
    summary: '받은 제안은 제안함에서 수락하거나 거절하고, 보낸 제안은 응답 전까지 철회할 수 있습니다. 수락하면 서로의 담당자 연락처가 열립니다.',
    body: [
      '받은 제안은 내 모집글로 온 제안이고, 보낸 제안은 내가 다른 모집글에 보낸 제안입니다. 둘 다 기업을 등록한 회원만 주고받습니다.',
      '받은 제안은 7일 안에 수락·거절해야 하며, 응답이 없거나 모집이 끝나면 만료됩니다.',
      '수락한 제안만 상대 담당자 이메일이 보이고, 거절·철회·만료된 제안은 연락처를 열지 않습니다.',
    ],
    limitation: '제안이 오면 알려 주는 알림은 아직 없습니다. 제안함이나 도우미의 "받은 제안 확인"에서 확인합니다.',
    category: 'screen',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'company',
    routes: [appPaths.proposals],
    action: { label: '제안함 열기', to: appPaths.proposals },
    status: 'available',
    related: ['partner-write-requires-company'],
    updatedOn: '2026-09-13',
  },
  {
    id: 'daily-report',
    title: '기업 맞춤 리포트는 무엇인가요',
    question: '리포트 이메일은 어떻게 받나요?',
    summary: '등록한 기업의 지역·업종·지원 목적에 맞는 접수 중 공고를 최대 3건 골라 리포트로 보여 주고, 주소를 확인하고 수신에 동의하면 정기 이메일로 보내요.',
    body: [
      '기업 정보를 등록해야 리포트를 만들 수 있어요. 화면에서 가장 최근 리포트를 보고, 오늘 리포트가 없으면 [오늘의 리포트 만들기]로 하루 한 번 만들어요.',
      '정기 이메일은 수신 주소 확인 메일의 링크를 누르고 수신 동의를 저장해야 켜져요. 주소 확인은 계정의 이메일 인증과 별개예요.',
      '앱 알림은 모바일 앱의 전체 › 알림 설정에서 기기마다 켜요. 이메일 수신 중지는 리포트 화면이나 이메일의 해지 링크에서 언제든 할 수 있어요.',
    ],
    limitation: '서버의 이메일 발송이 꺼진 환경에서는 웹에서만 리포트를 볼 수 있어요. 관련도는 검색 순위용 점수이며 선정 확률이 아니에요.',
    category: 'screen',
    surfaces: ['guide', 'faq', 'manual', 'chatbot'],
    audience: 'company',
    routes: [appPaths.reports],
    action: { label: '리포트 열기', to: appPaths.reports },
    status: 'available',
    related: ['search-score-meaning'],
    updatedOn: '2026-10-04',
  },
]

/** `id`로 항목을 찾습니다. 챗봇 답변의 인용과 항목 사이 링크가 씁니다. */
export function findHelpEntry(id: string): HelpEntry | undefined {
  return helpEntries.find((entry) => entry.id === id)
}

/** 한 표면에 노출할 항목을 정의 순서대로 돌려줍니다. */
export function helpEntriesForSurface(surface: HelpSurface): HelpEntry[] {
  return helpEntries.filter((entry) => entry.surfaces.includes(surface))
}

/**
 * 지금 보고 있는 화면에서 추천할 챗봇 질문을 고릅니다.
 * 공개 경로는 대응하는 내부 경로로 바꿔 비교하므로 `/`와 `/app/chat`이 같은 결과를 냅니다.
 * 화면을 지정한 항목을 먼저, 화면과 무관한 항목을 나중에 둡니다.
 */
export function helpEntriesForRoute(pathname: string, limit = 3): HelpEntry[] {
  const current = isAppPath(pathname) ? pathname.replace(/\/+$/, '') || APP_PREFIX : toAppPath(pathname)
  const candidates = helpEntriesForSurface('chatbot')
  const matched = candidates.filter((entry) => entry.routes.some((route) => current === route || current.startsWith(`${route}/`)))
  const global = candidates.filter((entry) => entry.routes.length === 0)
  return [...matched, ...global].slice(0, limit)
}

/** 공개 화면에서는 같은 내용의 공개 경로로 바꿉니다. 대응 경로가 없으면 그대로 두고 기존 경로 보호가 로그인으로 안내합니다. */
export function helpActionHref(to: string, inApp: boolean): string {
  if (inApp) return to
  const [path = '', query] = to.split('?')
  const search = query === undefined ? '' : `?${query}`
  if (path === appPaths.chat) return `${publicPaths.landing}${search}`
  const mirrored = path.startsWith(APP_PREFIX) ? path.slice(APP_PREFIX.length) : ''
  const isPublic = (Object.values(publicPaths) as string[]).includes(mirrored)
  return isPublic ? `${mirrored}${search}` : to
}
