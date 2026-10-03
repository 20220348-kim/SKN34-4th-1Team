import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type {
  ApplicationForm,
  ApplicationFormAvailability,
  ApplicationFormDiscoveryJob,
  ApplicationServiceField,
} from '../../../../domain/entities/ApplicationPreparation'
import type { SupportProgram, SupportProgramDetail } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'
import { appPaths } from '../../../shared/routes/appPaths'
import { usePreparationJobActions } from '../../../shared/preparation-jobs/usePreparationJobs'
import { defaultProgramSelectionFilters, joinFilterValues, splitFilterValues } from '../../../shared/support-program/catalogSearchParams'
import { useSavedSupportProgramChoices } from '../../../shared/support-program/useSavedSupportProgramChoices'
import type { WorkspaceToastNotice } from '../../../shared/workspace/WorkspaceToast'
import { formAnalysisNeedsSource, formAnalysisState } from './useApplicationPreparationListViewModel'

/**
 * 신청 준비가 공고 선택에 쓰는 필드입니다. 검색 결과·관심 공고·상세 조회 어느 쪽에서 골라도 같습니다.
 * 신청 경로는 상세 조회에서 고른 공고에만 있고, 없으면 양식 조회와 함께 상세를 한 번 읽어 확인합니다.
 */
export type SelectableSupportProgram = Omit<SupportProgram, 'matchedReasons' | 'recommendationScore' | 'eligibilityReview'> & {
  applicationRoute?: SupportProgramDetail['applicationRoute']
}

/** 저장된 양식 조회(AI 호출 없음) 상태입니다. ready는 양식이 있든 없든 조회를 마친 상태입니다. */
export type AvailabilityLookup =
  | { status: 'loading' }
  | { status: 'ready'; result: ApplicationFormAvailability }
  | { status: 'failed'; error: Error }

/** 진행 카드에 보이는 분석 작업입니다. resumed는 이전에 시작해 둔 작업을 이어받은 경우입니다. */
export type DiscoveryProgress = { reanalysis: boolean; resumed: boolean; startedAt: number }

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('신청 문서 정보를 처리하지 못했습니다.')
}

export function programKey(program: { sourceCode: string; id: string }) {
  return `${program.sourceCode}:${program.id}`
}

/** 조회 결과에서 바로 작성할 수 있는 양식입니다. AVAILABLE이 아니면 양식이 있어도 쓰지 않습니다. */
export function storedForms(result: ApplicationFormAvailability): ApplicationForm[] {
  return result.state.status === 'AVAILABLE' ? result.forms.items : []
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
  if (code === 'UNKNOWN_AFTER_START') return '분석 시작 후 결과를 확인하지 못해 관리자 확인이 필요합니다.'
  return '공식 문서와 양식 준비 상태를 확인해야 합니다.'
}

/**
 * 분석 작업이 남긴 실패 코드를 사용자 문장으로 바꿉니다. 작업 코드는 조회 상태의 이유 코드에 `APPLICATION_FORM_`이 붙었거나
 * 작업에만 있는 코드(대기 만료 · 결과 불명 등)입니다.
 */
export function formAnalysisFailureReason(code: string | null): string {
  if (code === 'RUN_OUTCOME_UNKNOWN') return '분석을 시작한 뒤 결과를 확인하지 못했습니다.'
  if (code === 'RUN_OUTCOME_UNKNOWN_EXPIRED') return '분석 결과를 끝내 확인하지 못해 작업을 닫았습니다.'
  if (code === 'QUEUE_EXPIRED') return '대기 시간이 길어져 분석을 시작하지 못했습니다.'
  if (code === 'ACCOUNT_INACTIVE') return '계정을 사용할 수 없는 상태여서 분석을 시작하지 못했습니다.'
  if (code === 'DISCOVERY_FAILED') return '분석을 시작하기 전에 문제가 생겼습니다.'
  return availabilityReason((code ?? 'AI_INVALID_RESPONSE').replace(/^APPLICATION_FORM_/, ''))
}

