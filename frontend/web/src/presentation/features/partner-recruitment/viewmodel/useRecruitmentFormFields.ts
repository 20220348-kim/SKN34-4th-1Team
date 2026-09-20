import { type KeyboardEvent, useState } from 'react'

import {
  companyAgeYearsRange,
  ownPartnerRoles,
  partnerRoleLabels,
  recruitmentBodyMaxLength,
  recruitmentCapabilityMaxCount,
  recruitmentCapabilityMaxLength,
  recruitmentTitleMaxLength,
  seekingCountRange,
  seekingPartnerRoles,
  type PartnerRecruitmentContentInput,
  type PartnerRole,
} from '../../../../domain/entities/PartnerRecruitment'
import { nationwideRegion, regionNamesNationwideFirst } from '../../../../domain/entities/Region'

export type RecruitmentFormField = 'program' | 'title' | 'body' | 'recruitmentDeadline' | 'capabilities' | 'seekingCount' | 'minimumCompanyAgeYears'
export type RecruitmentFormError = { field: RecruitmentFormField | null; message: string }

/** 작성·수정 폼이 함께 쓰는 입력 안내 문구입니다. 공고·등록 결과처럼 한쪽에만 있는 문구는 각 ViewModel이 더합니다. */
export const recruitmentFormMessages = {
  program: '모집글을 묶을 공고를 먼저 골라 주세요.',
  title: `제목을 1~${recruitmentTitleMaxLength}자로 입력해 주세요.`,
  body: `모집 소개 본문을 1~${recruitmentBodyMaxLength}자로 입력해 주세요.`,
  recruitmentDeadline: '모집 마감일을 오늘 이후로 골라 주세요.',
  deadlineBefore: (latest: string) => `모집 마감일은 ${latest}까지 선택해 주세요.`,
  capabilities: `필요 역량은 ${recruitmentCapabilityMaxLength}자 이내로 ${recruitmentCapabilityMaxCount}개까지 넣을 수 있습니다.`,
  seekingCount: `찾는 기업 수는 ${seekingCountRange.min}~${seekingCountRange.max}곳 사이로 입력해 주세요.`,
  minimumCompanyAgeYears: `희망 업력은 ${companyAgeYearsRange.min}~${companyAgeYearsRange.max}년 사이로 입력하거나 비워 두세요.`,
} as const

export const recruitmentWritingTips = [
  '우리가 맡을 일과 상대에게 바라는 일을 나눠 적으면 제안 품질이 올라갑니다.',
  '일정을 적어 두면 준비 기간이 맞지 않는 기업이 미리 걸러집니다.',
  '예산 비율은 확정이 아니라 협의 범위로 적으세요.',
] as const

