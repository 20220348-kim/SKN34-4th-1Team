import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import { appPaths } from '../../../shared/routes/appPaths'
import { reviewProgramKey, supportsAutomaticReview, unknownParticipation, validateReviewDraft, type CombinationReview, type ReviewDraft, type ReviewPage, type ReviewRun, type RunRequest, type RunSummary } from '../../../../domain/entities/CombinationReview'
import type { SupportProgram } from '../../../../domain/entities/SupportProgram'
import type { SupportProgramCatalog, SupportProgramCatalogFilters } from '../../../../domain/entities/SupportProgramCatalog'
import { useReviewScope } from './useReviewScope'
import { useSavedSupportProgramChoices } from '../../../shared/support-program/useSavedSupportProgramChoices'
import { defaultProgramSelectionFilters } from '../../../shared/support-program/catalogSearchParams'

// 자동 조회보다 늦게 도착한 과거 응답이 완료 상태를 대기/분석 중으로 되돌리지 않게 한다.
function isEarlierState(current: RunSummary, next: RunSummary) {
  return current.id === next.id && (
    (current.status === 'RUNNING' && next.status === 'QUEUED') ||
    (!['QUEUED', 'RUNNING'].includes(current.status) && ['QUEUED', 'RUNNING'].includes(next.status))
  )
}

