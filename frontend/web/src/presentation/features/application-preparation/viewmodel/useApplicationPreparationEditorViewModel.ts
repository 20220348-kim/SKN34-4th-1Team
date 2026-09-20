import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type {
  ApplicationForm,
  ApplicationPreparation,
  ApplicationFormSection,
  NewApplicationPreparationFact,
  ApplicationServiceField,
} from '../../../../domain/entities/ApplicationPreparation'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import { appPaths } from '../../../shared/routes/appPaths'
import { useSavedSupportProgramChoices } from '../../../shared/support-program/useSavedSupportProgramChoices'
import { defaultProgramSelectionFilters } from '../../../shared/support-program/catalogSearchParams'

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('신청 문서 정보를 처리하지 못했습니다.')
}

const availabilityMessages = {
  PENDING: '신청 양식을 사전분석 대기 중입니다.', AVAILABLE: '저장된 신청 양식으로 작성을 시작할 수 있습니다.',
  NO_FORM: '공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.', DOCUMENT_UNAVAILABLE: '공식 첨부를 수집하거나 읽을 수 없습니다.',
  TOO_LARGE: '첨부 문서가 자동 분석 크기 제한을 초과했습니다.', RETRY_WAITING: '일시적인 오류로 재분석을 기다리고 있습니다.',
  STALE: '공고 또는 공식 첨부가 변경되어 재확인 중입니다.', REVIEW_REQUIRED: '분석 결과를 관리자가 확인해야 합니다.',
}

function availabilityReason(code: string): string {
  if (code.startsWith('RETRY_EXHAUSTED:')) return `${availabilityReason(code.slice('RETRY_EXHAUSTED:'.length))} 자동 재시도 한도에 도달하여 관리자 확인이 필요합니다.`
  if (code === 'NOT_ANALYZED') return '이 공고의 신청 양식이 아직 분석되지 않았습니다.'
  if (code === 'WORKER_RETRY_EXHAUSTED') return '분석 작업이 완료되지 않은 채 재시도 한도에 도달했습니다. 관리자 확인이 필요합니다.'
  if (code === 'DISCOVERY_CONFIGURATION_INVALID') return '신청 양식 분석 설정이 올바르지 않아 분석을 시작하지 못했습니다.'
  if (code === 'SOURCE_UNAVAILABLE') return '공식 사이트에서 공고나 첨부 파일을 불러오지 못했습니다.'
  if (code === 'AI_UNAVAILABLE') return 'AI 분석 서비스에 연결하지 못했습니다.'
  if (code === 'SOURCE_INVALID') return '공식 첨부의 형식이나 출처를 검증하지 못했습니다.'
  if (code === 'AI_INVALID_RESPONSE') return 'AI 분석 응답이 올바르지 않거나 추출한 문항의 근거를 검증하지 못했습니다.'
  if (code.includes('TIMEOUT')) return '정해진 시간 안에 분석을 마치지 못했습니다.'
  if (code.includes('TOO_LARGE')) return '첨부 파일의 크기나 문서 분량이 분석 제한을 초과했습니다.'
  if (code.includes('NOT_FOUND') || code.includes('MISSING')) return '공식 공고 또는 첨부가 없어졌거나 변경되었습니다.'
  if (code.includes('UNSUPPORTED')) return '분석 가능한 PDF·HWP·HWPX 양식을 확보하지 못했습니다.'
  if (code.includes('UNAVAILABLE')) return '공식 사이트 또는 분석 서비스가 일시적으로 응답하지 않습니다.'
  if (code.includes('CHANGED')) return '공고나 공식 첨부가 변경되어 다시 확인해야 합니다.'
  if (code.includes('INVALID') || code.includes('FAILED')) return '첨부 형식 또는 추출한 문항의 근거를 검증하지 못했습니다.'
  if (code === 'NO_FORM') return '분석한 공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.'
  if (code === 'FORM_FOUND') return '공식 첨부에서 작성 가능한 양식을 확인했습니다.'
  if (code === 'UNKNOWN_AFTER_START') return '분석 시작 후 결과를 확인하지 못해 관리자 확인이 필요합니다.'
  return '공식 문서와 양식 준비 상태를 확인해야 합니다.'
}