export function todayInSeoul(): string {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

/** 화면 검증 결과(필드 이름)를 그 필드의 안내 문구로 바꿉니다. */
export function recruitmentFieldMessage(problem: string, latestDeadline: string | null): RecruitmentFormError {
  const fields: readonly RecruitmentFormField[] = ['program', 'title', 'body', 'recruitmentDeadline', 'capabilities', 'seekingCount', 'minimumCompanyAgeYears']
  const field = fields.find((item) => item === problem) ?? null
  switch (field) {
    case 'program': return { field, message: recruitmentFormMessages.program }
    case 'title': return { field, message: recruitmentFormMessages.title }
    case 'body': return { field, message: recruitmentFormMessages.body }
    case 'capabilities': return { field, message: recruitmentFormMessages.capabilities }
    case 'seekingCount': return { field, message: recruitmentFormMessages.seekingCount }
    case 'minimumCompanyAgeYears': return { field, message: recruitmentFormMessages.minimumCompanyAgeYears }
    case 'recruitmentDeadline':
      return {
        field,
        message: latestDeadline === null ? recruitmentFormMessages.recruitmentDeadline : recruitmentFormMessages.deadlineBefore(latestDeadline),
      }
    default: return { field: null, message: recruitmentFormMessages.body }
  }
}

/**
 * 모집글 작성·수정 폼이 함께 쓰는 입력 값과 역량 칩 처리입니다. 공고 선택과 제출·이동은 각 ViewModel이 맡습니다.
 * [fill]로 저장된 글을 채우고 [content]로 서버에 보낼 내용을 만듭니다.
 */
export function useRecruitmentFormFields() {
  const [ownRole, setOwnRole] = useState<PartnerRole>('PARTICIPANT')
  const [seekingRole, setSeekingRole] = useState<PartnerRole>('LEAD')
  const [seekingCount, setSeekingCount] = useState(1)
  // 희망 지역은 공고 분류와 같은 시·도 목록에서 고릅니다. 기본은 지역 제한 없음입니다.
  const [seekingRegion, setSeekingRegion] = useState<string>(nationwideRegion)
  // 빈 값은 업력 무관입니다.
  const [minimumCompanyAgeYears, setMinimumCompanyAgeYears] = useState<number | null>(null)
  const [recruitmentDeadline, setRecruitmentDeadline] = useState('')
  const [capabilities, setCapabilities] = useState<string[]>([])
  const [capabilityDraft, setCapabilityDraft] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<RecruitmentFormError | null>(null)

  function fill(content: PartnerRecruitmentContentInput) {
    setOwnRole(content.ownRole)
    setSeekingRole(content.seekingRole)
    setSeekingCount(content.seekingCount)
    setSeekingRegion(content.region)
    setMinimumCompanyAgeYears(content.minimumCompanyAgeYears)
    setRecruitmentDeadline(content.recruitmentDeadline)
    setCapabilities(content.capabilities)
    setCapabilityDraft('')
    setTitle(content.title)
    setBody(content.body)
    setError(null)
  }

  function content(): PartnerRecruitmentContentInput {
    return {
      title,
      body,
      ownRole,
      seekingRole,
      seekingCount,
      region: seekingRegion,
      minimumCompanyAgeYears,
      capabilities,
      recruitmentDeadline,
    }
  }

  /** 마감일은 오늘 이후이면서 공고 접수 마감 전날([maximum])까지여야 합니다. 문제가 없으면 null입니다. */
  function deadlineProblem(maximum: string | null): RecruitmentFormError | null {
    if (!recruitmentDeadline || recruitmentDeadline < todayInSeoul()) {
      return { field: 'recruitmentDeadline', message: recruitmentFormMessages.recruitmentDeadline }
    }
    if (maximum !== null && recruitmentDeadline > maximum) {
      return { field: 'recruitmentDeadline', message: recruitmentFormMessages.deadlineBefore(maximum) }
    }
    return null
  }

  /** 같은 역량을 두 번 넣지 않고, 빈 값은 무시합니다. */
  function addCapabilityOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const capability = capabilityDraft.trim()
    if (!capability || capabilities.includes(capability)) return
    if (capabilities.length >= recruitmentCapabilityMaxCount || capability.length > recruitmentCapabilityMaxLength) {
      setError({ field: 'capabilities', message: recruitmentFormMessages.capabilities })
      return
    }
    setCapabilities([...capabilities, capability])
    setCapabilityDraft('')
    setError(null)
  }

  function removeCapability(capability: string) {
    setCapabilities(capabilities.filter((item) => item !== capability))
  }

  return {
    ownRoles: ownPartnerRoles.map((role) => ({ value: role, label: partnerRoleLabels[role] })),
    seekingRoles: seekingPartnerRoles.map((role) => ({ value: role, label: partnerRoleLabels[role] })),
    ownRole,
    seekingRole,
    selectOwnRole: setOwnRole,
    selectSeekingRole: setSeekingRole,
    seekingCountRange,
    seekingCount,
    updateSeekingCount: (value: string) => { setError(null); setSeekingCount(Number.parseInt(value, 10)) },
    regionOptions: regionNamesNationwideFirst,
    seekingRegion,
    updateSeekingRegion: setSeekingRegion,
    companyAgeYearsRange,
    minimumCompanyAgeYears,
    /** 빈 입력은 무관(null)으로, 숫자는 정수로 둡니다. 범위 검사는 제출 때 합니다. */
    updateMinimumCompanyAgeYears: (value: string) => {
      setError(null)
      setMinimumCompanyAgeYears(value.trim() === '' ? null : Number.parseInt(value, 10))
    },
    recruitmentDeadline,
    minimumRecruitmentDeadline: todayInSeoul(),
    updateRecruitmentDeadline: (value: string) => { setRecruitmentDeadline(value); setError(null) },
    capabilities,
    capabilityDraft,
    updateCapabilityDraft: setCapabilityDraft,
    addCapabilityOnEnter,
    removeCapability,
    title,
    titleMaxLength: recruitmentTitleMaxLength,
    updateTitle: (value: string) => { setTitle(value); setError(null) },
    body,
    bodyMaxLength: recruitmentBodyMaxLength,
    updateBody: (value: string) => { setBody(value); setError(null) },
    error,
    setError,
    fill,
    content,
    deadlineProblem,
  }
}

export type RecruitmentFormFields = ReturnType<typeof useRecruitmentFormFields>
