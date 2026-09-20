import { useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'

import { loginPathFor } from '../../../shared/auth/returnPath'
import { readRecruitmentId, usePartnerRecruitmentDetail } from '../../../shared/partner-recruitment/usePartnerRecruitmentBrowse'

/**
 * 로그인 전 공개 모집글 상세의 대표 ViewModel입니다. 공고 원문과 모집 조건은 그대로 보여 주고,
 * 매칭·제안은 로그인 뒤 같은 화면으로 돌아오도록 안내합니다.
 */
export function usePublicPartnerRecruitmentDetailViewModel() {
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { phase, recruitment } = usePartnerRecruitmentDetail(readRecruitmentId(searchParams.getAll('recruitmentId')))
  const [isLoginPromptOpen, setIsLoginPromptOpen] = useState(false)
  // 로그인·회원가입 뒤 내부 상세로 이어지도록 현재 주소를 복귀 경로로 넘깁니다.
  const returnPath = `${location.pathname}${location.search}`
  return {
    phase,
    recruitment,
    loginPath: loginPathFor(returnPath),
    isLoginPromptOpen,
    openLoginPrompt: () => setIsLoginPromptOpen(true),
    closeLoginPrompt: () => setIsLoginPromptOpen(false),
    proposalFlowSteps: ['대기', '수락 · 연락처 공개', '컨소시엄 확정'],
  }
}
