import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'

import { appContainer } from '../../../../app/appContainer'
import {
  type CompanyPartnerProfile,
  type CompanyPartnerProfileField,
  companyPartnerProfileLimits,
  emptyCompanyPartnerProfile,
  findCompanyPartnerProfileProblem,
} from '../../../../domain/entities/CompanyPartnerProfile'
import { ownPartnerRoles, partnerRoleLabels, type PartnerRole } from '../../../../domain/entities/PartnerRecruitment'
import { supportProgramCategories } from '../../../../domain/entities/SupportProgramCategory'
import type {
  GetCompanyPartnerProfileUseCase,
  UpdateCompanyPartnerProfileUseCase,
} from '../../../../domain/usecases/CompanyPartnerProfileUseCases'

export const partnerProfileMessages = {
  roles: '참여 가능 역할을 하나 이상 골라 주세요.',
  interestAreas: `관심 분야는 ${companyPartnerProfileLimits.interestAreaMaxCount}개까지 고를 수 있습니다.`,
  introduction: `한 줄 소개는 ${companyPartnerProfileLimits.introductionMaxLength}자 이하로 입력해 주세요.`,
  capabilities: `보유 역량은 ${companyPartnerProfileLimits.capabilityMaxLength}자 이내로 ${companyPartnerProfileLimits.capabilityMaxCount}개까지 넣을 수 있습니다.`,
  loadFailed: '협업·파트너 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
  saveFailed: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
} as const

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; saved: CompanyPartnerProfile }
  | { status: 'failed' }

type PartnerProfileUseCases = {
  getPartnerProfile: Pick<GetCompanyPartnerProfileUseCase, 'execute'>
  updatePartnerProfile: Pick<UpdateCompanyPartnerProfileUseCase, 'execute'>
}

type FormValues = {
  roles: PartnerRole[]
  interestAreas: string[]
  introduction: string
  capabilities: string[]
}

function toForm(profile: CompanyPartnerProfile): FormValues {
  return { roles: profile.roles, interestAreas: profile.interestAreas, introduction: profile.introduction, capabilities: profile.capabilities }
}

/**
 * 협업·파트너 설정 카드의 ViewModel입니다. 기업이 등록된 뒤 한 번 읽고, 역할·관심 분야 칩, 한 줄 소개, 역량 태그의
 * 입력과 저장을 소유합니다. 기업 프로필 ViewModel이 완성도 계산에 저장 여부를 씁니다.
 */
