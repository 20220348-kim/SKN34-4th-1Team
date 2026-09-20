import { useEffect, useState } from 'react'

import { appContainer } from '../../../app/appContainer'
import type { PartnerRecruitment, PartnerRecruitmentSummary } from '../../../domain/entities/PartnerRecruitment'
import type { PartnerRecruitmentPage, PartnerRecruitmentQuery } from '../../../domain/entities/PartnerRecruitmentQuery'
import type { BrowsePartnerRecruitmentsUseCase, GetPartnerRecruitmentDetailUseCase } from '../../../domain/usecases/PartnerRecruitmentUseCases'

export type RecruitmentLoadState<Value> =
  | { phase: 'loading'; value: Value | null }
  | { phase: 'ready'; value: Value }
  | { phase: 'failed'; value: Value | null }

const REQUEST_TIMEOUT_MS = 10_000

/**
 * 공개·내부 파트너 모집 목록이 함께 쓰는 조회 훅입니다. 조건이 바뀌면 이전 요청을 취소하고 다시 읽으며,
 * 실패하면 마지막 결과를 유지한 채 실패로 표시합니다. 특정 페이지의 ViewModel이 아니므로 shared에 둡니다.
 */
export function usePartnerRecruitmentBrowse(
  query: PartnerRecruitmentQuery,
  useCase: Pick<BrowsePartnerRecruitmentsUseCase, 'execute'> = appContainer.resolve('browsePartnerRecruitmentsUseCase'),
) {
  const key = JSON.stringify(query)
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<RecruitmentLoadState<PartnerRecruitmentPage<PartnerRecruitmentSummary>> & { key: string }>({
    key, phase: 'loading', value: null,
  })

  useEffect(() => {
    const controller = new AbortController()
    let current = true
    setState((previous) => ({ key, phase: 'loading', value: previous.value }))
    const timer = setTimeout(() => {
      if (!current) return
      controller.abort()
      setState((previous) => ({ ...previous, key, phase: 'failed' }))
    }, REQUEST_TIMEOUT_MS)
    void Promise.resolve().then(() => useCase.execute(JSON.parse(key) as PartnerRecruitmentQuery, controller.signal))
      .then((page) => { if (current && !controller.signal.aborted) setState({ key, phase: 'ready', value: page }) })
      .catch(() => { if (current && !controller.signal.aborted) setState((previous) => ({ ...previous, key, phase: 'failed' })) })
      .finally(() => clearTimeout(timer))
    return () => { current = false; clearTimeout(timer); controller.abort() }
  }, [key, version, useCase])

  const phase = state.key === key ? state.phase : 'loading'
  return {
    phase,
    page: state.value,
    retry: () => setVersion((value) => value + 1),
  }
}

/** 공개·내부 모집글 상세가 함께 쓰는 조회 훅입니다. 없는 글(null)과 실패를 구분합니다. */
export function usePartnerRecruitmentDetail(
  id: number | null,
  useCase: Pick<GetPartnerRecruitmentDetailUseCase, 'execute'> = appContainer.resolve('getPartnerRecruitmentDetailUseCase'),
) {
  const [state, setState] = useState<{ id: number | null; phase: 'loading' | 'ready' | 'missing' | 'failed'; recruitment: PartnerRecruitment | null }>({
    id, phase: id === null ? 'missing' : 'loading', recruitment: null,
  })

  useEffect(() => {
    if (id === null) {
      setState({ id, phase: 'missing', recruitment: null })
      return
    }
    const controller = new AbortController()
    let current = true
    setState({ id, phase: 'loading', recruitment: null })
    void Promise.resolve().then(() => useCase.execute(id, controller.signal))
      .then((recruitment) => {
        if (!current || controller.signal.aborted) return
        setState({ id, phase: recruitment === null ? 'missing' : 'ready', recruitment })
      })
      .catch(() => { if (current && !controller.signal.aborted) setState({ id, phase: 'failed', recruitment: null }) })
    return () => { current = false; controller.abort() }
  }, [id, useCase])

  return state.id === id ? state : { id, phase: 'loading' as const, recruitment: null }
}

/** `?recruitmentId=`가 하나뿐이고 양의 정수일 때만 상세를 찾습니다. 그 밖에는 다른 글로 대체하지 않습니다. */
export function readRecruitmentId(values: string[]): number | null {
  if (values.length !== 1 || !/^\d+$/.test(values[0]!)) return null
  const id = Number(values[0])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
