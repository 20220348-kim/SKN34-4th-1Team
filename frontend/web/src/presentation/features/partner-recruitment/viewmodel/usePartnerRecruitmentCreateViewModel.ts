import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router'

import { appContainer } from '../../../../app/appContainer'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import { validatePartnerRecruitmentInput, type CreatePartnerRecruitmentUseCase } from '../../../../domain/usecases/PartnerRecruitmentUseCases'
import type { BrowseSavedSupportProgramsUseCase } from '../../../../domain/usecases/SavedSupportProgramUseCases'
import { useAuthSession } from '../../../shared/auth/hooks/useAuthSession'
import { companyInitial } from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { appPaths } from '../../../shared/routes/appPaths'
import { useSavedSupportProgramChoices } from '../../../shared/support-program/useSavedSupportProgramChoices'
import {
  recruitmentFieldMessage,
  recruitmentFormMessages,
  todayInSeoul,
  useRecruitmentFormFields,
} from './useRecruitmentFormFields'

const DAY_MS = 86_400_000

export const recruitmentCreateMessages = {
  ...recruitmentFormMessages,
  companyRequired: '프로필에서 기업을 등록한 뒤 모집글을 쓸 수 있습니다.',
  programNotFound: '고른 공고를 더 이상 찾을 수 없습니다. 관심 공고함에서 다시 골라 주세요.',
  programClosed: '접수가 끝난 공고에는 모집글을 쓸 수 없습니다. 관심 공고함에서 다른 공고를 골라 주세요.',
  alreadyExists: '이 공고에는 이미 내 모집글이 있습니다. 공고당 모집글은 하나입니다.',
  programClosingToday: '오늘 접수가 끝나는 공고에는 모집글을 쓸 수 없습니다. 다른 공고를 골라 주세요.',
  failed: '모집글을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  /** 관심 공고함 팝업에서 고를 수 없는 공고에 붙는 버튼 글자입니다. */
  notOpen: '접수 중 아님',
  closingToday: '오늘 접수 마감',
} as const

type ViewModelUseCases = {
  browseSavedPrograms: Pick<BrowseSavedSupportProgramsUseCase, 'execute'>
  createRecruitment: Pick<CreatePartnerRecruitmentUseCase, 'execute'>
}