export function useCompanyPartnerProfileViewModel(hasCompany: boolean, useCases: Partial<PartnerProfileUseCases> = {}) {
  const resolved: PartnerProfileUseCases = {
    getPartnerProfile: useCases.getPartnerProfile ?? appContainer.resolve('getCompanyPartnerProfileUseCase'),
    updatePartnerProfile: useCases.updatePartnerProfile ?? appContainer.resolve('updateCompanyPartnerProfileUseCase'),
  }
  const isMounted = useRef(true)
  const [loadState, setLoadState] = useState<LoadState>({ status: 'idle' })
  const [form, setForm] = useState<FormValues>(toForm(emptyCompanyPartnerProfile))
  const [capabilityDraft, setCapabilityDraft] = useState('')
  const [error, setError] = useState<{ field: CompanyPartnerProfileField | 'form'; message: string } | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  // 기업 기본정보처럼 평소에는 저장된 값을 보여 주고 "수정"을 눌러야 폼이 열립니다.
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])

  useEffect(() => {
    if (!hasCompany) {
      setLoadState({ status: 'idle' })
      return
    }
    const controller = new AbortController()
    setLoadState({ status: 'loading' })
    void Promise.resolve()
      .then(() => resolved.getPartnerProfile.execute(controller.signal))
      .then((profile) => {
        if (controller.signal.aborted) return
        const saved = profile ?? emptyCompanyPartnerProfile
        setLoadState({ status: 'ready', saved })
        setForm(toForm(saved))
      })
      .catch(() => { if (!controller.signal.aborted) setLoadState({ status: 'failed' }) })
    return () => controller.abort()
    // 기업이 등록되는 순간 한 번 읽습니다. UseCase는 앱 수명 동안 같습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasCompany])

  const saved = loadState.status === 'ready' ? loadState.saved : null
  const isDirty = saved !== null && JSON.stringify(toForm(saved)) !== JSON.stringify(form)

  function update(next: Partial<FormValues>) {
    setForm((current) => ({ ...current, ...next }))
    setError(null)
  }

  function toggleRole(role: PartnerRole) {
    update({ roles: form.roles.includes(role) ? form.roles.filter((item) => item !== role) : [...form.roles, role] })
  }

  function toggleInterestArea(area: string) {
    if (form.interestAreas.includes(area)) {
      update({ interestAreas: form.interestAreas.filter((item) => item !== area) })
      return
    }
    if (form.interestAreas.length >= companyPartnerProfileLimits.interestAreaMaxCount) {
      setError({ field: 'interestAreas', message: partnerProfileMessages.interestAreas })
      return
    }
    update({ interestAreas: [...form.interestAreas, area] })
  }

  function addCapability() {
    const capability = capabilityDraft.trim()
    if (!capability || form.capabilities.includes(capability)) {
      setCapabilityDraft('')
      return
    }
    if (form.capabilities.length >= companyPartnerProfileLimits.capabilityMaxCount || capability.length > companyPartnerProfileLimits.capabilityMaxLength) {
      setError({ field: 'capabilities', message: partnerProfileMessages.capabilities })
      return
    }
    update({ capabilities: [...form.capabilities, capability] })
    setCapabilityDraft('')
  }

  function addCapabilityOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    addCapability()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSaving) return
    const problem = findCompanyPartnerProfileProblem(form)
    if (problem !== null) {
      setError({ field: problem, message: partnerProfileMessages[problem] })
      return
    }
    setIsSaving(true)
    try {
      const result = await resolved.updatePartnerProfile.execute(form)
      if (!isMounted.current) return
      setLoadState({ status: 'ready', saved: result })
      setForm(toForm(result))
      setIsEditing(false)
    } catch {
      if (isMounted.current) setError({ field: 'form', message: partnerProfileMessages.saveFailed })
    } finally {
      if (isMounted.current) setIsSaving(false)
    }
  }

  function startEditing() {
    if (saved) setForm(toForm(saved))
    setCapabilityDraft('')
    setError(null)
    setIsEditing(true)
  }

  function cancelEditing() {
    if (saved) setForm(toForm(saved))
    setCapabilityDraft('')
    setError(null)
    setIsEditing(false)
  }

  return {
    hasCompany,
    loadStatus: loadState.status,
    isEditing,
    startEditing,
    cancelEditing,
    loadFailedMessage: loadState.status === 'failed' ? partnerProfileMessages.loadFailed : null,
    /** 저장한 적이 있고 역할이 하나 이상이면 완성도 항목이 끝난 것입니다. */
    isSet: saved?.isSet ?? false,
    savedAt: saved?.updatedAt ?? null,
    form,
    roleOptions: ownPartnerRoles.map((role) => ({ value: role, label: partnerRoleLabels[role] })),
    interestAreaOptions: supportProgramCategories,
    limits: companyPartnerProfileLimits,
    toggleRole,
    toggleInterestArea,
    updateIntroduction: (value: string) => update({ introduction: value }),
    capabilityDraft,
    updateCapabilityDraft: (value: string) => { setCapabilityDraft(value); setError(null) },
    addCapability,
    addCapabilityOnEnter,
    removeCapability: (capability: string) => update({ capabilities: form.capabilities.filter((item) => item !== capability) }),
    error,
    isDirty,
    isSaving,
    submit,
    reset: () => { if (saved) { setForm(toForm(saved)); setCapabilityDraft(''); setError(null) } },
  }
}
