import { matchPath } from 'react-router'
import { screenTitles } from '@govbiz/shared/design/screenTitles'

import { appPaths, publicPaths } from './appPaths'

/**
 * 화면 이름입니다. 브라우저 제목("화면 이름 · GovBiz")과 사이드바 메뉴·검색 탭이 이 이름을 함께 씁니다.
 * 이름은 shared의 design/screenTitles에서 읽고, 웹 경로 매핑은 이 파일이 소유합니다. 이름을 바꾸면 공통 정의와 해당 화면의 머리글을 함께 고칩니다.
 */
export { screenTitles }

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
  [appPaths.adminAiCosts, screenTitles.adminAiCosts],
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
export function screenTitleFor(pathname: string, search = '', isAdmin = false): string | null {
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  if (path === publicPaths.landing || path === appPaths.chat) {
    return new URLSearchParams(search).get('mode') === 'filter' ? screenTitles.filterSearch
      : isAdmin && path === appPaths.chat ? screenTitles.govAgent : screenTitles.aiSearch
  }
  return routeTitles.find(([pattern]) => matchPath(pattern, path) !== null)?.[1] ?? null
}

/** 브라우저 제목입니다. "관심 공고함 · GovBiz"처럼 화면 이름을 앞에 두고, 이름이 없는 주소는 "GovBiz"만 씁니다. */
export function documentTitleFor(pathname: string, search = '', isAdmin = false): string {
  const title = screenTitleFor(pathname, search, isAdmin)
  return title === null ? 'GovBiz' : `${title} · GovBiz`
}
