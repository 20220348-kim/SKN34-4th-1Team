import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { ApplicationPreparation, ApplicationFormSection, NewApplicationPreparationFact } from '@govbiz/shared/domain/entities/ApplicationPreparation'
import { ApplicationPreparationError } from '@govbiz/shared/domain/errors/ApplicationPreparationError'
import { applicationPreparationUseCase } from '../api/applicationPreparation'
import { useAuth } from '../auth/session'

export const applicationAnswerKey = (section: string, field: string) => `${section}:${field}`
export function applicationFactValue(section: ApplicationFormSection, field: string) {
  const fact = section.facts.find(candidate => candidate.fieldKey === field)
  return fact?.status === 'UNKNOWN' ? '미정' : fact?.value ?? ''
}
function buildFacts(section: ApplicationFormSection, pending: Record<string, string>): NewApplicationPreparationFact[] {
  return section.fields.flatMap(field => {
    const key = applicationAnswerKey(section.key, field.key)
    const saved = section.facts.find(fact => fact.fieldKey === field.key)
    if (!Object.hasOwn(pending, key)) return saved ? [{ fieldKey: saved.fieldKey, status: saved.status, value: saved.value, sourceText: saved.sourceText }] : []
    const value = pending[key].trim()
    if (!value) return []
    if (Array.from(value).length > 2000) throw new Error(`${field.label}: 답변은 2,000자 이내로 입력해 주세요.`)
    if (value !== '미정' && field.options?.length && !field.options.includes(value)) throw new Error(`${field.label}: 공식 선택지 중에서 골라 주세요.`)
    return [{ fieldKey: field.key, status: value === '미정' ? 'UNKNOWN' as const : 'PROVIDED' as const,
      value: value === '미정' ? null : value, sourceText: `${field.label}: ${value}` }]
  })
}
const sameFacts = (section: ApplicationFormSection, facts: NewApplicationPreparationFact[]) => section.facts.length === facts.length &&
  facts.every(fact => section.facts.some(saved => saved.fieldKey === fact.fieldKey && saved.status === fact.status && saved.value === fact.value))

/** 계정별 한 작성 화면의 입력과 직렬 저장을 소유한다. 실패/충돌 시 입력을 버리지 않는다. */
export function useApplicationPreparationEditor(id: number, token: string) {
  const { invalidateSession } = useAuth()
  const useCase = useMemo(() => applicationPreparationUseCase(token), [token])
  const [preparation, setPreparation] = useState<ApplicationPreparation | null>(null)
  const current = useRef<ApplicationPreparation | null>(null)
  const [pending, setPending] = useState<Record<string, string>>({})
  const edits = useRef<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const conflictRef = useRef(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [revision, setRevision] = useState(0)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const save = useRef<Promise<boolean> | null>(null)
  const saveController = useRef<AbortController | null>(null)
  const loadController = useRef<AbortController | null>(null)
  const report = useCallback((cause: unknown) => {
    if (cause instanceof ApplicationPreparationError && cause.status === 401) void invalidateSession().catch(() => undefined)
    return cause instanceof Error ? cause.message : '신청문서를 확인하지 못했어요.'
  }, [invalidateSession])
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(timer.current ?? undefined); saveController.current?.abort(); loadController.current?.abort() }
  }, [])
  useFocusEffect(useCallback(() => {
    const controller = new AbortController(); loadController.current = controller
    setLoading(true); setError(null)
    void useCase.get(id, controller.signal).then(result => {
      if (controller.signal.aborted) return
      // 저장과 병행한 조회에서 이전 입력 버전으로 되돌리지 않는다.
      if (!current.current || result.inputRevision >= current.current.inputRevision) { current.current = result; setPreparation(result) }
    }).catch(cause => { if (!controller.signal.aborted) setError(report(cause)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [id, useCase, report, revision]))

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current ?? undefined)
    while (save.current) { await save.current; if (!mounted.current) return false }
    if (!current.current || conflictRef.current) return false
    if (!Object.keys(edits.current).length) return true
    const controller = new AbortController(); saveController.current = controller
    setSaving(true); setSaveError(null)
    const task = (async () => {
      while (Object.keys(edits.current).length && mounted.current && !controller.signal.aborted) {
        const snapshot = { ...edits.current }, detail = current.current!
        const section = detail.form.sections.find(candidate => Object.keys(snapshot).some(key => key.startsWith(`${candidate.key}:`)))
        if (!section) throw new Error('작성 문항이 바뀌었어요. 입력을 보관한 뒤 양식을 다시 확인해 주세요.')
        const facts = buildFacts(section, snapshot)
        const result = sameFacts(section, facts) ? detail : await useCase.replaceInputs(id, section.key, { expectedRevision: detail.inputRevision, facts }, controller.signal)
        if (controller.signal.aborted || !mounted.current) return false
        current.current = result; setPreparation(result)
        for (const field of section.fields) {
          const key = applicationAnswerKey(section.key, field.key)
          if (Object.hasOwn(snapshot, key) && edits.current[key] === snapshot[key]) delete edits.current[key]
        }
        setPending({ ...edits.current }); setSavedAt(Date.now())
      }
      return !Object.keys(edits.current).length
    })().catch(async cause => {
      if (controller.signal.aborted || !mounted.current) return false
      setSaveError(report(cause))
      if (cause instanceof ApplicationPreparationError && cause.code === 'APPLICATION_PREPARATION_REVISION_CONFLICT') {
        conflictRef.current = true; setConflict(true)
        try {
          const latest = await useCase.get(id, controller.signal)
          if (!controller.signal.aborted && mounted.current) { current.current = latest; setPreparation(latest) }
        } catch (readError) { if (!controller.signal.aborted) setSaveError(report(readError)) }
      }
      return false
    }).finally(() => {
      if (save.current === task) save.current = null
      if (saveController.current === controller) saveController.current = null
      if (mounted.current && !controller.signal.aborted) setSaving(false)
    })
    save.current = task
    return task
  }, [id, useCase, report])
  const change = useCallback((key: string, value: string) => {
    edits.current[key] = value
    setPending({ ...edits.current }); if (!conflictRef.current) setSaveError(null)
    clearTimeout(timer.current ?? undefined)
    if (!conflictRef.current) timer.current = setTimeout(() => { void flush() }, 2000)
  }, [flush])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', value => { if (value !== 'active') void flush() })
    return () => subscription.remove()
  }, [flush])
  const resolveConflict = async (useMine: boolean) => {
    if (!useMine) { edits.current = {}; setPending({}); setSaveError(null) }
    conflictRef.current = false; setConflict(false)
    if (useMine) return flush()
    return true
  }
  return { preparation, pending, loading, error, saving, saveError, conflict, savedAt, flush, change, resolveConflict,
    retry: () => setRevision(value => value + 1), latest: () => current.current,
    value(section: ApplicationFormSection, field: string) { const key = applicationAnswerKey(section.key, field); return Object.hasOwn(pending, key) ? pending[key] : applicationFactValue(section, field) },
  }
}