export function useReviewEditorViewModel(id: number | null, account: string, autoStart = false, loadSavedPrograms = false, resultRunId: number | null = null) {
  const useCase = appContainer.resolve('combinationReviewUseCase')
  const catalogUseCase = appContainer.resolve('browseSupportProgramsUseCase')
  const detailUseCase = appContainer.resolve('getSupportProgramDetailUseCase')
  const journal = appContainer.resolve('reviewRequestJournal')
  const navigate = useNavigate()
  const savedProgramChoices = useSavedSupportProgramChoices(loadSavedPrograms)
  const { perform, ...scope } = useReviewScope()
  const [review, setReview] = useState<CombinationReview | null>(null)
  const [draft, setDraft] = useState<ReviewDraft>({ title: '', programs: [] })
  const [catalog, setCatalog] = useState<SupportProgramCatalog | null>(null)
  const [catalogFilters, setCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [appliedCatalogFilters, setAppliedCatalogFilters] = useState(defaultProgramSelectionFilters)
  const [names, setNames] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<ReviewPage<RunSummary> | null>(null)
  const [run, setRun] = useState<ReviewRun | null>(null)
  const [facts, setFacts] = useState('')
  const [pending, setPending] = useState<RunRequest | null>(null)
  const [journalReady, setJournalReady] = useState(false)
  const [notice, setNotice] = useState('')
  const [pollingPaused, setPollingPaused] = useState(false)
  const autoStartAttempted = useRef(false)
  const autoSelectedRunId = useRef<number | null>(null)
  const { setError, busy, error } = scope

  const load = useCallback(() => {
    if (!id) return
    void perform('load', async (signal) => {
      const saved = journal.read(account, id)
      const [detail, history] = await Promise.all([useCase.get(id, signal), useCase.runs(id, undefined, signal)])
      const labels = Object.fromEntries(await Promise.all(detail.programs.map(async (program) => {
        const key = reviewProgramKey(program)
        try {
          const found = await detailUseCase.execute(program, signal)
          return [key, found ? `${found.title} · ${found.organization}` : '공고 정보를 찾을 수 없음']
        } catch {
          return [key, '공고 정보를 불러오지 못함']
        }
      })))
      return { saved, detail, history, labels }
    }, ({ saved, detail, history, labels }) => { setReview(detail); setDraft({ title: detail.title, programs: detail.programs }); setNames(labels); setRuns(history); setPending(saved); setJournalReady(true) })
  }, [id, account, journal, useCase, detailUseCase, perform])
  useEffect(() => { load() }, [load])
  const search = (page = 1, filters: SupportProgramCatalogFilters = catalogFilters) => {
    if (busy.includes('catalog')) return
    const query = { ...filters, keyword: filters.keyword.trim(), page }
    setAppliedCatalogFilters(query)
    setCatalog(null)
    return perform('catalog', (signal) => catalogUseCase.execute(query, signal), setCatalog)
  }
  const toggle = (program: SupportProgram) => {
    const selected = { sourceCode: program.sourceCode, sourceProgramId: program.id, subProgramId: null, participation: unknownParticipation() }
    const selectedIndex = draft.programs.findIndex((p) => reviewProgramKey(p) === reviewProgramKey(selected))
    if (selectedIndex >= 0) {
      setDraft({ ...draft, programs: draft.programs.filter((_, index) => index !== selectedIndex) })
      return
    }
    if (draft.programs.length >= 2) return
    setDraft({ ...draft, programs: [...draft.programs, selected] }); setNames({ ...names, [reviewProgramKey(selected)]: `${program.title} · ${program.organization}` })
  }
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
  const dirty = review !== null && JSON.stringify(draft) !== JSON.stringify({ title: review.title, programs: review.programs })
  const rejectedRevision = error?.status === 409 && error.code === 'COMBINATION_REVIEW_REVISION_CONFLICT' && !error.runId
  const clearRejectedRequest = () => {
    if (!id || !pending || !rejectedRevision) return
    try { journal.remove(account, id); setPending(null); setNotice('버전 충돌로 생성되지 않은 요청을 정리했습니다. 화면을 새로고침한 뒤 직접 새 분석을 시작하세요.') }
    catch { setError({ message: '보관한 요청을 지우지 못했습니다. 브라우저 저장소 설정을 확인해 주세요.' }) }
  }
  const start = useCallback((retry: boolean) => {
    if (!id || !review || !journalReady || busy.includes('analysis')) return
    if (!retry && (pending || dirty || runs?.items.some((item) => ['QUEUED', 'RUNNING', 'UNKNOWN'].includes(item.status)) || !review.programs.every(supportsAutomaticReview))) return
    if (retry && !pending) return
    const request = retry ? pending! : { expectedRevision: review.inputRevision, requestKey: crypto.randomUUID(), additionalFacts: facts }
    try {
      if (!retry && journal.read(account, id)) return
      journal.write(account, id, request)
    } catch { setError({ message: '요청 키를 안전하게 보관할 수 없어 분석을 시작하지 않았습니다. 브라우저 저장소 설정을 확인해 주세요.' }); return }
    setPending(request)
    void perform('analysis', (signal) => useCase.start(id, request, signal), (value) => {
      acceptRun(value)
      journal.remove(account, id); setPending(null); setPollingPaused(false)
      setNotice(['QUEUED', 'RUNNING'].includes(value.status) ? '분석 요청이 접수되었습니다. 상태는 자동으로 갱신되며, 다른 화면으로 이동해도 작업은 유지됩니다.' : '저장된 실행을 확인했습니다. 새 분석은 자동으로 시작하지 않습니다.')
    })
  }, [id, review, journalReady, busy, pending, dirty, runs, facts, journal, account, setError, perform, useCase, acceptRun])
  const saveAndStart = (showAnalysis: () => void) => {
    if (pending || busy.includes('save') || busy.includes('analysis')) return
    if (id) {
      try { if (journal.read(account, id)) return }
      catch { setError({ message: '요청 상태를 안전하게 확인할 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.' }); return }
    }
    let input: ReviewDraft
    try { input = validateReviewDraft(draft) } catch (e) { setError({ message: (e as Error).message }); return }
    if (!input.programs.every(supportsAutomaticReview)) return
    const launch = (saved: CombinationReview) => {
      const request = { expectedRevision: saved.inputRevision, requestKey: crypto.randomUUID(), additionalFacts: facts }
      try { journal.write(account, saved.id, request) }
      catch { setError({ message: '요청 키를 안전하게 보관할 수 없어 분석을 시작하지 않았습니다. 브라우저 저장소 설정을 확인해 주세요.' }); return }
      setPending(request)
      setRun(null)
      showAnalysis()
      void perform('analysis', (signal) => useCase.start(saved.id, request, signal), (value) => {
        acceptRun(value)
        journal.remove(account, saved.id); setPending(null); setPollingPaused(false)
        setNotice(['QUEUED', 'RUNNING'].includes(value.status) ? '분석 요청이 접수되었습니다. 상태는 자동으로 갱신되며, 완료되면 결과가 표시됩니다.' : '분석이 완료되어 저장된 결과를 표시합니다.')
      })
    }
    if (id && review) {
      const unchanged = JSON.stringify(input) === JSON.stringify({ title: review.title, programs: review.programs })
      if (unchanged) { launch(review); return }
      const saved = { ...review, ...input, inputRevision: review.inputRevision + 1 }
      void perform('save', (signal) => useCase.replace(id, review.inputRevision, input, signal), () => {
        setReview(saved); setDraft(input); setNotice('입력을 저장하고 분석을 시작합니다.'); launch(saved)
      })
      return
    }
    void perform('save', (signal) => useCase.create(input, signal), (saved) => {
      const request = { expectedRevision: saved.inputRevision, requestKey: crypto.randomUUID(), additionalFacts: facts }
      try { journal.write(account, saved.id, request) }
      catch { navigate(`${appPaths.combinationReviews}/${saved.id}?step=analysis`, { replace: true }); return }
      navigate(`${appPaths.combinationReviews}/${saved.id}?step=analysis&start=1`, { replace: true })
    })
  }
  useEffect(() => {
    if (!autoStart || autoStartAttempted.current || !id || !review || !journalReady || !pending) return
    autoStartAttempted.current = true
    navigate(`${appPaths.combinationReviews}/${id}?step=analysis`, { replace: true })
    start(true)
  }, [autoStart, id, review, journalReady, pending, navigate, start])
  const download = (documentIndex: number) => {
    if (!id || !run) return
    const selectedRun = run
    void perform('download', (signal) => useCase.source(id, selectedRun.id, documentIndex, signal), (blob) => {
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = selectedRun.evidence?.documents[documentIndex]?.fileName ?? 'source'
      anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }
  return { ...scope, review, draft, setDraft, catalog, savedProgramChoices, catalogFilters, setCatalogFilters, appliedCatalogFilters, names, runs, run, facts, setFacts,
    pending, notice, dirty, pollingPaused, rejectedRevision, clearRejectedRequest, load, search, toggle, saveAndStart, history, selectRun, start, download }
}
