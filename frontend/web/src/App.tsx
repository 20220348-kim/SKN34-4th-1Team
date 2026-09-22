import { useRef } from 'react'

import { useChatRequestLifecycle } from './presentation/features/chat/hooks/useChatRequestLifecycle'
import { useRestoreSupportProgramSearch } from './presentation/features/chat/hooks/useRestoreSupportProgramSearch'
import { ChatActivityToast } from './presentation/shared/chat-activity/ChatActivityToast'
import { CombinationReviewListPage, CombinationReviewEditorPage, CombinationReviewRunResultPage } from './presentation/features/combination-review/view/CombinationReviewPages'
import { ApplicationPreparationEditorPage, ApplicationPreparationListPage } from './presentation/features/application-preparation/view/ApplicationPreparationPages'
import { ApplicationDocumentPage } from './presentation/features/application-preparation/view/ApplicationDocumentPage'
import { DailyReportPage } from './presentation/features/daily-report/view/DailyReportPage'
import { DailyReportEmailPage } from './presentation/features/daily-report/view/DailyReportEmailPage'
import { useReviewSessionIsolation } from './presentation/features/combination-review/viewmodel/useReviewSessionIsolation'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router'

import { AdminAccountDetailPage } from './presentation/features/admin/view/AdminAccountDetailPage'
import { AdminAccountsPage } from './presentation/features/admin/view/AdminAccountsPage'
import { ForgotPasswordPage } from './presentation/features/auth/view/ForgotPasswordPage'
import { LoginPage } from './presentation/features/auth/view/LoginPage'
import { OAuthCompletePage } from './presentation/features/auth/view/OAuthCompletePage'
import { SavedProgramsPage } from './presentation/features/saved-programs/view/SavedProgramsPage'
import { ResetPasswordPage } from './presentation/features/auth/view/ResetPasswordPage'
import { SignupPage } from './presentation/features/auth/view/SignupPage'
import { SupportProgramSearchPage } from './presentation/features/support-program-catalog/view/SupportProgramSearchPage'
import { CompanyProfilePage } from './presentation/features/company-profile/view/CompanyProfilePage'
import { PartnerRecruitmentCreatePage } from './presentation/features/partner-recruitment/view/PartnerRecruitmentCreatePage'
import { PartnerRecruitmentDetailPage } from './presentation/features/partner-recruitment/view/PartnerRecruitmentDetailPage'
import { PartnerRecruitmentEditPage } from './presentation/features/partner-recruitment/view/PartnerRecruitmentEditPage'
import { PartnerRecruitmentListPage } from './presentation/features/partner-recruitment/view/PartnerRecruitmentListPage'
import { MyPartnerRecruitmentsPage } from './presentation/features/partner-recruitment/view/MyPartnerRecruitmentsPage'
import { PartnerProposalBoxPage } from './presentation/features/partner-proposal/view/PartnerProposalBoxPage'
import { PricingPage } from './presentation/features/pricing/view/PricingPage'
import { PublicPartnerRecruitmentDetailPage } from './presentation/features/public-partner-recruitment/view/PublicPartnerRecruitmentDetailPage'
import { PublicPartnerRecruitmentListPage } from './presentation/features/public-partner-recruitment/view/PublicPartnerRecruitmentListPage'
import { GuestSearchDetailLayout } from './presentation/features/support-program-detail/view/GuestSearchDetailLayout'
import { SupportProgramDetailPage } from './presentation/features/support-program-detail/view/SupportProgramDetailPage'
import { SupportProgramEvidenceQuestionPage } from './presentation/features/support-program-detail/view/SupportProgramEvidenceQuestionPage'
import { ReduxSampleItemPage } from './presentation/features/sample-item/view/ReduxSampleItemPage'
import { SampleItemPage } from './presentation/features/sample-item/view/SampleItemPage'
import { AppHeader } from './presentation/shared/app-header/AppHeader'
import { publicLayoutStyles } from './presentation/shared/app-header/PublicLayout.styles'
import { WorkspaceLayout } from './presentation/shared/app-sidebar/WorkspaceLayout'
import { useRestoreAuthSession } from './presentation/shared/auth/hooks/useAuthSession'
import { AssistantWidget } from './presentation/shared/assistant/AssistantWidget'
import { GuestOnly, PublicOnly, RequireAuth } from './presentation/shared/auth/RouteGuards'
import { APP_PREFIX, appPaths, publicPaths } from './presentation/shared/routes/appPaths'
import { useResetScrollOnNavigate } from './presentation/shared/routes/useResetScrollOnNavigate'

