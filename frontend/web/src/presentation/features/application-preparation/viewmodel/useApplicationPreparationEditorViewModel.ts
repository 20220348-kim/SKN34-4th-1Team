import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type {
  ApplicationForm,
  ApplicationPreparation,
  ApplicationFormSection,
  NewApplicationPreparationFact,
  ApplicationServiceField,
  ApplicationFormAvailability,
  ApplicationFormDiscoveryJob,
} from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'

/** 신청 준비가 공고 선택에 쓰는 필드입니다. 검색 결과·관심 공고·상세 조회 어느 쪽에서 골라도 같습니다. */
export type SelectableSupportProgram = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview'>
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import { appPaths } from '../../../shared/routes/appPaths'
import { useSavedSupportProgramChoices } from '../../../shared/support-program/useSavedSupportProgramChoices'
import { defaultProgramSelectionFilters } from '../../../shared/support-program/catalogSearchParams'

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('신청 문서 정보를 처리하지 못했습니다.')
}

/** 입력칸에 이 값이 있으면 "아직 정해지지 않았어요"(사실 상태 UNKNOWN)로 저장합니다. 글자로 적어도 같은 뜻입니다. */
export const undecidedAnswer = '미정'
/** 입력을 멈춘 뒤 이 시간이 지나면 그 항목을 저장합니다. 이동·이탈 때는 기다리지 않고 바로 저장합니다. */
export const autosaveDelayMs = 2_000
export const answerMaxLength = 2_000

export type AutosaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; savedAt: number }
  /** conflict: 다른 곳(다른 탭·기기)에서 답변이 먼저 바뀌어 최신 답변을 다시 불러온 경우입니다. 입력 중이던 값은 그대로 둡니다. */
  | { status: 'failed'; error: Error; conflict: boolean }

export type AnswerFieldError = { key: string; message: string }
/** [답변 지우기] 뒤 토스트의 [되돌리기]에 쓰는 직전 값입니다. */
export type DeletedAnswerNotice = { id: number; key: string; previous: string; label: string }

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
  if (code.includes('UNSUPPORTED')) return '분석 가능한 PDF·HWP·HWPX·DOCX·XLSX 양식을 확보하지 못했습니다.'
  if (code.includes('UNAVAILABLE')) return '공식 사이트 또는 분석 서비스가 일시적으로 응답하지 않습니다.'
  if (code.includes('CHANGED')) return '공고나 공식 첨부가 변경되어 다시 확인해야 합니다.'
  if (code.includes('INVALID') || code.includes('FAILED')) return '첨부 형식 또는 추출한 문항의 근거를 검증하지 못했습니다.'
  if (code === 'NO_FORM') return '분석한 공식 첨부에서 작성할 신청 양식을 찾지 못했습니다.'
  if (code === 'FORM_FOUND') return '공식 첨부에서 작성 가능한 양식을 확인했습니다.'
  if (code === 'UNKNOWN_AFTER_START') return '분석 시작 후 결과를 확인하지 못해 관리자 확인이 필요합니다.'
  return '공식 문서와 양식 준비 상태를 확인해야 합니다.'
}

/** 항목 하나의 화면 상태(입력 중 값 · 지운 표시 · 저장된 사실)를 서버에 보낼 사실 목록으로 바꿉니다. */
function buildSectionFacts(section: ApplicationFormSection, messages: Record<string, string>, deleted: ReadonlySet<string>):
  { facts: NewApplicationPreparationFact[]; error: AnswerFieldError | null } {
  const facts: NewApplicationPreparationFact[] = []
  for (const field of section.fields) {
    const key = `${section.key}:${field.key}`
    const existing = section.facts.find((fact) => fact.fieldKey === field.key)
    const keep = existing ? { fieldKey: existing.fieldKey, status: existing.status, value: existing.value, sourceText: existing.sourceText } : null
    if (deleted.has(key)) continue
    if (!Object.hasOwn(messages, key)) { if (keep) facts.push(keep); continue }
    const value = messages[key].trim()
    // 칸을 비운 것만으로는 저장된 답변을 지우지 않습니다. 지우기는 [답변 지우기]로만 합니다.
    if (!value) { if (keep) facts.push(keep); continue }
    if ([...value].length > answerMaxLength) return { facts: [], error: { key, message: `답변은 ${answerMaxLength.toLocaleString('ko-KR')}자 이내로 입력해 주세요.` } }
    if (value !== undecidedAnswer && field.options?.length && !field.options.includes(value)) {
      return { facts: [], error: { key, message: '공식 선택지 중에서 골라 주세요.' } }
    }
    facts.push(value === undecidedAnswer
      ? { fieldKey: field.key, status: 'UNKNOWN', value: null, sourceText: `${field.label}: ${undecidedAnswer}` }
      : { fieldKey: field.key, status: 'PROVIDED', value, sourceText: `${field.label}: ${value}` })
  }
  return { facts, error: null }
}