export function useApplicationPreparationEditorViewModel(id: number | null, initialSourceCode = '', initialSourceProgramId = '', loadSavedPrograms = false) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const catalogUseCase = appContainer.resolve('browseSupportProgramsUseCase')
  const programDetailUseCase = appContainer.resolve('getSupportProgramDetailUseCase')
  const navigate = useNavigate()
  const savedProgramChoices = useSavedSupportProgramChoices(id === null && loadSavedPrograms)
  const [forms, setForms] = useState<ApplicationForm[]>([])
  const [selectedFormVersionId, setSelectedFormVersionId] = useState('')
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const [serviceField, setServiceField] = useState<ApplicationServiceField>('GENERAL')
  const [discoveryInput, setDiscoveryInput] = useState(initialSourceProgramId)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([])
  const [availabilityStatus, setAvailabilityStatus] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [catalogFilters, setCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [appliedCatalogFilters, setAppliedCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<Error | null>(null)
  const [selectedProgram, setSelectedProgram] = useState<SupportProgram | null>(null)
  const [discoverySourceCode, setDiscoverySourceCode] = useState(initialSourceCode)
  const [creationStep, setCreationStep] = useState<'PROGRAM' | 'FORM'>('PROGRAM')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const createController = useRef<AbortController | null>(null)
  const discoveryController = useRef<AbortController | null>(null)
  const catalogController = useRef<AbortController | null>(null)
  const loadSequence = useRef(0)
  const submittingGuard = useRef(false)
  const actionController = useRef<AbortController | null>(null)
  const [sectionMessages, setSectionMessages] = useState<Record<string, string>>({})
  const [deletedAnswerKeys, setDeletedAnswerKeys] = useState<Set<string>>(() => new Set())
  const [busySection, setBusySection] = useState<{ key: string; action: 'save' } | null>(null)

  const selectedForm = useMemo(
    () => forms.find(({ formVersionId }) => formVersionId === selectedFormVersionId) ?? null,
    [forms, selectedFormVersionId],
  )

  const load = useCallback(() => {
    loadController.current?.abort()
    const controller = new AbortController()
    const sequence = ++loadSequence.current
    loadController.current = controller
    if (id === null) return controller
    setLoading(true)
    setError(null)

    const request = useCase.get(id, controller.signal)
    void request.then((result) => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return
      setPreparation(result as ApplicationPreparation)
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return
      setError(asError(caught))
    }).finally(() => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return
      loadController.current = null
      setLoading(false)
    })

    return controller
  }, [id, useCase])

  useEffect(() => {
    const controller = load()
    return () => {
      controller.abort()
      if (loadController.current === controller) loadController.current = null
      loadSequence.current += 1
    }
  }, [load])

  useEffect(() => () => {
    createController.current?.abort()
    discoveryController.current?.abort()
    catalogController.current?.abort()
    actionController.current?.abort()
    submittingGuard.current = false
  }, [])

  const searchPrograms = useCallback(async (page = 1, filters: SupportProgramCatalogFilters = catalogFilters) => {
    catalogController.current?.abort()
    const controller = new AbortController()
    catalogController.current = controller
    setCatalogLoading(true)
    setCatalogError(null)
    const query = { ...filters, keyword: filters.keyword.trim(), page }
    setAppliedCatalogFilters(query)
    setCatalog(null)
    try {
      const result = await catalogUseCase.execute(query, controller.signal)
      if (controller.signal.aborted || catalogController.current !== controller) return
      setCatalog(result)
    } catch (caught) {
      if (!controller.signal.aborted && catalogController.current === controller) setCatalogError(asError(caught))
    } finally {
      if (catalogController.current === controller) {
        catalogController.current = null
        setCatalogLoading(false)
      }
    }
  }, [catalogFilters, catalogUseCase])

  const applyProgramSelection = useCallback((program: SupportProgram) => {
    setSelectedProgram(program)
    setDiscoverySourceCode(program.sourceCode)
    setDiscoveryInput(program.id)
    setCreationStep('PROGRAM')
    setForms([])
    setSelectedFormVersionId('')
    setDiscoveryWarnings([])
    setAvailabilityStatus(null)
    setError(null)
  }, [])

  const selectProgram = useCallback((program: SupportProgram) => {
    if (discoveryController.current) return
    applyProgramSelection(program)
  }, [applyProgramSelection])

  const clearProgramSelection = useCallback(() => {
    if (submittingGuard.current || discoveryController.current) return
    setSelectedProgram(null)
    setDiscoveryInput('')
    setDiscoverySourceCode('')
    setServiceField('GENERAL')
    setCreationStep('PROGRAM')
    setForms([])
    setSelectedFormVersionId('')
    setDiscoveryWarnings([])
    setAvailabilityStatus(null)
    setError(null)
  }, [])

  const discoverForms = useCallback(async () => {
    if (discoveryController.current || !discoveryInput.trim()) return
    const controller = new AbortController()
    discoveryController.current = controller
    setDiscovering(true)
    setError(null)
    setForms([])
    setSelectedFormVersionId('')
    setDiscoveryWarnings([])
    setAvailabilityStatus(null)
    try {
      const result = await useCase.availability(discoverySourceCode, discoveryInput, controller.signal)
      if (controller.signal.aborted) return
      setAvailabilityStatus(result.state.status)
      setDiscoveryWarnings([availabilityMessages[result.state.status], availabilityReason(result.state.reasonCode),
        ...(result.state.nextRetryAt && result.state.status !== 'AVAILABLE' ? [`다음 확인: ${result.state.nextRetryAt.replace('T', ' ')}`] : [])])
      setForms(result.forms.items)
      const first = result.forms.items[0]
      if (result.state.status === 'AVAILABLE' && first) {
        setSelectedFormVersionId(first.formVersionId)
        setServiceField(first.supportedServiceFields[0])
        setCreationStep('FORM')
      }
    } catch (caught) {
      if (!controller.signal.aborted) setError(asError(caught))
    } finally {
      if (discoveryController.current === controller) { discoveryController.current = null; setDiscovering(false) }
    }
  }, [discoveryInput, discoverySourceCode, useCase])

  useEffect(() => {
    if (id !== null || !initialSourceCode || !initialSourceProgramId) return
    const controller = new AbortController()
    void programDetailUseCase.execute({ sourceCode: initialSourceCode, sourceProgramId: initialSourceProgramId }, controller.signal)
      .then((program) => { if (!controller.signal.aborted && program) applyProgramSelection(program) })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(asError(caught)) })
    return () => controller.abort()
  }, [id, initialSourceCode, initialSourceProgramId, programDetailUseCase, applyProgramSelection])

  const reanalyzeForms = useCallback(async () => {
    if (discoveryController.current || !discoveryInput.trim() || id !== null) return
    const controller = new AbortController()
    discoveryController.current = controller
    setDiscovering(true); setError(null); setForms([]); setSelectedFormVersionId('')
    setCreationStep('PROGRAM')
    setDiscoveryWarnings(['공식 원본의 입력칸별 질문을 다시 분석하고 있습니다. 기존 작성본은 변경하지 않습니다.'])
    try {
      let job = await useCase.discover(discoverySourceCode, discoveryInput, controller.signal, crypto.randomUUID())
      const deadline = Date.now() + 720_000
      while (job.status === 'QUEUED' || job.status === 'RUNNING') {
        if (Date.now() >= deadline) throw new Error('양식 분석이 아직 진행 중입니다. 잠시 후 저장된 양식을 다시 확인해 주세요.')
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 2000)
          controller.signal.addEventListener('abort', abort, { once: true })
          if (controller.signal.aborted) abort()
        })
        job = await useCase.discoveryJob(job.id, controller.signal)
      }
      if (controller.signal.aborted) return
      if (job.status !== 'SUCCEEDED' || !job.result) throw new Error(availabilityReason(job.failureCode ?? 'AI_INVALID_RESPONSE'))
      const first = job.result.items[0]
      if (!first) throw new Error('공식 원본에서 작성할 양식을 찾지 못했습니다.')
      setForms(job.result.items); setSelectedFormVersionId(first.formVersionId)
      setServiceField(first.supportedServiceFields[0]); setAvailabilityStatus('AVAILABLE')
      setDiscoveryWarnings(['입력칸별로 분석한 양식입니다. 이전 답변은 자동으로 나누지 않으므로 필요한 값을 직접 확인해 주세요.', ...job.result.warnings])
      setCreationStep('FORM')
    } catch (caught) {
      if (!controller.signal.aborted) setError(asError(caught))
    } finally {
      if (discoveryController.current === controller) { discoveryController.current = null; setDiscovering(false) }
    }
  }, [id, discoveryInput, discoverySourceCode, useCase])

  const backToProgramSelection = useCallback(() => {
    setCreationStep('PROGRAM')
    setError(null)
  }, [])

  const selectForm = useCallback((formVersionId: string) => {
    const form = forms.find((candidate) => candidate.formVersionId === formVersionId)
    if (!form) return
    setSelectedFormVersionId(formVersionId)
    setServiceField((current) => form.supportedServiceFields.includes(current)
      ? current
      : form.supportedServiceFields[0])
  }, [forms])

  const create = useCallback(async () => {
    if (submittingGuard.current) return
    if (!selectedForm || !selectedForm.supportedServiceFields.includes(serviceField)) {
      setError(new Error('지원 공고와 공식 양식, 작성 분야를 다시 선택해 주세요.'))
      return
    }

    submittingGuard.current = true
    const controller = new AbortController()
    createController.current = controller
    setSubmitting(true)
    setError(null)
    try {
      const created = await useCase.create({
        sourceCode: selectedForm.sourceCode,
        sourceProgramId: selectedForm.sourceProgramId,
        formVersionId: selectedForm.formVersionId,
        serviceField,
      }, controller.signal)
      if (!controller.signal.aborted && createController.current === controller) {
        navigate(`${appPaths.applicationPreparations}/${created.id}`, { replace: true })
      }
    } catch (caught) {
      if (!controller.signal.aborted && createController.current === controller) setError(asError(caught))
    } finally {
      if (!controller.signal.aborted && createController.current === controller) {
        createController.current = null
        submittingGuard.current = false
        setSubmitting(false)
      }
    }
  }, [navigate, selectedForm, serviceField, useCase])

  const setSectionMessage = useCallback((sectionKey: string, message: string) => {
    setSectionMessages((current) => ({ ...current, [sectionKey]: message }))
    setDeletedAnswerKeys((current) => {
      if (!current.has(sectionKey)) return current
      const next = new Set(current)
      next.delete(sectionKey)
      return next
    })
  }, [])

  const deleteSectionAnswer = useCallback((answerKey: string) => {
    setSectionMessages((current) => ({ ...current, [answerKey]: '' }))
    setDeletedAnswerKeys((current) => new Set(current).add(answerKey))
  }, [])

  async function saveDocumentAnswers(section: ApplicationFormSection) {
    if (!preparation || busySection || actionController.current) return
    const keys = section.fields.map((field) => `${section.key}:${field.key}`)
    if (!keys.some((key) => Object.hasOwn(sectionMessages, key) || deletedAnswerKeys.has(key))) return
    const clearedExisting = section.fields.find((field) => {
      const key = `${section.key}:${field.key}`
      return Object.hasOwn(sectionMessages, key) && !sectionMessages[key].trim() && !deletedAnswerKeys.has(key)
        && section.facts.some((fact) => fact.fieldKey === field.key)
    })
    if (clearedExisting) {
      setError(new Error(`${clearedExisting.label}: 기존 답변을 없애려면 답변 삭제를 눌러 주세요.`))
      return
    }
    const facts = section.fields.map((field): NewApplicationPreparationFact | null => {
      const key = `${section.key}:${field.key}`
      const existing = section.facts.find((fact) => fact.fieldKey === field.key)
      if (deletedAnswerKeys.has(key)) return null
      if (!Object.hasOwn(sectionMessages, key)) return existing ? {
        fieldKey: existing.fieldKey, status: existing.status, value: existing.value, sourceText: existing.sourceText,
      } : null
      const value = sectionMessages[key].trim()
      if (!value) return null
      return { fieldKey: field.key, status: value === '미정' ? 'UNKNOWN' : 'PROVIDED',
        value: value === '미정' ? null : value, sourceText: `${field.label}: ${value}` }
    }).filter((fact): fact is NewApplicationPreparationFact => fact !== null)
    const invalid = facts.find((fact) => {
      const field = section.fields.find((candidate) => candidate.key === fact.fieldKey)!
      const value = fact.status === 'UNKNOWN' ? '미정' : fact.value!
      return [...value].length > 2000 || Boolean(field.options?.length && value !== '미정' && !field.options.includes(value))
    })
    if (invalid) {
      const field = section.fields.find((candidate) => candidate.key === invalid.fieldKey)!
      setError(new Error(`${field.label}: 답변은 2,000자 이내로 입력하고 선택형 질문은 공식 선택지를 선택해 주세요.`))
      return
    }
    const controller = new AbortController()
    actionController.current = controller
    setBusySection({ key: section.key, action: 'save' })
    setError(null)
    try {
      const updated = await useCase.replaceInputs(preparation.id, section.key, {
        expectedRevision: preparation.inputRevision, facts,
      }, controller.signal)
      if (controller.signal.aborted || actionController.current !== controller) return
      setPreparation(updated)
      setSectionMessages((current) => {
        const remaining = { ...current }
        for (const key of keys) delete remaining[key]
        return remaining
      })
      setDeletedAnswerKeys((current) => {
        const remaining = new Set(current)
        for (const key of keys) remaining.delete(key)
        return remaining
      })
    } catch (caught) {
      if (!controller.signal.aborted && actionController.current === controller) setError(asError(caught))
    } finally {
      if (actionController.current === controller) {
        actionController.current = null
        setBusySection(null)
      }
    }
  }

  return {
    forms,
    selectedForm,
    selectedFormVersionId,
    preparation,
    serviceField,
    discoveryInput,
    discovering,
    discoveryWarnings,
    catalog,
    catalogFilters,
    appliedCatalogFilters,
    catalogLoading,
    catalogError,
    savedProgramChoices,
    selectedProgram,
    discoverySourceCode,
    creationStep,
    loading,
    submitting,
    error,
    setServiceField,
    setCatalogFilters,
    searchPrograms,
    selectProgram,
    clearProgramSelection,
    discoverForms,
    reanalyzeForms,
    availabilityStatus,
    backToProgramSelection,
    selectForm,
    load,
    create,
    sectionMessages,
    deletedAnswerKeys,
    busySection,
    setSectionMessage,
    deleteSectionAnswer,
    saveDocumentAnswers,
  }
}