/**
 * 비로그인 검색 흐름은 헤더·검색 탭이 위에 붙는 자체 레이아웃을 쓰고, 나머지 공개 화면은 공용 헤더를 사용합니다.
 * 껍데기는 로그인 뒤 작업 화면과 같습니다. 바깥은 화면 높이에 고정된 흰 바탕이고 안쪽 칸이 스크롤하므로
 * 문서(html)는 스크롤하지 않고, 두 상태에서 스크롤 위치와 바탕색이 같게 보입니다.
 */
function PublicLayout() {
  const { pathname } = useLocation()
  const path = pathname.replace(/\/+$/, '') || publicPaths.landing
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  // 스크롤은 안쪽 칸이 맡으므로 다른 화면으로 가면 그 칸을 맨 위로 돌립니다.
  useResetScrollOnNavigate(scrollAreaRef)
  // 비로그인 검색 흐름(검색·공고 상세·원문 질문)은 헤더·검색 탭이 위에 붙는 자체 레이아웃을 씁니다.
  const inSearchFlow = path === publicPaths.landing || path === publicPaths.supportProgramDetail || path === publicPaths.supportProgramQuestion
  return (
    <div className={publicLayoutStyles.shell}>
      <div ref={scrollAreaRef} className={publicLayoutStyles.scrollArea}>
        {inSearchFlow ? null : <AppHeader />}
        <Outlet />
      </div>
    </div>
  )
}

/**
 * 공개 검색은 검색 전용 레이아웃을, 나머지 공개 화면은 공용 헤더를, 로그인 뒤 화면은 작업 사이드바를 사용합니다.
 * 로그인한 사용자가 공개 URL로 오면 같은 내용의 내부 화면으로 보내고, 비로그인으로 `/app`에 오면 로그인으로 보냅니다.
 * 로그인·회원가입은 둘 다 쓰지 않는 단독 화면이며 로그인 상태에서는 작업 화면으로 돌려보냅니다.
 */
