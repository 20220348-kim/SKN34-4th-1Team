import { useCallback, useEffect, useRef, useState } from 'react'
import { appContainer } from '../../../../app/appContainer'
import type {
  ApplicationPreparation,
  ApplicationFormSection,
  NewApplicationPreparationFact,
} from '../../../../domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '../../../../domain/errors/ApplicationPreparationError'

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

/** 답변 입력(25) 화면의 상태입니다. 저장된 신청 준비 건을 불러오고 답변을 항목 단위로 자동 저장합니다. */
export function useApplicationPreparationEditorViewModel(id: number) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const [documentCount, setDocumentCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const loadSequence = useRef(0)

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

  const load = useCallback(() => {
    loadController.current?.abort()
    const controller = new AbortController()
    const sequence = ++loadSequence.current
    loadController.current = controller
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
    preparation,
    documentCount,
    loading,
    error,
    load,
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