/**
 * 이 공고에서 가장 최근에 끝난(또는 결과를 확인 중인) 분석입니다. ②에서 양식 조회 결과와 함께 보여 줍니다.
 * unknown은 서버가 결과를 확인 중이라 그 공고를 다시 분석할 수 없는 상태, failed는 실패 이유와 함께 다시 분석할 수 있는 상태,
 * source는 작성할 양식을 얻지 못해(실제로 양식이 없는 공고일 수 있음) 실패가 아니라 원문 참고로 알리는 상태입니다.
 */
export type LastFormAnalysis = { kind: 'unknown' | 'failed' | 'source'; startedAt: string; reason: string }

function lastFormAnalysisOf(job: ApplicationFormDiscoveryJob | undefined): LastFormAnalysis | null {
  const state = job ? formAnalysisState(job) : null
  if (!job || (state !== 'unknown' && state !== 'failed' && state !== 'source')) return null
  return { kind: state, startedAt: job.createdAt, reason: formAnalysisFailureReason(job.failureCode) }
}

/**
 * 저장된 양식이 없는 이유입니다. 아직 분석하지 않았거나(PENDING) 원문이 바뀐 경우(STALE)는 그 사실을, 그 밖에는 지난 분석이
 * 남긴 이유를 알립니다. 이 계정의 지난 분석을 따로 알리는 중이면 같은 이야기를 두 번 하지 않도록 원문이 바뀐 경우만 남깁니다.
 */
function noFormReason(result: ApplicationFormAvailability, lastAnalysisShown: boolean): string | null {
  const { status, reasonCode, nextRetryAt } = result.state
  if (status === 'AVAILABLE') return null
  if (status === 'STALE') return '공고나 공식 첨부가 바뀌어 양식을 다시 분석해야 해요.'
  if (lastAnalysisShown) return null
  if (status === 'PENDING') return '이 공고는 아직 신청 양식을 분석한 적이 없어요.'
  return `최근 분석: ${availabilityReason(reasonCode)}${nextRetryAt ? ` 다음 확인 ${nextRetryAt.replace('T', ' ')}` : ''}`
}

const activeJobStatuses: ApplicationFormDiscoveryJob['status'][] = ['QUEUED', 'RUNNING', 'UNKNOWN']

/**
 * 새 문서(24) 화면의 상태입니다. ① 공고를 고르면 저장된 양식을 조회하고(AI 호출 없음), ② 양식·지원 분야를 고르거나
 * 저장된 양식이 없으면 사용자가 누를 때만 입력칸별 분석 작업을 시작합니다.
 */
