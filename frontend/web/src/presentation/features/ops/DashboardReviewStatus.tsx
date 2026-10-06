import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { getDashboardReviewStatus, OpsApiError } from '../../../data/ops/opsApi'
import type { DashboardReviewStatus as ReviewStatus } from '../../../data/ops/opsApi'

const qualityLabels = {
  PASS: '합격', FAIL: '불합격', NEEDS_REVIEW: '검토 필요', NOT_EVALUATED: '미판정',
  STALE: '재판정 필요', UNAVAILABLE: '확인 불가',
}
const qualityDescriptions = {
  PASS: '현재 자료·검토·정책에 유효한 판정입니다.',
  FAIL: '부적합 사유를 상세 평가에서 확인하세요.',
  NEEDS_REVIEW: '자료 또는 답변의 사람 검토가 필요합니다.',
  NOT_EVALUATED: '저장된 품질 판정이 없습니다.',
  STALE: '자료·검토·정책이 달라져 과거 판정을 그대로 사용할 수 없습니다.',
  UNAVAILABLE: '자료나 정책을 확인할 수 없어 판정의 유효성을 알 수 없습니다.',
}
const card = 'min-w-0 rounded-xl border border-line bg-white p-4 sm:p-5'
const link = 'mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-brand-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-brand-primary'

// 실행 또는 대시보드 새로고침 시 부모가 key를 바꿔 이전 승인 표시를 즉시 제거한다.
export function DashboardReviewStatus({ runId, onExpired }: { runId: string; onExpired: () => void }) {
  const [data, setData] = useState<ReviewStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const expiry = useRef(onExpired); expiry.current = onExpired
  useEffect(() => {
    const controller = new AbortController()
    setData(null); setFailed(false)
    getDashboardReviewStatus(runId, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result)
    }).catch((reason) => {
      if (controller.signal.aborted) return
      if (reason instanceof OpsApiError && [401, 403].includes(reason.status)) expiry.current()
      else setFailed(true)
    })
    return () => controller.abort()
  }, [runId, revision])
  const review = data?.review
  const baseline = data?.baseline
  const reviewed = review ? review.cases.suitable + review.cases.unsuitable + review.cases.deferred : 0
  const details = `/ops/evaluations/${runId}`
  return <section aria-label="사람 검토와 비교 기준">
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-base font-semibold text-ink">사람 검토와 비교 기준</h2>
      <p className="text-xs text-ink-muted">선택 조건의 최근 실측 · 자동 점수와 별도 확인</p>
    </div>
    {failed ? <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <p>검토 상태를 확인하지 못했습니다. 승인 여부나 비교 기준을 판단할 수 없습니다.</p>
      <button className={`${link} mr-5 mt-1`} onClick={() => setRevision((value) => value + 1)}>검토 상태 다시 확인</button>
      <Link className={`${link} mt-1`} to={details}>상세 평가 확인</Link>
    </div> : !review || !baseline ? <p role="status" className={`${card} text-sm text-ink-muted`}>현재 자료의 검토 기록과 비교 기준을 확인하고 있습니다.</p> : <>
      <div className="grid gap-3 xl:grid-cols-3">
        <article className={card}>
          <h3 className="text-sm font-medium text-ink-muted">사람 검토</h3>
          <p className="mt-3 text-2xl font-bold tabular-nums text-ink">{reviewed}<span className="ml-1 text-base font-medium text-ink-muted">/ {review.cases.total}건 검토</span></p>
          <p className="mt-2 text-sm text-ink">적합 {review.cases.suitable} · 부적합 {review.cases.unsuitable} · 보류 {review.cases.deferred}</p>
          <p className="mt-2 text-xs leading-5 text-ink-muted">미검토 {review.cases.unreviewed}건{review.cases.stale > 0 && ` · 자료 변경으로 재검토 ${review.cases.stale}건`}. 보류는 검토 기록이 있으나 판단을 마치지 않은 사례입니다.</p>
          <p className="mt-3 text-xs leading-5 text-ink">참조 자료 {review.reference_approved ? '승인 완료' : '승인 필요'}{review.approval !== 'not_required' && ` · 답변 전체 ${review.approval === 'approved' ? '승인 완료' : '승인 필요'}`}</p>
          {review.approval === 'not_required' && <p className="mt-1 text-xs leading-5 text-ink-muted">RAG은 검색·답변·인용을 모두 적합으로 검토해야 사례 적합으로 셉니다.</p>}
          <Link className={link} to={details}>{reviewed < review.cases.total || review.cases.deferred || review.cases.unsuitable || !review.reference_approved || review.approval === 'pending' ? '검토 이어가기 →' : '검토 기록 보기 →'}</Link>
        </article>
        <article className={card}>
          <h3 className="text-sm font-medium text-ink-muted">품질 판정</h3>
          <p className={`mt-3 text-2xl font-bold ${review.quality === 'PASS' ? 'text-brand-primary' : review.quality === 'FAIL' ? 'text-red-700' : 'text-ink'}`}>{qualityLabels[review.quality]}</p>
          <p className="mt-3 text-sm leading-6 text-ink-muted">{qualityDescriptions[review.quality]}</p>
          <Link className={link} to={details}>판정 근거 보기 →</Link>
        </article>
        <article className={card}>
          <h3 className="text-sm font-medium text-ink-muted">활성 비교 기준</h3>
          <p className={`mt-3 text-2xl font-bold ${baseline.status === 'active' ? 'text-brand-primary' : 'text-ink'}`}>{baseline.status === 'active' ? baseline.run_id === runId ? '이 실측이 기준' : '다른 실행이 기준' : baseline.status === 'none' ? '미지정' : baseline.status === 'needs_review' ? '기준 재검토 필요' : '기준 확인 불가'}</p>
          <p className="mt-3 text-sm leading-6 text-ink-muted">{baseline.status === 'active' ? '이 평가 자료에서 다음 비교에 사용할 수 있는 기준입니다. 추이 필터와는 별개입니다.' : baseline.status === 'none' ? '검토와 품질 판정을 마친 실행을 상세 평가에서 기준으로 지정할 수 있습니다.' : baseline.status === 'needs_review' ? '과거 지정 기록은 있으나 현재 검토·품질 조건을 충족하지 못합니다.' : '지정된 기준의 자료를 확인하지 못했거나 조회 중 기준이 변경됐습니다. 다시 확인하세요.'}</p>
          {baseline.run_id && <><p className="mt-2 text-xs text-ink-muted">실행 {baseline.run_id.slice(0, 8)} · 지정 버전 {baseline.version}</p><Link className={link} to={`/ops/evaluations/${baseline.run_id}`}>기준 실행 확인 →</Link></>}
        </article>
      </div>
      <p className="mt-2 text-xs text-ink-muted">검토 상태 조회: {new Date(data!.checked_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} (서울). 다른 화면에서 검토한 뒤 상단의 지표 새로고침을 누르세요.</p>
    </>}
  </section>
}
