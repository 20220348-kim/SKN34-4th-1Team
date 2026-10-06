import { matchPath } from 'react-router'

import { appPaths, publicPaths } from './appPaths'

/**
 * 화면 이름입니다. 브라우저 제목("화면 이름 · GovBiz")과 사이드바 메뉴·검색 탭이 이 이름을 함께 씁니다.
 * 이름은 사이드바·머리글(h1)·탭에 보이는 글자와 같아야 합니다. 화면 이름을 바꾸면 여기와 그 화면의 머리글을 함께 고칩니다.
 */
export const screenTitles = {
  aiSearch: 'AI 대화 검색',
  filterSearch: '필터 검색',
  pricing: '요금제',
  publicPartners: '파트너 모집',
  partnerManagement: '파트너 관리',
  myPartnerRecruitments: '내 모집글',
  proposals: '제안함',
  partnerRecruitmentDetail: '모집글 상세',
  partnerRecruitmentNew: '모집글 작성',
  partnerRecruitmentEdit: '모집글 수정',
  supportProgramDetail: '공고 상세',
  supportProgramQuestion: '이 공고에 질문하기',
  login: '로그인',
  signup: '회원가입',
  forgotPassword: '비밀번호 찾기',
  resetPassword: '새 비밀번호 설정',
  reportEmail: '리포트 수신 설정',
  welcome: '회원 유형 선택',
  welcomeCompany: '기업 정보 등록',
  reports: '기업 맞춤 리포트',
  savedPrograms: '관심 공고함',
  applicationPreparations: '신청 문서 작성',
  applicationPreparationNew: '새 문서',
  applicationPreparationEditor: '답변 입력',
  applicationPreparationDocuments: '신청 문서 초안',
  combinationReviews: '중복 지원·수혜 검토',
  combinationReviewNew: '새 검토',
  combinationReviewDetail: '검토',
  combinationReviewRunResult: '검토 결과',
  profile: '내 프로필',
  adminAccounts: '회원 관리',
  adminAccountDetail: '계정 상세',
  adminAuditLogs: '감사 기록',
  sampleItemHook: '상태관리 예제(Hook)',
  sampleItemRedux: '상태관리 예제(Redux)',
} as const

// 위에서부터 처음 맞는 경로의 이름을 씁니다. `new`처럼 고정된 경로를 `:id` 경로보다 먼저 둡니다.
const routeTitles: readonly (readonly [pattern: string, title: string])[] = [
  [appPaths.welcome, screenTitles.welcome],
  [appPaths.welcomeCompany, screenTitles.welcomeCompany],
  [appPaths.reports, screenTitles.reports],
  [appPaths.savedPrograms, screenTitles.savedPrograms],
  [appPaths.applicationPreparations, screenTitles.applicationPreparations],
  [appPaths.applicationPreparationNew, screenTitles.applicationPreparationNew],
  [appPaths.applicationPreparationDocuments, screenTitles.applicationPreparationDocuments],
  [appPaths.applicationPreparationDetail, screenTitles.applicationPreparationEditor],
  [appPaths.combinationReviews, screenTitles.combinationReviews],
  [appPaths.combinationReviewNew, screenTitles.combinationReviewNew],
  [appPaths.combinationReviewRunResult, screenTitles.combinationReviewRunResult],
  [appPaths.combinationReviewDetail, screenTitles.combinationReviewDetail],
  [appPaths.pricing, screenTitles.pricing],
  [appPaths.partners, screenTitles.partnerManagement],
  [appPaths.partnerNew, screenTitles.partnerRecruitmentNew],
  [appPaths.partnerEdit, screenTitles.partnerRecruitmentEdit],
  [appPaths.myPartners, screenTitles.myPartnerRecruitments],
  [appPaths.partnerDetail, screenTitles.partnerRecruitmentDetail],
  [appPaths.proposals, screenTitles.proposals],
  [appPaths.profile, screenTitles.profile],
  [appPaths.adminAccounts, screenTitles.adminAccounts],
  [appPaths.adminAccountDetail, screenTitles.adminAccountDetail],
  [appPaths.adminAuditLogs, screenTitles.adminAuditLogs],
  [appPaths.supportProgramDetail, screenTitles.supportProgramDetail],
  [appPaths.supportProgramQuestion, screenTitles.supportProgramQuestion],
  [publicPaths.pricing, screenTitles.pricing],
  [publicPaths.partners, screenTitles.publicPartners],
  [publicPaths.partnerDetail, screenTitles.partnerRecruitmentDetail],
  [publicPaths.supportProgramDetail, screenTitles.supportProgramDetail],
  [publicPaths.supportProgramQuestion, screenTitles.supportProgramQuestion],
  [publicPaths.login, screenTitles.login],
  [publicPaths.signup, screenTitles.signup],
  [publicPaths.forgotPassword, screenTitles.forgotPassword],
  [publicPaths.resetPassword, screenTitles.resetPassword],
  [publicPaths.oauthComplete, screenTitles.login],
  [publicPaths.reportEmail, screenTitles.reportEmail],
  ['/examples/sample-item/hook', screenTitles.sampleItemHook],
  ['/examples/sample-item/redux', screenTitles.sampleItemRedux],
]

/** 주소의 화면 이름입니다. 검색 화면(`/`, `/app/chat`)은 `?mode=filter`면 필터 검색, 아니면 AI 검색입니다. 모르는 주소면 null입니다. */
export function screenTitleFor(pathname: string, search = ''): string | null {
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  if (path === publicPaths.landing || path === appPaths.chat) {
    return new URLSearchParams(search).get('mode') === 'filter' ? screenTitles.filterSearch : screenTitles.aiSearch
  }
  return routeTitles.find(([pattern]) => matchPath(pattern, path) !== null)?.[1] ?? null
}

/** 브라우저 제목입니다. "관심 공고함 · GovBiz"처럼 화면 이름을 앞에 두고, 이름이 없는 주소는 "GovBiz"만 씁니다. */
export function documentTitleFor(pathname: string, search = ''): string {
  const title = screenTitleFor(pathname, search)
  return title === null ? 'GovBiz' : `${title} · GovBiz`
}