export function useApplicationPreparationNewViewModel(addressSourceCode: string, addressProgramId: string) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const programDetailUseCase = appContainer.resolve('getSupportProgramDetailUseCase')
  const navigate = useNavigate()
  // 분석을 시작하면 사이드바·목록이 따라가게 작업 목록을 다시 읽게 하고, 끝난 결과를 이 화면에서 봤으면 확인한 것으로 표시합니다.
  const { refresh: refreshJobs, markAnalysisSeen } = usePreparationJobActions()
  const hasAddressProgram = Boolean(addressSourceCode && addressProgramId)
  const [program, setProgram] = useState<SelectableSupportProgram | null>(null)
  const [programLoad, setProgramLoad] = useState<{ status: 'idle' | 'loading' } | { status: 'failed'; error: Error }>(
    () => hasAddressProgram ? { status: 'loading' } : { status: 'idle' })
  const [programLoadVersion, setProgramLoadVersion] = useState(0)
  const [activeJobs, setActiveJobs] = useState<ApplicationFormDiscoveryJob[]>([])
  const [availability, setAvailability] = useState<AvailabilityLookup | null>(null)
  /** 구글 설문으로 신청하는 공고의 설문 주소입니다. 이런 공고는 양식 조회·분석 없이 ②에서 설문 답을 미리 채워 엽니다. */
  const [googleFormUrl, setGoogleFormUrl] = useState<string | null>(null)
  const [forms, setForms] = useState<ApplicationForm[]>([])
  const [selectedFormVersionId, setSelectedFormVersionId] = useState('')
  const [serviceField, setServiceField] = useState<ApplicationServiceField>('GENERAL')
  const [discovery, setDiscovery] = useState<DiscoveryProgress | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [discoveryError, setDiscoveryError] = useState<Error | null>(null)
  const [capacityJobs, setCapacityJobs] = useState<ApplicationFormDiscoveryJob[] | null>(null)
  const [discoveryWarnings, setDiscoveryWarnings] = useState<string[]>([])
  const [lastAnalysis, setLastAnalysis] = useState<LastFormAnalysis | null>(null)
  const [toast, setToast] = useState<WorkspaceToastNotice | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [createError, setCreateError] = useState<Error | null>(null)
  const availabilityController = useRef<AbortController | null>(null)
  const discoveryController = useRef<AbortController | null>(null)
  const createController = useRef<AbortController | null>(null)
  const submittingGuard = useRef(false)
  const toastSequence = useRef(0)
  /** 이 화면에서 마지막으로 고른 공고입니다. 고른 공고를 주소에 적어도 다시 불러오지 않게 비교합니다. */
  const chosenKey = useRef('')

  const selectedForm = useMemo(
    () => forms.find(({ formVersionId }) => formVersionId === selectedFormVersionId) ?? null,
    [forms, selectedFormVersionId],
  )

  const applyForms = useCallback((items: ApplicationForm[]) => {
    setForms(items)
    const first = items[0]
    setSelectedFormVersionId(first?.formVersionId ?? '')
    setServiceField(first?.supportedServiceFields[0] ?? 'GENERAL')
  }, [])

  useEffect(() => () => {
    availabilityController.current?.abort()
    discoveryController.current?.abort()
    createController.current?.abort()
    submittingGuard.current = false
  }, [])

  // 진행 카드의 경과 시간. 서버 작업은 화면을 나가도 계속되므로 시계만 보여 준다.
  useEffect(() => {
    if (discovery === null) { setElapsedSeconds(0); return }
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - discovery.startedAt) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [discovery])

  /**
   * 분석 작업을 시작(또는 이어받아)하고 끝날 때까지 2초마다 확인합니다. 끝나면 ②를 양식 카드로 바꾸고 토스트로 알립니다.
   * 결과 불명으로 끝나면 실패가 아니라 "결과 확인 중"으로, 작성할 양식을 얻지 못하고 끝나면 "원문 참고"로 남깁니다.
   */
  const track = useCallback(async (start: (signal: AbortSignal) => Promise<ApplicationFormDiscoveryJob>, progress: DiscoveryProgress) => {
    if (discoveryController.current) return
    const controller = new AbortController()
    discoveryController.current = controller
    setDiscovery(progress)
    setDiscoveryError(null)
    setCapacityJobs(null)
    setLastAnalysis(null)
    try {
      let job = await start(controller.signal)
      if (!progress.resumed) refreshJobs()
      const deadline = Date.now() + 720_000
      while (job.status === 'QUEUED' || job.status === 'RUNNING') {
        if (Date.now() >= deadline) throw new Error('양식 분석이 아직 진행 중입니다. 잠시 후 이 공고를 다시 열어 확인해 주세요.')
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')) }
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 2000)
          controller.signal.addEventListener('abort', abort, { once: true })
          if (controller.signal.aborted) abort()
        })
        job = await useCase.discoveryJob(job.id, controller.signal)
      }
      if (controller.signal.aborted) return
      // 결과 불명은 아직 끝난 것이 아니므로 작업 목록만 다시 읽게 하고, 끝난 결과는 지금 보고 있으므로 확인한 것으로 표시합니다.
      if (job.status === 'UNKNOWN') refreshJobs()
      else markAnalysisSeen(job.sourceCode, job.sourceProgramId)
      if (job.status === 'UNKNOWN' || (job.status === 'FAILED' && formAnalysisNeedsSource(job.failureCode))) { setLastAnalysis(lastFormAnalysisOf(job)); return }
      if (job.status !== 'SUCCEEDED' || !job.result) throw new Error(formAnalysisFailureReason(job.failureCode))
      if (job.result.items.length === 0) throw new Error('공식 원본에서 작성할 양식을 찾지 못했습니다.')
      applyForms(job.result.items)
      setDiscoveryWarnings(job.result.warnings)
      setToast({ id: ++toastSequence.current, text: progress.reanalysis ? '양식을 다시 분석했어요' : '양식을 분석했어요' })
    } catch (caught) {
      if (controller.signal.aborted) return
      if (caught instanceof ApplicationPreparationError && caught.code === 'APPLICATION_FORM_JOB_CAPACITY') {
        // 계정의 진행 중·확인 필요 작업을 보여 주어 무엇이 자리를 차지하는지 알립니다. 목록을 못 읽어도 경고는 보입니다.
        const jobs = await useCase.discoveryJobs(controller.signal).catch(() => [] as ApplicationFormDiscoveryJob[])
        if (!controller.signal.aborted) setCapacityJobs(jobs.filter((job) => activeJobStatuses.includes(job.status)))
      } else {
        setDiscoveryError(asError(caught))
      }
    } finally {
      if (discoveryController.current === controller) { discoveryController.current = null; setDiscovery(null) }
    }
  }, [applyForms, markAnalysisSeen, refreshJobs, useCase])

  /**
   * 공고의 저장된 양식을 조회하고, 그 공고에서 이 계정이 가장 최근에 한 분석을 이어받습니다(모두 GET · AI 호출 없음).
   * 대기·분석 중이면 진행 카드로 이어 보고, 결과 확인 중이거나 하루 안에 실패했으면 그 사실을 ②에 알립니다. 완료했거나
   * 결과가 확인된 분석은 조회한 양식이 곧 결과이므로 따로 알리지 않습니다.
   * 공고 고르기 패널에서 이미 조회한 결과가 있으면 그 결과를 그대로 씁니다. 구글 설문으로 신청하는 공고는 설문 답을
   * 미리 채워 열도록 하고 양식·분석 작업을 쓰지 않습니다. 신청 경로를 모르면 같은 때에 상세를 한 번 읽어 확인합니다.
   */
  const lookup = useCallback((target: SelectableSupportProgram, known?: ApplicationFormAvailability) => {
    availabilityController.current?.abort()
    const controller = new AbortController()
    availabilityController.current = controller
    setGoogleFormUrl(null)
    setAvailability(known ? { status: 'ready', result: known } : { status: 'loading' })
    applyForms(known ? storedForms(known) : [])
    setLastAnalysis(null)
    void (async () => {
      try {
        const [route, result, jobs] = await Promise.all([
          target.applicationRoute
            ?? programDetailUseCase.execute({ sourceCode: target.sourceCode, sourceProgramId: target.id }, controller.signal)
              .then((detail) => detail?.applicationRoute ?? null)
              // 상세를 못 읽어도 양식 조회는 그대로 보여 줍니다. 신청 경로 확인만 건너뜁니다.
              .catch(() => null),
          known ?? useCase.availability(target.sourceCode, target.id, controller.signal),
          useCase.discoveryJobs(controller.signal).catch(() => [] as ApplicationFormDiscoveryJob[]),
        ])
        if (controller.signal.aborted) return
        if (route?.type === 'GOOGLE_FORMS' && route.url) {
          setGoogleFormUrl(route.url)
          setAvailability(null)
          applyForms([])
          return
        }
        if (!known) { setAvailability({ status: 'ready', result }); applyForms(storedForms(result)) }
        const own = jobs.filter((job) => job.sourceCode === target.sourceCode && job.sourceProgramId === target.id)
        // 서버에 확인 전 결과가 있으면 확인한 것으로 표시하고, 없으면 작업 목록만 다시 읽습니다(다른 탭·기기에서 이미 확인한 표시가 이 탭에 남지 않게).
        if (own.some((job) => (job.status === 'SUCCEEDED' || job.status === 'FAILED') && job.seen === false)) markAnalysisSeen(target.sourceCode, target.id)
        else refreshJobs()
        const active = own.find((job) => job.status === 'QUEUED' || job.status === 'RUNNING')
        if (active) {
          void track(async () => active, { reanalysis: storedForms(result).length > 0, resumed: true, startedAt: Date.parse(active.createdAt) || Date.now() })
        } else {
          setLastAnalysis(lastFormAnalysisOf(own.reduce<ApplicationFormDiscoveryJob | undefined>((newest, job) => !newest || newest.id < job.id ? job : newest, undefined)))
        }
      } catch (caught) {
        if (!controller.signal.aborted) setAvailability({ status: 'failed', error: asError(caught) })
      } finally {
        if (availabilityController.current === controller) availabilityController.current = null
      }
    })()
  }, [applyForms, markAnalysisSeen, programDetailUseCase, refreshJobs, track, useCase])

  /** 공고를 정합니다. 다른 공고의 분석 확인은 멈추지만(서버 작업은 계속), 그 공고를 다시 고르면 이어받습니다. */
  const choose = useCallback((next: SelectableSupportProgram, known?: ApplicationFormAvailability) => {
    if (submittingGuard.current) return
    discoveryController.current?.abort()
    discoveryController.current = null
    setDiscovery(null)
    chosenKey.current = programKey(next)
    setProgram(next)
    setDiscoveryError(null)
    setCapacityJobs(null)
    setDiscoveryWarnings([])
    setCreateError(null)
    lookup(next, known)
  }, [lookup])

  // 주소의 공고를 불러와 고릅니다. 다시 들어오거나 [이어서 보기]로 오면 그 공고의 진행 중인 분석도 이어받습니다.
  useEffect(() => {
    if (!hasAddressProgram || chosenKey.current === `${addressSourceCode}:${addressProgramId}`) return
    const controller = new AbortController()
    setProgramLoad({ status: 'loading' })
    programDetailUseCase.execute({ sourceCode: addressSourceCode, sourceProgramId: addressProgramId }, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return
        if (!found) {
          // 공고가 목록에서 빠져 결과를 보여 줄 수 없어도, 그 공고의 확인 전 표시가 계속 남지 않게 확인한 것으로 돌립니다.
          markAnalysisSeen(addressSourceCode, addressProgramId)
          setProgramLoad({ status: 'failed', error: new Error('공고를 찾지 못했습니다. 공고를 다시 골라 주세요.') })
          return
        }
        setProgramLoad({ status: 'idle' })
        choose(found)
      })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setProgramLoad({ status: 'failed', error: asError(caught) }) })
    return () => controller.abort()
  }, [addressProgramId, addressSourceCode, choose, hasAddressProgram, markAnalysisSeen, programDetailUseCase, programLoadVersion])

  // 공고 없이 들어오면 계정의 진행 중인 분석을 찾아 [이어서 보기]로 돌아갈 수 있게 합니다(GET · AI 호출 없음).
  useEffect(() => {
    if (hasAddressProgram) return
    const controller = new AbortController()
    useCase.discoveryJobs(controller.signal)
      .then((jobs) => { if (!controller.signal.aborted) setActiveJobs(jobs.filter((job) => job.status === 'QUEUED' || job.status === 'RUNNING')) })
      .catch(() => {})
    return () => controller.abort()
  }, [hasAddressProgram, useCase])

  const retryProgramLoad = useCallback(() => setProgramLoadVersion((version) => version + 1), [])
  const retryAvailability = useCallback(() => { if (program) lookup(program) }, [lookup, program])

  /** 유료 분석은 이 클릭에서만 시작합니다. 이미 양식이 있으면 입력칸별 재분석입니다. 결과 확인 중인 분석이 있으면 시작하지 않습니다. */
  const analysisBlocked = lastAnalysis?.kind === 'unknown'
  const discoverForms = useCallback(() => {
    if (!program || googleFormUrl || submittingGuard.current || analysisBlocked) return
    const target = program
    void track((signal) => useCase.discover(target.sourceCode, target.id, signal, crypto.randomUUID()),
      { reanalysis: forms.length > 0, resumed: false, startedAt: Date.now() })
  }, [analysisBlocked, forms.length, googleFormUrl, program, track, useCase])

  const selectForm = useCallback((formVersionId: string) => {
    const form = forms.find((candidate) => candidate.formVersionId === formVersionId)
    if (!form) return
    setSelectedFormVersionId(formVersionId)
    setServiceField((current) => form.supportedServiceFields.includes(current) ? current : form.supportedServiceFields[0])
  }, [forms])

  const create = useCallback(async () => {
    if (submittingGuard.current || discoveryController.current) return
    if (!selectedForm || !selectedForm.supportedServiceFields.includes(serviceField)) {
      setCreateError(new Error('지원 공고와 공식 양식, 작성 분야를 다시 선택해 주세요.'))
      return
    }
    submittingGuard.current = true
    const controller = new AbortController()
    createController.current = controller
    setSubmitting(true)
    setCreateError(null)
    try {
      const created = await useCase.create({
        sourceCode: selectedForm.sourceCode,
        sourceProgramId: selectedForm.sourceProgramId,
        formVersionId: selectedForm.formVersionId,
        serviceField,
      }, controller.signal)
      if (!controller.signal.aborted) navigate(`${appPaths.applicationPreparations}/${created.id}`, { replace: true })
    } catch (caught) {
      if (!controller.signal.aborted) setCreateError(asError(caught))
    } finally {
      if (!controller.signal.aborted && createController.current === controller) {
        createController.current = null
        submittingGuard.current = false
        setSubmitting(false)
      }
    }
  }, [navigate, selectedForm, serviceField, useCase])

  const dismissToast = useCallback(() => setToast(null), [])

  return {
    program,
    activeJobs: hasAddressProgram ? [] : activeJobs,
    programLoad,
    availability,
    googleFormUrl,
    noFormReason: availability?.status === 'ready' ? noFormReason(availability.result, lastAnalysis !== null) : null,
    lastAnalysis,
    analysisBlocked,
    forms,
    selectedForm,
    selectedFormVersionId,
    serviceField,
    discovery,
    elapsedSeconds,
    discoveryError,
    capacityJobs,
    discoveryWarnings,
    toast,
    submitting,
    createError,
    choose,
    retryProgramLoad,
    retryAvailability,
    discoverForms,
    selectForm,
    setServiceField,
    create,
    dismissToast,
  }
}

