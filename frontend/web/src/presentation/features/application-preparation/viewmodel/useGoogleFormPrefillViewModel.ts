import { useCallback, useEffect, useMemo, useState } from 'react'
import { appContainer } from '../../../../app/appContainer'
import { useAppSelector } from '../../../../app/hooks'
import {
  buildGoogleFormPrefillUrl,
  countGoogleFormAnswers,
  suggestGoogleFormAnswers,
  type ApplicationGoogleForm,
  type ApplicationGoogleFormAnswer,
  type ApplicationGoogleFormAnswers,
} from '@govbiz/shared/domain/entities/ApplicationGoogleForm'
import { selectCurrentAccount } from '../../../shared/auth/state/authSlice'

export type GoogleFormLoad =
  | { status: 'loading' }
  | { status: 'ready'; form: ApplicationGoogleForm }
  | { status: 'failed'; error: Error }

const empty: ApplicationGoogleFormAnswer = { values: [], other: null }

/**
 * 구글 설문 미리 채우기 상태입니다. 설문 문항과 기업 정보를 함께 읽어 채울 수 있는 칸을 먼저 채우고, 사용자가 고친 답으로
 * 미리 채운 설문 주소를 바로 만듭니다. 답은 서버에 보내지 않고 화면을 떠나면 사라집니다(AI 호출 없음).
 */
export function useGoogleFormPrefillViewModel(sourceCode: string, sourceProgramId: string) {
  const useCase = appContainer.resolve('applicationPreparationUseCase')
  const companyUseCase = appContainer.resolve('getMyCompanyUseCase')
  const email = useAppSelector(selectCurrentAccount)?.email ?? null
  const [load, setLoad] = useState<GoogleFormLoad>({ status: 'loading' })
  const [answers, setAnswers] = useState<ApplicationGoogleFormAnswers>({})
  /** 기업 정보로 채운 문항입니다. 사용자가 그 칸을 고치면 빠집니다. */
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(new Set())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    // 기업 정보를 못 읽어도 설문은 보여 주고 채울 칸만 줄입니다.
    void Promise.all([
      useCase.googleForm(sourceCode, sourceProgramId, controller.signal),
      companyUseCase.execute(controller.signal).catch(() => null),
    ]).then(([form, company]) => {
      if (controller.signal.aborted) return
      const suggestions = suggestGoogleFormAnswers(form, { email, company })
      setAnswers(suggestions)
      setSuggested(new Set(Object.keys(suggestions)))
      setLoad({ status: 'ready', form })
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setLoad({ status: 'failed', error: caught instanceof Error ? caught : new Error('구글 설문을 불러오지 못했어요.') })
    })
    return () => controller.abort()
  }, [attempt, companyUseCase, email, sourceCode, sourceProgramId, useCase])

  const update = useCallback((entryId: string, change: (answer: ApplicationGoogleFormAnswer) => ApplicationGoogleFormAnswer) => {
    setAnswers((current) => ({ ...current, [entryId]: change(current[entryId] ?? empty) }))
    setSuggested((current) => {
      if (!current.has(entryId)) return current
      const next = new Set(current)
      next.delete(entryId)
      return next
    })
  }, [])

  const setText = useCallback((entryId: string, text: string) => update(entryId, () => ({ values: [text], other: null })), [update])
  /** 객관식·드롭다운은 하나만 고릅니다. 빈 값은 선택 해제입니다. */
  const choose = useCallback((entryId: string, option: string) => update(entryId, () => ({ values: option ? [option] : [], other: null })), [update])
  const toggle = useCallback((entryId: string, option: string) => update(entryId, (answer) => ({
    ...answer, values: answer.values.includes(option) ? answer.values.filter((value) => value !== option) : [...answer.values, option],
  })), [update])
  /** "기타"를 고르거나 글을 고칩니다. 객관식에서 기타를 고르면 다른 선택은 풀립니다. */
  const chooseOther = useCallback((entryId: string, single: boolean, text = '') => update(entryId, (answer) => ({ values: single ? [] : answer.values, other: text })), [update])
  const clearOther = useCallback((entryId: string) => update(entryId, (answer) => ({ ...answer, other: null })), [update])

  const form = load.status === 'ready' ? load.form : null
  const prefillUrl = useMemo(() => form ? buildGoogleFormPrefillUrl(form, answers) : null, [answers, form])
  const filledCount = useMemo(() => form ? countGoogleFormAnswers(form, answers) : 0, [answers, form])
  const fillableCount = form ? form.questions.filter((question) => question.entryId).length : 0

  return {
    load, answers, suggested, prefillUrl, filledCount, fillableCount,
    setText, choose, toggle, chooseOther, clearOther,
    retry: () => setAttempt((value) => value + 1),
  }
}