/** 날짜 입력에는 시간이 없으므로 접수 마감 전날이 고를 수 있는 마지막 모집 마감일입니다. 접수 마감일이 없으면 제한하지 않습니다. */
export function latestRecruitmentDeadlineFor(program: Pick<SupportProgram, 'applicationEndDate'> | null): string | null {
  if (program?.applicationEndDate == null) return null
  return new Date(Date.parse(`${program.applicationEndDate}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
}

/** 접수 마감 전날이 오늘보다 앞서면(오늘 마감) 모집 마감일을 고를 수 없으므로 묶을 수 없습니다. */
export function canAttachRecruitment(program: Pick<SupportProgram, 'applicationEndDate'>, today: string = todayInSeoul()): boolean {
  const latest = latestRecruitmentDeadlineFor(program)
  return latest === null || latest >= today
}

/**
 * 관심 공고함의 공고를 모집글에 묶을 수 있는지 판단합니다. 접수 중이면서 오늘 마감이 아닌 공고만 고를 수 있고,
 * 고를 수 없는 이유는 팝업의 버튼 글자로 보여 줍니다.
 */
export function recruitmentProgramBlocker(program: Pick<SupportProgram, 'status' | 'applicationEndDate'>, today: string = todayInSeoul()): string | null {
  if (program.status !== 'OPEN') return recruitmentCreateMessages.notOpen
  if (!canAttachRecruitment(program, today)) return recruitmentCreateMessages.closingToday
  return null
}

/**
 * 모집글 작성의 대표 ViewModel입니다. 공고는 카탈로그 검색이 아니라 관심 공고함 팝업에서 하나 고르며,
 * 역할·조건·역량·본문은 수정 화면과 같은 폼 훅을 쓰고 등록 UseCase를 호출해 성공하면 새 모집글 상세로 이동합니다.
 * 작성은 프로필에서 기업을 등록한 회원만 할 수 있고, 제안 조건(이메일 인증)은 서비스 정책이라 작성자가 고르지 않습니다.
 */
export function usePartnerRecruitmentCreateViewModel(useCases?: Partial<ViewModelUseCases>) {
  const resolved: ViewModelUseCases = {
    browseSavedPrograms: useCases?.browseSavedPrograms ?? appContainer.resolve('browseSavedSupportProgramsUseCase'),
    createRecruitment: useCases?.createRecruitment ?? appContainer.resolve('createPartnerRecruitmentUseCase'),
  }
  const navigate = useNavigate()
  const { account, hasCompany } = useAuthSession()
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  // 관심 공고는 화면에 들어올 때가 아니라 팝업을 열 때만 불러옵니다.
  const savedProgramChoices = useSavedSupportProgramChoices(isPickerOpen, resolved.browseSavedPrograms)
  const [selectedProgram, setSelectedProgram] = useState<SupportProgram | null>(null)
  const form = useRecruitmentFormFields()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const maximumRecruitmentDeadline = latestRecruitmentDeadlineFor(selectedProgram)

  function openPicker() {
    setIsPickerOpen(true)
  }

  function closePicker() {
    setIsPickerOpen(false)
  }

  /** 팝업의 선택 버튼입니다. 이미 고른 공고를 다시 누르면 선택을 풉니다. */
  function toggleProgram(program: SupportProgram) {
    if (selectedProgram?.sourceCode === program.sourceCode && selectedProgram.id === program.id) {
      clearProgram()
      return
    }
    if (recruitmentProgramBlocker(program) !== null) {
      form.setError({ field: 'program', message: recruitmentCreateMessages.programClosingToday })
      return
    }
    setSelectedProgram(program)
    form.setError(null)
    const latest = latestRecruitmentDeadlineFor(program)
    if (latest !== null && form.recruitmentDeadline > latest) form.updateRecruitmentDeadline('')
  }

  function clearProgram() {
    setSelectedProgram(null)
    form.setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    if (selectedProgram === null) {
      form.setError({ field: 'program', message: recruitmentCreateMessages.program })
      return
    }
    const deadlineProblem = form.deadlineProblem(maximumRecruitmentDeadline)
    if (deadlineProblem !== null) {
      form.setError(deadlineProblem)
      return
    }
    const input = {
      sourceCode: selectedProgram.sourceCode,
      sourceProgramId: selectedProgram.id,
      ...form.content(),
    }
    const problem = validatePartnerRecruitmentInput({ ...input, title: input.title.trim(), body: input.body.trim() })
    if (problem !== null) {
      form.setError(recruitmentFieldMessage(problem, maximumRecruitmentDeadline))
      return
    }

    setIsSubmitting(true)
    form.setError(null)
    try {
      const result = await resolved.createRecruitment.execute(input)
      switch (result.outcome) {
        case 'created':
          navigate(`${appPaths.partnerDetail}?${new URLSearchParams({ recruitmentId: String(result.recruitment.id) })}`)
          return
        case 'company-required':
          form.setError({ field: null, message: recruitmentCreateMessages.companyRequired })
          return
        case 'program-not-found':
          setSelectedProgram(null)
          form.setError({ field: 'program', message: recruitmentCreateMessages.programNotFound })
          return
        case 'program-closed':
          setSelectedProgram(null)
          form.setError({ field: 'program', message: recruitmentCreateMessages.programClosed })
          return
        case 'deadline-not-allowed':
          form.setError({
            field: 'recruitmentDeadline',
            message: result.latestAllowedDeadline === null
              ? recruitmentCreateMessages.recruitmentDeadline
              : recruitmentCreateMessages.deadlineBefore(result.latestAllowedDeadline),
          })
          return
        case 'already-exists':
          form.setError({ field: 'program', message: recruitmentCreateMessages.alreadyExists })
          return
      }
    } catch {
      form.setError({ field: null, message: recruitmentCreateMessages.failed })
    } finally {
      setIsSubmitting(false)
    }
  }

  return {
    form,
    error: form.error,
    maximumRecruitmentDeadline,
    isSubmitting,
    submit,
    /** 기업 등록 전에는 폼 대신 등록 안내를 보여 줍니다. */
    canCreate: hasCompany,
    profilePath: appPaths.profile,
    savedProgramsPath: appPaths.savedPrograms,
    /** 모집글에 표시되는 우리 기업입니다. 세션의 등록 기업 요약을 쓰고 상세 값은 프로필 API가 맡습니다. */
    ownCompany: account?.company
      ? { initial: companyInitial(account.company.companyName), name: account.company.companyName, isEmailVerified: account.emailVerified }
      : null,
    isPickerOpen,
    openPicker,
    closePicker,
    savedProgramChoices,
    recruitmentProgramBlocker,
    selectedProgram,
    selectedProgramKeys: selectedProgram ? [`${selectedProgram.sourceCode}:${selectedProgram.id}`] : [],
    toggleProgram,
    clearProgram,
  }
}