/** 보낼 사실이 저장된 사실과 같으면 요청을 보내지 않습니다(입력 버전이 헛되이 오르지 않게). */
function sameFacts(saved: ApplicationFormSection['facts'], next: NewApplicationPreparationFact[]) {
  if (saved.length !== next.length) return false
  return next.every((fact) => saved.some((existing) => existing.fieldKey === fact.fieldKey && existing.status === fact.status && existing.value === fact.value))
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
  const [documentCount, setDocumentCount] = useState(0)
  const [serviceField, setServiceField] = useState<ApplicationServiceField>('GENERAL')
  const [discoveryInput, setDiscoveryInput] = useState(initialSourceProgramId)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([])
  const [availabilityStatus, setAvailabilityStatus] = useState<string | null>(null)
  const [checkingAvailability, setCheckingAvailability] = useState(false)
  const [discoveryStartedAt, setDiscoveryStartedAt] = useState<number | null>(null)
  const [discoveryElapsedSeconds, setDiscoveryElapsedSeconds] = useState(0)
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [catalogFilters, setCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [appliedCatalogFilters, setAppliedCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogError, setCatalogError] = useState<Error | null>(null)
  const [selectedProgram, setSelectedProgram] = useState<SelectableSupportProgram | null>(null)
  const [discoverySourceCode, setDiscoverySourceCode] = useState(initialSourceCode)
  const [creationStep, setCreationStep] = useState<'PROGRAM' | 'FORM'>('PROGRAM')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const createController = useRef<AbortController | null>(null)
  const discoveryController = useRef<AbortController | null>(null)
  const availabilityController = useRef<AbortController | null>(null)
  const catalogController = useRef<AbortController | null>(null)
  const loadSequence = useRef(0)
  const submittingGuard = useRef(false)

  // ── 답변 자동 저장 ──
  // 입력 중 값과 지운 표시는 화면 상태이자 ref입니다. ref는 타이머·이탈 이벤트처럼 렌더 밖에서 최신 값을 읽을 때 씁니다.
  const [sectionMessages, setSectionMessages] = useState<Record<string, string>>({})
  const [deletedAnswerKeys, setDeletedAnswerKeys] = useState<Set<string>>(() => new Set())
  const [autosave, setAutosave] = useState<AutosaveState>({ status: 'idle' })
  const [fieldError, setFieldError] = useState<AnswerFieldError | null>(null)
  const [deletedAnswerNotice, setDeletedAnswerNotice] = useState<DeletedAnswerNotice | null>(null)
  const messagesRef = useRef<Record<string, string>>({})
  const deletedRef = useRef<Set<string>>(new Set())
  const preparationRef = useRef<ApplicationPreparation | null>(null)
  /** 저장이 필요한 항목 키입니다. 저장이 성공하면 비우고, 실패하면 다시 넣어 [다시 시도]가 같은 항목을 보내게 합니다. */
  const dirtySections = useRef<Set<string>>(new Set())
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveTask = useRef<Promise<void> | null>(null)
  const saveController = useRef<AbortController | null>(null)
  const noticeSequence = useRef(0)

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
      preparationRef.current = result as ApplicationPreparation
      setPreparation(result as ApplicationPreparation)
    }).catch((caught: unknown) => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return
      setError(asError(caught))
    }).finally(() => {
      if (controller.signal.aborted || sequence !== loadSequence.current) return
      loadController.current = null
      setLoading(false)
    })
    // 머리글 [문서 보기]는 만든 초안이 있을 때만 보입니다. 목록 조회 실패는 편집을 막지 않으므로 조용히 0으로 둡니다.
    void useCase.documents(id, controller.signal)
      .then((files) => { if (!controller.signal.aborted && sequence === loadSequence.current) setDocumentCount(files.length) })
      .catch(() => {})

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
    availabilityController.current?.abort()
    catalogController.current?.abort()
    submittingGuard.current = false
  }, [])

  // 진행 카드의 경과 시간. 서버 작업은 화면을 나가도 계속되므로 시계만 보여 준다.
  useEffect(() => {
    if (discoveryStartedAt === null) { setDiscoveryElapsedSeconds(0); return }
    const tick = () => setDiscoveryElapsedSeconds(Math.max(0, Math.floor((Date.now() - discoveryStartedAt) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [discoveryStartedAt])

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

  const applyAvailability = useCallback((result: ApplicationFormAvailability) => {
    setAvailabilityStatus(result.state.status)
    if (result.state.status === 'PENDING' || result.state.status === 'STALE') {
      setDiscoveryWarnings(['이 공고의 신청 양식은 아직 분석하지 않았습니다. 입력칸별로 분석을 시작할 수 있습니다.'])
      setForms([])
      return
    }
    setDiscoveryWarnings([availabilityMessages[result.state.status], availabilityReason(result.state.reasonCode),
      ...(result.state.nextRetryAt && result.state.status !== 'AVAILABLE' ? [`다음 확인: ${result.state.nextRetryAt.replace('T', ' ')}`] : [])])
    setForms(result.forms.items)
    const first = result.forms.items[0]
    if (result.state.status === 'AVAILABLE' && first) {
      setSelectedFormVersionId(first.formVersionId)
      setServiceField(first.supportedServiceFields[0])
    }
  }, [])

  const pollDiscoveryJob = useCallback(async (started: ApplicationFormDiscoveryJob, controller: AbortController, successMessage: string) => {
    let job = started
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
    setDiscoveryWarnings([successMessage, ...job.result.warnings])
    setCreationStep('FORM')
  }, [useCase])

  // 공고를 고르면 저장된 양식을 바로 조회하고(AI 호출 없음), 이전에 시작해 둔 분석 작업이 있으면 폴링을 이어받는다.
  const checkAvailability = useCallback((sourceCode: string, sourceProgramId: string) => {
    availabilityController.current?.abort()
    const controller = new AbortController()
    availabilityController.current = controller
    setCheckingAvailability(true)
    setError(null)
    void (async () => {
      try {
        const [result, jobs] = await Promise.all([
          useCase.availability(sourceCode, sourceProgramId, controller.signal),
          useCase.discoveryJobs(controller.signal).catch(() => [] as ApplicationFormDiscoveryJob[]),
        ])
        if (controller.signal.aborted) return
        const active = jobs.find((job) => job.sourceCode === sourceCode && job.sourceProgramId === sourceProgramId
          && (job.status === 'QUEUED' || job.status === 'RUNNING'))
        if (active && !discoveryController.current) {
          const jobController = new AbortController()
          discoveryController.current = jobController
          setDiscovering(true); setDiscoveryStartedAt(Date.parse(active.createdAt) || Date.now())
          setDiscoveryWarnings(['이전에 시작한 양식 분석이 진행 중입니다. 화면을 나가도 계속됩니다.'])
          try {
            await pollDiscoveryJob(active, jobController, '공식 첨부에서 신청 양식을 확인했습니다.')
          } catch (caught) {
            if (!jobController.signal.aborted) setError(asError(caught))
          } finally {
            if (discoveryController.current === jobController) { discoveryController.current = null; setDiscovering(false); setDiscoveryStartedAt(null) }
          }
          return
        }
        applyAvailability(result)
      } catch (caught) {
        if (!controller.signal.aborted) setError(asError(caught))
      } finally {
        if (availabilityController.current === controller) { availabilityController.current = null; setCheckingAvailability(false) }
      }
    })()
    return controller
  }, [applyAvailability, pollDiscoveryJob, useCase])

  const applyProgramSelection = useCallback((program: SelectableSupportProgram) => {
    setSelectedProgram(program)
    setDiscoverySourceCode(program.sourceCode)
    setDiscoveryInput(program.id)
    setCreationStep('PROGRAM')
    setForms([])
    setSelectedFormVersionId('')
    setDiscoveryWarnings([])
    setAvailabilityStatus(null)
    setError(null)
    checkAvailability(program.sourceCode, program.id)
  }, [checkAvailability])

  const selectProgram = useCallback((program: SelectableSupportProgram) => {
    if (discoveryController.current) return
    applyProgramSelection(program)
  }, [applyProgramSelection])

  const retryAvailability = useCallback(() => {
    if (!discoverySourceCode || !discoveryInput.trim() || discoveryController.current) return
    setForms([]); setSelectedFormVersionId(''); setDiscoveryWarnings([]); setAvailabilityStatus(null)
    checkAvailability(discoverySourceCode, discoveryInput)
  }, [checkAvailability, discoveryInput, discoverySourceCode])

  const clearProgramSelection = useCallback(() => {
    if (submittingGuard.current || discoveryController.current) return
    availabilityController.current?.abort()
    availabilityController.current = null
    setCheckingAvailability(false)
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

  const runDiscoveryJob = useCallback(async (controller: AbortController, successMessage: string) => {
    const job = await useCase.discover(discoverySourceCode, discoveryInput, controller.signal, crypto.randomUUID())
    await pollDiscoveryJob(job, controller, successMessage)
  }, [discoveryInput, discoverySourceCode, pollDiscoveryJob, useCase])

  // 유료 분석은 명시적 클릭에서만 시작한다. 이미 양식이 있으면 입력칸별 재분석, 없으면 첫 분석이다.
  const discoverForms = useCallback(async () => {
    if (discoveryController.current || !discoveryInput.trim() || id !== null) return
    availabilityController.current?.abort()
    availabilityController.current = null
    setCheckingAvailability(false)
    const reanalysis = availabilityStatus === 'AVAILABLE'
    const controller = new AbortController()
    discoveryController.current = controller
    setDiscovering(true); setDiscoveryStartedAt(Date.now())
    setError(null); setForms([]); setSelectedFormVersionId('')
    setCreationStep('PROGRAM')
    setDiscoveryWarnings([reanalysis
      ? '공식 원본의 입력칸별 질문을 다시 분석하고 있습니다. 기존 작성본은 변경하지 않습니다.'
      : '공식 첨부를 가져와 신청 양식을 분석하고 있습니다.'])
    try {
      await runDiscoveryJob(controller, reanalysis
        ? '입력칸별로 분석한 양식입니다. 이전 답변은 자동으로 나누지 않으므로 필요한 값을 직접 확인해 주세요.'
        : '공식 첨부에서 신청 양식을 확인했습니다.')
    } catch (caught) {
      if (!controller.signal.aborted) setError(asError(caught))
    } finally {
      if (discoveryController.current === controller) { discoveryController.current = null; setDiscovering(false); setDiscoveryStartedAt(null) }
    }
  }, [availabilityStatus, discoveryInput, id, runDiscoveryJob])

  useEffect(() => {
    if (id !== null || !initialSourceCode || !initialSourceProgramId) return
    const controller = new AbortController()
    void programDetailUseCase.execute({ sourceCode: initialSourceCode, sourceProgramId: initialSourceProgramId }, controller.signal)
      .then((program) => { if (!controller.signal.aborted && program) applyProgramSelection(program) })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(asError(caught)) })
    return () => controller.abort()
  }, [id, initialSourceCode, initialSourceProgramId, programDetailUseCase, applyProgramSelection])

  const goToFormStep = useCallback(() => {
    if (availabilityStatus !== 'AVAILABLE' || forms.length === 0 || discoveryController.current) return
    setError(null)
    setCreationStep('FORM')
  }, [availabilityStatus, forms.length])

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

  /** 항목 키(`section:field`)에서 항목 부분입니다. 항목·필드 키는 `[a-z0-9-]`뿐이라 첫 콜론이 경계입니다. */
  const sectionKeyOf = (key: string) => key.slice(0, key.indexOf(':'))

  /**
   * 저장이 끝난 항목의 입력 중 값을 비웁니다. 저장하는 동안 다시 바뀐 칸(스냅샷과 다른 값)은 남겨 두어 다음 저장에 실립니다.
   */
  const clearPending = useCallback((keys: string[], snapshot: Record<string, string>, deletedSnapshot: ReadonlySet<string>) => {
    const settled = keys.filter((key) => (Object.hasOwn(snapshot, key) ? messagesRef.current[key] === snapshot[key] : !Object.hasOwn(messagesRef.current, key))
      && deletedRef.current.has(key) === deletedSnapshot.has(key))
    for (const key of settled) { delete messagesRef.current[key]; deletedRef.current.delete(key) }
    setSectionMessages((current) => {
      const remaining = { ...current }
      for (const key of settled) delete remaining[key]
      return remaining
    })
    setDeletedAnswerKeys((current) => {
      const remaining = new Set(current)
      for (const key of settled) remaining.delete(key)
      return remaining
    })
    return settled.length === keys.length
  }, [])

  /**
   * 저장이 필요한 항목을 순서대로 서버에 보냅니다. 한 번에 하나의 저장만 진행하고, 진행 중이면 끝난 뒤 이어서 보냅니다.
   * `keepalive`는 화면을 떠나는 순간(pagehide · 언마운트)에만 씁니다. 그때는 중단 신호를 붙이지 않습니다.
   */
  const runSave = useCallback(async (keepalive = false) => {
    while (saveTask.current) await saveTask.current
    const current = preparationRef.current
    if (!current || dirtySections.current.size === 0) return
    const sectionKeys = [...dirtySections.current]
    dirtySections.current.clear()
    const controller = keepalive ? null : new AbortController()
    saveController.current = controller
    const task = (async () => {
      let latest = current
      let touched = false
      for (const sectionKey of sectionKeys) {
        const section = latest.form.sections.find((candidate) => candidate.key === sectionKey)
        if (!section) continue
        const snapshot = { ...messagesRef.current }
        const deletedSnapshot = new Set(deletedRef.current)
        const built = buildSectionFacts(section, snapshot, deletedSnapshot)
        if (built.error) {
          dirtySections.current.add(sectionKey)
          setFieldError(built.error)
          setAutosave({ status: 'failed', error: new Error(built.error.message), conflict: false })
          return
        }
        const keys = section.fields.map((field) => `${sectionKey}:${field.key}`)
        if (sameFacts(section.facts, built.facts)) {
          if (!clearPending(keys, snapshot, deletedSnapshot)) dirtySections.current.add(sectionKey)
          continue
        }
        setAutosave({ status: 'saving' })
        const updated = await useCase.replaceInputs(latest.id, sectionKey, { expectedRevision: latest.inputRevision, facts: built.facts },
          controller?.signal, keepalive ? { keepalive: true } : undefined)
        if (controller?.signal.aborted) return
        latest = updated
        preparationRef.current = updated
        setPreparation(updated)
        // 저장하는 동안 다시 바뀐 칸이 있으면 그 항목을 다음 저장 대상으로 남깁니다.
        if (!clearPending(keys, snapshot, deletedSnapshot)) dirtySections.current.add(sectionKey)
        touched = true
      }
      setFieldError(null)
      setAutosave((previous) => touched || previous.status === 'saving' ? { status: 'saved', savedAt: Date.now() } : previous)
    })().catch((caught: unknown) => {
      if (controller?.signal.aborted) return
      for (const key of sectionKeys) dirtySections.current.add(key)
      const conflict = caught instanceof ApplicationPreparationError && caught.code === 'APPLICATION_PREPARATION_REVISION_CONFLICT'
      setAutosave({ status: 'failed', error: asError(caught), conflict })
      // 다른 곳에서 먼저 바뀐 답변은 최신을 다시 불러오되, 입력 중이던 값은 그대로 둡니다.
      if (conflict) load()
    }).finally(() => {
      if (saveTask.current === task) saveTask.current = null
      if (saveController.current === controller) saveController.current = null
    })
    saveTask.current = task
    await task
  }, [clearPending, load, useCase])

  const cancelAutosaveTimer = () => {
    if (autosaveTimer.current !== null) { clearTimeout(autosaveTimer.current); autosaveTimer.current = null }
  }

  /** 입력을 멈춘 뒤 2초가 지나면 저장합니다. 그 사이 다시 입력하면 시간을 다시 잽니다. */
  const scheduleAutosave = useCallback(() => {
    cancelAutosaveTimer()
    autosaveTimer.current = setTimeout(() => { autosaveTimer.current = null; void runSave() }, autosaveDelayMs)
  }, [runSave])

  /** 이동·초안 만들기처럼 지금 바로 저장해야 할 때 씁니다. 모두 저장됐으면 true, 실패했으면 false입니다. */
  const flushAutosave = useCallback(async () => {
    cancelAutosaveTimer()
    await runSave()
    while (saveTask.current) await saveTask.current
    return dirtySections.current.size === 0
  }, [runSave])

  // 화면을 떠나는 순간(탭 닫기 · 다른 탭으로 · 다른 화면으로) 남은 입력을 keepalive로 보냅니다. 언마운트 정리도 같은 저장입니다.
  useEffect(() => {
    const flushOnLeave = () => { if (dirtySections.current.size > 0) { cancelAutosaveTimer(); void runSave(true) } }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushOnLeave() }
    window.addEventListener('pagehide', flushOnLeave)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flushOnLeave)
      document.removeEventListener('visibilitychange', onVisibility)
      flushOnLeave()
    }
  }, [runSave])

  const setSectionMessage = useCallback((key: string, message: string) => {
    messagesRef.current = { ...messagesRef.current, [key]: message }
    deletedRef.current.delete(key)
    setSectionMessages((current) => ({ ...current, [key]: message }))
    setDeletedAnswerKeys((current) => {
      if (!current.has(key)) return current
      const next = new Set(current)
      next.delete(key)
      return next
    })
    setFieldError((current) => current?.key === key ? null : current)
    dirtySections.current.add(sectionKeyOf(key))
    scheduleAutosave()
  }, [scheduleAutosave])

  /** 화면에 보이는 값입니다: 입력 중 값 → 지운 표시 → 저장된 사실 순. 저장된 UNKNOWN은 "미정"으로 보입니다. */
  const answerValue = useCallback((key: string) => {
    if (deletedRef.current.has(key)) return ''
    if (Object.hasOwn(messagesRef.current, key)) return messagesRef.current[key]
    const sectionKey = sectionKeyOf(key)
    const fact = preparationRef.current?.form.sections.find((section) => section.key === sectionKey)?.facts.find((saved) => saved.fieldKey === key.slice(sectionKey.length + 1))
    return fact?.status === 'UNKNOWN' ? undecidedAnswer : fact?.value ?? ''
  }, [])

  /** [답변 지우기]: 입력 중 값과 저장된 답변을 함께 지우고 바로 저장합니다. 되돌릴 수 있게 직전 값을 토스트에 둡니다. */
  const deleteSectionAnswer = useCallback((key: string) => {
    const previous = answerValue(key)
    const sectionKey = sectionKeyOf(key)
    const label = preparationRef.current?.form.sections.find((section) => section.key === sectionKey)?.fields.find((field) => `${sectionKey}:${field.key}` === key)?.label ?? '답변'
    messagesRef.current = { ...messagesRef.current, [key]: '' }
    deletedRef.current.add(key)
    setSectionMessages((current) => ({ ...current, [key]: '' }))
    setDeletedAnswerKeys((current) => new Set(current).add(key))
    setFieldError((current) => current?.key === key ? null : current)
    dirtySections.current.add(sectionKey)
    cancelAutosaveTimer()
    setDeletedAnswerNotice({ id: ++noticeSequence.current, key, previous, label })
    void runSave()
  }, [answerValue, runSave])

  const undoDeletedAnswer = useCallback(() => {
    const notice = deletedAnswerNotice
    if (!notice) return
    setDeletedAnswerNotice(null)
    setSectionMessage(notice.key, notice.previous)
    cancelAutosaveTimer()
    void runSave()
  }, [deletedAnswerNotice, runSave, setSectionMessage])

  const dismissDeletedAnswerNotice = useCallback(() => setDeletedAnswerNotice(null), [])

  const retryAutosave = useCallback(() => { void flushAutosave() }, [flushAutosave])

  /** 저장이 끝난 직후의 입력 버전입니다. 초안 만들기는 이 버전으로 결과 화면에 들어갑니다. */
  const latestRevision = useCallback(() => preparationRef.current?.inputRevision ?? null, [])

  const hasPendingAnswers = Object.keys(sectionMessages).length > 0 || deletedAnswerKeys.size > 0

  return {
    forms,
    selectedForm,
    selectedFormVersionId,
    preparation,
    documentCount,
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
    retryAvailability,
    availabilityStatus,
    checkingAvailability,
    discoveryElapsedSeconds,
    canProceedToForm: availabilityStatus === 'AVAILABLE' && forms.length > 0 && !discovering,
    goToFormStep,
    backToProgramSelection,
    selectForm,
    load,
    create,
    sectionMessages,
    deletedAnswerKeys,
    hasPendingAnswers,
    autosave,
    fieldError,
    deletedAnswerNotice,
    setSectionMessage,
    answerValue,
    deleteSectionAnswer,
    undoDeletedAnswer,
    dismissDeletedAnswerNotice,
    flushAutosave,
    retryAutosave,
    latestRevision,
  }
}