function App() {
  useRestoreAuthSession()
  useRestoreSupportProgramSearch()
  useChatRequestLifecycle()
  useReviewSessionIsolation()
  // 비로그인 대화는 로그인 뒤 대화와 같이 메뉴 이동으로 비우지 않습니다. 탭이 살아 있는 동안 메모리에 남고,
  // 새 AI 대화 검색·로고(문서 새로고침)·로그인·계정 전환에서만 초기화합니다.

  return (
    <>
    <ChatActivityToast />
    <Routes>
      <Route element={<PublicLayout />}>
        <Route path={publicPaths.reportEmail} element={<DailyReportEmailPage />} />
        <Route element={<PublicOnly />}>
          <Route path={publicPaths.landing} element={<SupportProgramSearchPage />} />
          <Route path={publicPaths.pricing} element={<PricingPage />} />
          <Route path={publicPaths.partners} element={<PublicPartnerRecruitmentListPage />} />
          <Route path={publicPaths.partnerDetail} element={<PublicPartnerRecruitmentDetailPage />} />
          {/* 상세·원문 질문은 검색 화면의 헤더·검색 탭을 그대로 둔 채 그 아래에 띄웁니다. */}
          <Route element={<GuestSearchDetailLayout />}>
            <Route path={publicPaths.supportProgramDetail} element={<SupportProgramDetailPage />} />
            <Route path={publicPaths.supportProgramQuestion} element={<SupportProgramEvidenceQuestionPage />} />
          </Route>
        </Route>
        {/* 상태관리 비교 예제는 개발용 화면이라 로그인 여부와 무관하게 같은 헤더 아래에서 엽니다. */}
        <Route path="/examples/sample-item/hook" element={<SampleItemPage />} />
        <Route path="/examples/sample-item/redux" element={<ReduxSampleItemPage />} />
      </Route>

      {/* 소셜 로그인 완료 화면은 세션을 막 받은 순간이라 로그인 여부로 가르지 않고 스스로 복귀 경로로 옮깁니다. */}
      <Route path={publicPaths.oauthComplete} element={<OAuthCompletePage />} />

      <Route element={<GuestOnly />}>
        <Route path={publicPaths.login} element={<LoginPage />} />
        <Route path={publicPaths.signup} element={<SignupPage />} />
        <Route path={publicPaths.forgotPassword} element={<ForgotPasswordPage />} />
        <Route path={publicPaths.resetPassword} element={<ResetPasswordPage />} />
      </Route>

      <Route element={<RequireAuth />}>
        <Route element={<WorkspaceLayout />}>
          <Route path={appPaths.reports} element={<DailyReportPage />} />
          <Route path={appPaths.savedPrograms} element={<SavedProgramsPage />} />
          <Route path={appPaths.applicationPreparations} element={<ApplicationPreparationListPage />} />
          <Route path={appPaths.applicationPreparationNew} element={<ApplicationPreparationEditorPage create />} />
          <Route path={appPaths.applicationPreparationDetail} element={<ApplicationPreparationEditorPage />} />
          <Route path={appPaths.applicationPreparationDocuments} element={<ApplicationDocumentPage />} />
          <Route path={appPaths.combinationReviews} element={<CombinationReviewListPage />} />
          <Route path={appPaths.combinationReviewNew} element={<CombinationReviewEditorPage create />} />
          <Route path={appPaths.combinationReviewRunResult} element={<CombinationReviewRunResultPage />} />
          <Route path={appPaths.combinationReviewDetail} element={<CombinationReviewEditorPage />} />
          <Route path={appPaths.chat} element={<SupportProgramSearchPage layout="workspace" />} />
          <Route path={appPaths.pricing} element={<PricingPage layout="workspace" />} />
          <Route path={appPaths.partners} element={<PartnerRecruitmentListPage />} />
          <Route path={appPaths.partnerNew} element={<PartnerRecruitmentCreatePage />} />
          <Route path={appPaths.partnerEdit} element={<PartnerRecruitmentEditPage />} />
          <Route path={appPaths.myPartners} element={<MyPartnerRecruitmentsPage />} />
          <Route path={appPaths.partnerDetail} element={<PartnerRecruitmentDetailPage />} />
          <Route path={appPaths.proposals} element={<PartnerProposalBoxPage />} />
          <Route path={appPaths.profile} element={<CompanyProfilePage />} />
          <Route path={appPaths.supportProgramDetail} element={<SupportProgramDetailPage />} />
          <Route path={appPaths.supportProgramQuestion} element={<SupportProgramEvidenceQuestionPage />} />
        </Route>
      </Route>

      <Route element={<RequireAuth minimumTier="ADMIN" />}>
        <Route element={<WorkspaceLayout />}>
          <Route path={appPaths.adminAccounts} element={<AdminAccountsPage />} />
          <Route path={appPaths.adminAccountDetail} element={<AdminAccountDetailPage />} />
        </Route>
      </Route>

      <Route path={APP_PREFIX} element={<Navigate replace to={appPaths.chat} />} />
      <Route path="*" element={<Navigate replace to={publicPaths.landing} />} />
    </Routes>
    {/* 도우미는 화면 오른쪽 아래에 떠 있고 로그인·회원가입 같은 단독 화면에서는 스스로 숨습니다. */}
    <AssistantWidget />
    </>
  )
}

export default App
