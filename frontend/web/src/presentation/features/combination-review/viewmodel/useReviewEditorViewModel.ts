import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { appPaths } from '../../../shared/routes/appPaths'
import { reviewProgramKey, supportsAutomaticReview, unknownParticipation, unknownRelation, validateReviewDraft, type CombinationReview, type ReviewDraft, type ReviewPage, type ReviewProgram, type ReviewRun, type RunRequest, type RunSummary } from '../../../../domain/entities/CombinationReview'
import type { SupportProgramDetail } from '../../../../domain/entities/SupportProgram'
import type { SelectableSupportProgram } from '../../../shared/support-program/useProgramPickerViewModel'
import { useReviewScope } from './useReviewScope'

// 자동 조회보다 늦게 도착한 과거 응답이 완료 상태를 대기/분석 중으로 되돌리지 않게 한다.
function isEarlierState(current: RunSummary, next: RunSummary) {
  return current.id === next.id && (
    (current.status === 'RUNNING' && next.status === 'QUEUED') ||
    (!['QUEUED', 'RUNNING'].includes(current.status) && ['QUEUED', 'RUNNING'].includes(next.status))
  )
}

/** 새 검토에 미리 골라 둘 공고입니다. 공고 상세의 [중복 지원·수혜 검토]가 주소에 실어 보냅니다. */
export type InitialReviewProgram = Pick<ReviewProgram, 'sourceCode' | 'sourceProgramId'>

/** 고른 공고의 표시 정보입니다. 상세를 읽는 동안은 없고, 읽지 못하면 이름 자리에 이유만 보입니다. */
export type ReviewProgramInfo = { status: 'ready'; program: SelectableSupportProgram } | { status: 'missing' | 'failed' }

function infoOf(found: SupportProgramDetail | null): ReviewProgramInfo {
  return found ? { status: 'ready', program: found } : { status: 'missing' }
}

function programLabel(info: ReviewProgramInfo) {
  if (info.status === 'ready') return `${info.program.title} · ${info.program.organization}`
  return info.status === 'missing' ? '공고 정보를 찾을 수 없음' : '공고 정보를 불러오지 못함'
}

/** 저장 · 비교할 입력입니다. 관계 칸이 없던 검토는 모두 모름으로 보고, 필드 순서를 맞춰 바뀜 여부를 JSON으로 비교합니다. */
function inputOf(value: ReviewDraft): Required<ReviewDraft> {
  return { title: value.title, programs: value.programs, relation: value.relation ?? unknownRelation() }
}

/** 1단계의 사업 칸 수입니다. 새 분석은 정확히 2개를 비교합니다. */
const slotCount = 2

/**
 * 저장할 공고 목록과 비운 칸 위치로 사업 칸을 그립니다. 비운 칸은 null이고, 칸 순서가 곧 저장할 사업 순서입니다.
 * 예전에 3개를 저장한 검토는 칸을 늘려 모두 보여 줍니다.
 */
function toSlots(programs: ReviewProgram[], gap: number | null): (ReviewProgram | null)[] {
  if (programs.length >= slotCount) return programs
  const slots: (ReviewProgram | null)[] = [...programs]
  if (gap !== null) slots.splice(gap, 0, null)
  while (slots.length < slotCount) slots.push(null)
  return slots
}