type SearchState = { status: 'idle' | 'loading' | 'more' | 'ready' } | { status: 'failed'; error: Error; append: boolean }

/**
 * 공고 고르기 패널의 상태입니다. 패널이 열릴 때마다 새로 만들어지고, 고른 행은 [이 공고 선택]을 누르기 전까지 임시입니다.
 * 행을 고르면 그 공고의 저장된 양식을 바로 조회합니다(AI 호출 없음).
 */
export function useProgramPickerViewModel(current: SelectableSupportProgram | null, currentAvailability: AvailabilityLookup | null) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const catalogUseCase = appContainer.resolve('browseSupportProgramsUseCase')
  const saved = useSavedSupportProgramChoices(true)
  const [tab, setTabState] = useState<'saved' | 'search'>('saved')
  const tabChosen = useRef(false)
  const [keyword, setKeyword] = useState('')
  /** 마지막으로 검색에 적용한 조건입니다. [필터 (n)] 개수와 조건 칩은 이 값을 따릅니다. */
  const [filters, setFilters] = useState<SupportProgramCatalogFilters>(defaultProgramSelectionFilters)
  /** 필터 칸에서 고르는 중인 조건입니다. [검색]·Enter를 눌러야 적용됩니다. */
  const [draft, setDraft] = useState<SupportProgramCatalogFilters>(defaultProgramSelectionFilters)
  const [results, setResults] = useState<SupportProgram[]>([])
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [search, setSearch] = useState<SearchState>({ status: 'idle' })
  const [picked, setPicked] = useState<SelectableSupportProgram | null>(current)
  const [pickedAvailability, setPickedAvailability] = useState<AvailabilityLookup | null>(
    current && currentAvailability?.status === 'ready' ? currentAvailability : null)
  const searchController = useRef<AbortController | null>(null)
  const pickController = useRef<AbortController | null>(null)

  useEffect(() => () => { searchController.current?.abort(); pickController.current?.abort() }, [])

  // 관심 공고가 하나도 없으면 전체 검색을 기본으로 엽니다. 사용자가 탭을 직접 고른 뒤에는 바꾸지 않습니다.
  useEffect(() => {
    if (!tabChosen.current && saved.phase === 'ready' && saved.programs.length === 0) setTabState('search')
  }, [saved.phase, saved.programs.length])

  const runSearch = useCallback(async (next: SupportProgramCatalogFilters, append = false) => {
    searchController.current?.abort()
    const controller = new AbortController()
    searchController.current = controller
    // 다시 검색할 때 기존 결과는 남겨 둡니다. 패널이 흐리게 보여 주다가 새 결과로 바꿉니다.
    if (!append) { setFilters(next); setDraft(next); setKeyword(next.keyword) }
    setSearch({ status: append ? 'more' : 'loading' })
    try {
      const result = await catalogUseCase.execute({ ...next, keyword: next.keyword.trim() }, controller.signal)
      if (controller.signal.aborted) return
      setCatalog(result)
      setResults((previous) => {
        if (!append) return result.programs
        const seen = new Set(previous.map(programKey))
        return [...previous, ...result.programs.filter((item) => !seen.has(programKey(item)))]
      })
      setSearch({ status: 'ready' })
    } catch (caught) {
      if (controller.signal.aborted) return
      // 새 조건의 검색에 실패하면 이전 조건의 결과를 지금 조건의 결과처럼 남기지 않습니다. 더 보기 실패는 읽은 결과를 둡니다.
      if (!append) { setResults([]); setCatalog(null) }
      setSearch({ status: 'failed', error: asError(caught), append })
    } finally {
      if (searchController.current === controller) searchController.current = null
    }
  }, [catalogUseCase])

  // 전체 검색 탭을 처음 열면 기본 조건으로 한 번 찾아 둡니다.
  useEffect(() => {
    if (tab === 'search' && search.status === 'idle') void runSearch(defaultProgramSelectionFilters)
  }, [runSearch, search.status, tab])

  const setTab = useCallback((next: 'saved' | 'search') => { tabChosen.current = true; setTabState(next) }, [])

  const lookup = useCallback((program: SelectableSupportProgram) => {
    pickController.current?.abort()
    const controller = new AbortController()
    pickController.current = controller
    setPickedAvailability({ status: 'loading' })
    useCase.availability(program.sourceCode, program.id, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPickedAvailability({ status: 'ready', result }) })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setPickedAvailability({ status: 'failed', error: asError(caught) }) })
  }, [useCase])

  const pick = useCallback((program: SelectableSupportProgram) => {
    setPicked(program)
    lookup(program)
  }, [lookup])

  const retryPick = useCallback(() => { if (picked) lookup(picked) }, [lookup, picked])

  /** [검색]·Enter: 검색어와 고르는 중인 필터를 함께 적용합니다. */
  const searchKeyword = useCallback(() => {
    void runSearch({ ...draft, keyword: keyword.trim(), page: 1 })
  }, [draft, keyword, runSearch])
  /** 지역·지원 분야는 여러 값을 쉼표로 이어 담습니다("서울,경기"). 고르기만 하고 적용하지 않습니다. */
  const toggleDraftValue = useCallback((key: 'region' | 'category', value: string) => {
    setDraft((current) => {
      const values = splitFilterValues(current[key])
      return { ...current, [key]: joinFilterValues(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]) }
    })
  }, [])
  const changeDraft = useCallback((next: Partial<SupportProgramCatalogFilters>) => setDraft((current) => ({ ...current, ...next })), [])
  /** 조건 칩 해제는 누르는 즉시 적용합니다. 지역·지원 분야는 값 하나만 뺍니다. */
  const removeCondition = useCallback((key: 'keyword' | 'region' | 'category' | 'sourceCode' | 'status', value?: string) => {
    const next = key === 'region' || key === 'category'
      ? joinFilterValues(splitFilterValues(filters[key]).filter((item) => item !== value))
      : defaultProgramSelectionFilters[key]
    void runSearch({ ...filters, [key]: next, page: 1 })
  }, [filters, runSearch])
  const resetFilters = useCallback(() => {
    const { region, category, sourceCode, status } = defaultProgramSelectionFilters
    void runSearch({ ...filters, region, category, sourceCode, status, page: 1 })
  }, [filters, runSearch])
  const loadMore = useCallback(() => {
    if (!catalog || catalog.page >= catalog.totalPages) return
    void runSearch({ ...filters, page: catalog.page + 1 }, true)
  }, [catalog, filters, runSearch])
  const retrySearch = useCallback(() => {
    if (search.status === 'failed' && search.append) loadMore()
    else void runSearch(filters)
  }, [filters, loadMore, runSearch, search])

  return {
    tab,
    setTab,
    saved,
    keyword,
    setKeyword,
    filters,
    draft,
    toggleDraftValue,
    changeDraft,
    removeCondition,
    results,
    catalog,
    search,
    searchKeyword,
    resetFilters,
    loadMore,
    retrySearch,
    picked,
    pickedAvailability,
    pick,
    retryPick,
    canConfirm: picked !== null && pickedAvailability?.status === 'ready',
  }
}
