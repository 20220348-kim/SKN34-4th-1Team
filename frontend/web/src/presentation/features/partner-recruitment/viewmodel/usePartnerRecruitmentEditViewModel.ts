import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import { validatePartnerRecruitmentContent, type UpdatePartnerRecruitmentUseCase } from '../../../../domain/usecases/PartnerRecruitmentUseCases'
import { readRecruitmentId, usePartnerRecruitmentDetail } from '../../../shared/partner-recruitment/usePartnerRecruitmentBrowse'
import { appPaths } from '../../../shared/routes/appPaths'
import { latestRecruitmentDeadlineFor } from './usePartnerRecruitmentCreateViewModel'
import { recruitmentFieldMessage, recruitmentFormMessages, useRecruitmentFormFields } from './useRecruitmentFormFields'

export const recruitmentEditMessages = {
  ...recruitmentFormMessages,
  notMine: '내가 쓴 모집글만 고칠 수 있습니다.',
  closed: '마감된 모집글은 고칠 수 없습니다.',
  notFound: '모집글을 더 이상 찾을 수 없습니다.',
  failed: '모집글을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

/**
 * 모집글 수정의 대표 ViewModel입니다. 상세를 읽어 폼에 채우고, 묶인 공고는 바꾸지 않은 채 내용만 수정 UseCase로 보냅니다.
 * 저장에 성공하면 그 모집글 상세로 돌아갑니다. 내 글이면서 모집 중일 때만 고칠 수 있습니다.
 */
export function usePartnerRecruitmentEditViewModel(
  updateUseCase: Pick<UpdatePartnerRecruitmentUseCase, 'execute'> = appContainer.resolve('updatePartnerRecruitmentUseCase'),
) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const recruitmentId = readRecruitmentId(searchParams.getAll('recruitmentId'))
  const { phase, recruitment } = usePartnerRecruitmentDetail(recruitmentId)
  const form = useRecruitmentFormFields()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { fill } = form

  // 불러온 글을 폼에 한 번 채웁니다. 다른 글로 바뀌면 다시 채웁니다.
  useEffect(() => {
    if (recruitment === null) return
    fill({
      title: recruitment.title,
      body: recruitment.body,
      ownRole: recruitment.ownRole,
      seekingRole: recruitment.seekingRole,
      seekingCount: recruitment.seekingCount,
      region: recruitment.region,
      minimumCompanyAgeYears: recruitment.minimumCompanyAgeYears,
      capabilities: recruitment.capabilities,
      recruitmentDeadline: recruitment.recruitmentDeadline,
    })
    // 글이 바뀔 때만 채웁니다. fill은 상태 setter 묶음이라 렌더마다 같습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recruitment?.id])

  const maximumRecruitmentDeadline = latestRecruitmentDeadlineFor(recruitment?.program ?? null)
  const detailPath = recruitment === null
    ? appPaths.partners
    : `${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(recruitment.id) })}`

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting || recruitment === null) return
    const deadlineProblem = form.deadlineProblem(maximumRecruitmentDeadline)
    if (deadlineProblem !== null) {
      form.setError(deadlineProblem)
      return
    }
    const content = { ...form.content(), title: form.title.trim(), body: form.body.trim() }
    const problem = validatePartnerRecruitmentContent(content)
    if (problem !== null) {
      form.setError(recruitmentFieldMessage(problem, maximumRecruitmentDeadline))
      return
    }

    setIsSubmitting(true)
    form.setError(null)
    try {
      const result = await updateUseCase.execute(recruitment.id, content)
      switch (result.outcome) {
        case 'updated':
          navigate(detailPath)
          return
        case 'not-found':
          form.setError({ field: null, message: recruitmentEditMessages.notFound })
          return
        case 'forbidden':
          form.setError({ field: null, message: recruitmentEditMessages.notMine })
          return
        case 'closed':
          form.setError({ field: null, message: recruitmentEditMessages.closed })
          return
        case 'deadline-not-allowed':
          form.setError({
            field: 'recruitmentDeadline',
            message: result.latestAllowedDeadline === null
              ? recruitmentEditMessages.recruitmentDeadline
              : recruitmentEditMessages.deadlineBefore(result.latestAllowedDeadline),
          })
          return
      }
    } catch {
      form.setError({ field: null, message: recruitmentEditMessages.failed })
    } finally {
      setIsSubmitting(false)
    }
  }

  return {
    phase,
    recruitment,
    /** 내 글이면서 모집 중일 때만 고칩니다. 아니면 폼 대신 안내를 보여 줍니다. */
    canEdit: recruitment !== null && recruitment.isMine && recruitment.status === 'OPEN',
    form,
    maximumRecruitmentDeadline,
    isSubmitting,
    submit,
    detailPath,
    listPath: appPaths.partners,
  }
}