export function useReviewEditorViewModel(id: number | null, account: string, resultRunId: number | null = null, initialFacts = '', initialProgram: InitialReviewProgram | null = null) {
  const useCase = appContainer.resolve('combinationReviewUseCase')
  const detailUseCase = appContainer.resolve('getSupportProgramDetailUseCase')
  const journal = appContainer.resolve('reviewRequestJournal')
  const navigate = useNavigate()
  const { perform, ...scope } = useReviewScope()
  const [review, setReview] = useState<CombinationReview | null>(null)
  // 새 검토만 미리 고른 공고를 사업 1로 둡니다. 내 상황(사업별 상태 · 관계)은 다른 공고처럼 모름에서 시작합니다.
  const [preselected] = useState(() => (id === null ? initialProgram : null))
  const [draft, setDraft] = useState<Required<ReviewDraft>>(() => ({
    title: '',
    programs: preselected ? [{ sourceCode: preselected.sourceCode, sourceProgramId: preselected.sourceProgramId, subProgramId: null, participation: unknownParticipation() }] : [],
    relation: unknownRelation(),
  }))
  /** 앞 칸을 비우고 뒤 칸만 남겼을 때 비운 칸의 위치입니다. 남은 공고가 앞 칸으로 당겨지지 않게 합니다. */
  const [gap, setGap] = useState<number | null>(null)
  const [programInfo, setProgramInfo] = useState<Record<string, ReviewProgramInfo>>({})
  const names = useMemo(() => Object.fromEntries(Object.entries(programInfo).map(([key, info]) => [key, programLabel(info)])), [programInfo])
  const [runs, setRuns] = useState<ReviewPage<RunSummary> | null>(null)
  const [run, setRun] = useState<ReviewRun | null>(null)
  const [facts, setFacts] = useState(initialFacts)
  const [pending, setPending] = useState<RunRequest | null>(null)
  const [journalReady, setJournalReady] = useState(false)
  const [notice, setNotice] = useState('')
  const [pollingPaused, setPollingPaused] = useState(false)
  const autoSelectedRunId = useRef<number | null>(null)
  const { setError, busy, error } = scope

  const load = useCallback(() => {
    if (!id) return
    void perform('load', async (signal) => {
      const saved = journal.read(account, id)
      const [detail, history] = await Promise.all([useCase.get(id, signal), useCase.runs(id, undefined, signal)])
      // 사업 칸의 배지 · 공고명 · 기관과 실행 결과의 공고 이름은 상세 조회로 채웁니다. 못 읽은 공고는 이유만 보입니다.
      const infos = Object.fromEntries(await Promise.all(detail.programs.map(async (program): Promise<[string, ReviewProgramInfo]> => {
        const key = reviewProgramKey(program)
        try {
          return [key, infoOf(await detailUseCase.execute(program, signal))]
        } catch {
          return [key, { status: 'failed' }]
        }
      })))
      return { saved, detail, history, infos }
    }, ({ saved, detail, history, infos }) => { setReview(detail); setDraft(inputOf(detail)); setGap(null); setProgramInfo(infos); setRuns(history); setPending(saved); setJournalReady(true) })
  }, [id, account, journal, useCase, detailUseCase, perform])
  useEffect(() => { load() }, [load])
  // 미리 고른 공고의 표시 정보는 상세 조회로 채웁니다. 조회만 하고 저장·분석은 보내지 않으며, 못 읽어도 선택은 그대로 둡니다.
  useEffect(() => {
    if (!preselected) return
    const controller = new AbortController()
    const key = reviewProgramKey(preselected)
    void detailUseCase.execute(preselected, controller.signal)
      .then(infoOf, (): ReviewProgramInfo => ({ status: 'failed' }))
      .then((info) => { if (!controller.signal.aborted) setProgramInfo((current) => ({ [key]: info, ...current })) })
    return () => controller.abort()
  }, [preselected, detailUseCase])
  /** 사업 칸입니다. 비운 칸은 null이고, 채운 칸의 순서가 저장할 사업 순서입니다. */
  const slots = toSlots(draft.programs, gap)
  const placeSlots = (next: (ReviewProgram | null)[]) => {
    const programs = next.filter((program): program is ReviewProgram => program !== null)
    setDraft({ ...draft, programs })
    setGap(programs.length < slotCount ? next.indexOf(null) : null)
  }
  /**
   * 칸에 공고를 둡니다. 같은 공고를 다시 고르면 그대로 두고, 다른 공고로 바꾸면 그 공고의 참여 상태는 모름에서 시작합니다.
   * 다른 칸에 이미 있는 공고는 두지 않습니다(같은 공고끼리는 비교할 수 없음).
   */
  const chooseSlot = (index: number, program: SelectableSupportProgram) => {
    const chosen: ReviewProgram = { sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null, participation: unknownParticipation() }
    const key = reviewProgramKey(chosen)
    if (slots.some((slot, slotIndex) => slotIndex !== index && slot !== null && reviewProgramKey(slot) === key)) return
    setProgramInfo((current) => ({ ...current, [key]: { status: 'ready', program } }))
    const existing = slots[index]
    if (existing && reviewProgramKey(existing) === key) return
    placeSlots(slots.map((slot, slotIndex) => slotIndex === index ? chosen : slot))
  }
  /** 칸을 비웁니다. 다른 칸의 공고는 제자리에 둡니다. */
  const clearSlot = (index: number) => placeSlots(slots.map((slot, slotIndex) => slotIndex === index ? null : slot))
  const history = useCallback((before?: number) => {
    if (id) void perform('history', (signal) => useCase.runs(id, before, signal), (value) => setRuns((old) => ({ ...value, items: before ? [...(old?.items ?? []), ...value.items] : value.items })))
  }, [id, perform, useCase])
  const acceptRun = useCallback((value: ReviewRun, select = true) => {
    if (select) autoSelectedRunId.current = value.id
    setRun((old) => old && isEarlierState(old, value) ? old : select || !old || old.id === value.id ? value : old)
    setRuns((old) => {
      const current = old?.items.find((item) => item.id === value.id)
      return { items: [current && isEarlierState(current, value) ? current : value, ...(old?.items ?? []).filter((item) => item.id !== value.id)].sort((a, b) => b.id - a.id), nextBeforeId: old?.nextBeforeId ?? null }
    })
    if (pending?.requestKey === value.requestKey && id) { journal.remove(account, id); setPending(null) }
  }, [pending, id, account, journal])
  const selectRun = useCallback((runId: number) => {
    if (!id) return
    void perform('run', (signal) => useCase.run(id, runId, signal), acceptRun).then((accepted) => setPollingPaused(!accepted))
  }, [id, perform, useCase, acceptRun])
  useEffect(() => {
    if (!resultRunId || autoSelectedRunId.current === resultRunId) return
    selectRun(resultRunId)
  }, [resultRunId, selectRun])
  const activeRunId = runs?.items.find((item) => item.status === 'QUEUED' || item.status === 'RUNNING')?.id
  useEffect(() => {
    if (!id || !activeRunId || pollingPaused) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const accepted = await perform('poll', (signal) => useCase.run(id, activeRunId, signal), (value) => {
        if (!stopped) acceptRun(value, false)
      })
      if (stopped) return
      if (accepted) timer = setTimeout(() => void poll(), 3000)
      else setPollingPaused(true)
    }
    timer = setTimeout(() => void poll(), 3000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [id, activeRunId, pollingPaused, perform, useCase, acceptRun])
  const dirty = review !== null && JSON.stringify(inputOf(draft)) !== JSON.stringify(inputOf(review))
  const rejectedRevision = error?.status === 409 && error.code === 'COMBINATION_REVIEW_REVISION_CONFLICT' && !error.runId
  const clearRejectedRequest = () => {
    if (!id || !pending || !rejectedRevision) return
    try { journal.remove(account, id); setPending(null); setNotice('버전 충돌로 생성되지 않은 요청을 정리했습니다. 화면을 새로고침한 뒤 직접 새 분석을 시작하세요.') }
    catch { setError({ message: '보관한 요청을 지우지 못했습니다. 브라우저 저장소 설정을 확인해 주세요.' }) }
  }
  /**
   * 저장된 입력 버전(current)으로 분석을 접수합니다. 응답을 잃은 요청은 같은 키 · 버전 · 추가 설명으로만 다시 보냅니다.
   * onAccepted는 서버가 접수한 실행을 받은 뒤 부릅니다(결과 화면에서 새 실행으로 이동할 때 씁니다).
   */
  const startRun = (current: CombinationReview, retry: boolean, additionalFacts: string, onAccepted?: (run: ReviewRun) => void) => {
    if (!id || !journalReady || busy.includes('analysis')) return
    if (!retry && (pending || runs?.items.some((item) => ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(item.status)) || !current.programs.every(supportsAutomaticReview))) return
    if (retry && !pending) return
    const request = retry ? pending! : { expectedRevision: current.inputRevision, requestKey: crypto.randomUUID(), additionalFacts }
    try {
      if (!retry && journal.read(account, id)) return
      journal.write(account, id, request)
    } catch { setError({ message: '요청 키를 안전하게 보관할 수 없어 분석을 시작하지 않았습니다. 브라우저 저장소 설정을 확인해 주세요.' }); return }
    setPending(request)
    void perform('analysis', (signal) => useCase.start(id, request, signal), (value) => {
      acceptRun(value)
      journal.remove(account, id); setPending(null); setPollingPaused(false)
      setNotice(['QUEUED', 'RUNNING'].includes(value.status) ? '분석 요청이 접수되었습니다. 상태는 자동으로 갱신되며, 다른 화면으로 이동해도 작업은 유지됩니다.' : '저장된 실행을 확인했습니다. 새 분석은 자동으로 시작하지 않습니다.')
      onAccepted?.(value)
    })
  }
  /** 저장된 입력 그대로 분석을 접수하거나(retry=false) 응답을 잃은 요청을 다시 확인합니다(retry=true). 저장하지 않은 입력이 있으면 새 분석은 보내지 않습니다. */
  const start = (retry: boolean) => {
    if (!review || (!retry && dirty)) return
    startRun(review, retry, facts)
  }
  // 입력을 저장한다. 새 검토는 이때 만들고(내 상황은 모름), 기존 검토는 바뀐 경우에만 입력 버전을 확인해 덮어쓴다.
  // 유료 분석은 여기서 시작하지 않는다 — [검토 실행] · [저장하고 다시 분석](saveAndStart)에서만 보낸다. next는 저장된 입력을 받는다.
  const saveInput = (next: (current: CombinationReview) => void) => {
    if (busy.includes('save') || busy.includes('load')) return
    let input: ReviewDraft
    try { input = validateReviewDraft(draft) } catch (e) { setError({ message: (e as Error).message }); return }
    if (!id) {
      void perform('save', (signal) => useCase.create(input, signal), (saved) => navigate(`${appPaths.combinationReviews}/${saved.id}?step=analysis`, { replace: true }))
      return
    }
    if (!review) return
    if (JSON.stringify(inputOf(input)) === JSON.stringify(inputOf(review))) { setError(null); next(review); return }
    // 확인하지 못한 분석 요청은 접수 당시 입력 버전을 쓰므로, 그 요청을 확인하기 전에는 입력을 바꾸지 않는다.
    if (pending) { setError({ message: '확인하지 못한 분석 요청이 있어 입력을 저장하지 않았습니다. 공고 분석 단계에서 요청을 먼저 확인해 주세요.' }); return }
    const saved: CombinationReview = { ...review, ...inputOf(input), inputRevision: review.inputRevision + 1 }
    void perform('save', (signal) => useCase.replace(id, review.inputRevision, input, signal), () => { setReview(saved); setDraft(inputOf(saved)); next(saved) })
  }
  /** 바뀐 입력이 있으면 저장(입력 버전 확인)한 뒤 그 버전으로 새 분석을 접수합니다. 저장이 실패하면 분석을 보내지 않고 편집 내용을 유지합니다. */
  const saveAndStart = (additionalFacts: string, onAccepted?: (run: ReviewRun) => void) =>
    saveInput((current) => startRun(current, false, additionalFacts, onAccepted))
  /** 새 분석을 지금 보낼 수 없는 이유입니다. 저장하지 않은 입력은 [검토 실행]이 먼저 저장하므로 이유가 아닙니다. */
  const startBlocked = runs?.items.some((item) => item.status === 'QUEUED' || item.status === 'RUNNING') ? '분석이 끝나면 다시 실행할 수 있어요'
    : runs?.items.some((item) => item.status === 'UNKNOWN') ? '완료 여부를 확인하지 못한 실행이 있어 새 분석을 막았어요'
      : draft.programs.length !== 2 ? '공고를 2개로 줄이면 실행할 수 있어요'
        : draft.programs.some((program) => !supportsAutomaticReview(program)) ? '자동 분석을 지원하지 않는 공고가 있어요' : null
  const download = (documentIndex: number) => {
    if (!id || !run) return
    const selectedRun = run
    void perform('download', (signal) => useCase.source(id, selectedRun.id, documentIndex, signal), (blob) => {
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = selectedRun.evidence?.documents[documentIndex]?.fileName ?? 'source'
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  return { ...scope, review, draft, setDraft, slots, programInfo, names, runs, run, facts, setFacts,
    pending, notice, dirty, pollingPaused, rejectedRevision, clearRejectedRequest, load, chooseSlot, clearSlot, saveInput, history, selectRun, start, saveAndStart, startBlocked, download }
}
