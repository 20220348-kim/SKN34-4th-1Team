import { useEffect, useState } from 'react'
import { appContainer } from '../../../../app/appContainer'
import { formatSavedApplicationAnswers, type ApplicationOnlineInputGuide as Guide } from '@govbiz/shared/domain/entities/ApplicationOnlineInputGuide'
import { applicationPreparationStyles as s } from './ApplicationPreparation.styles'

const labels = { READY: '준비 완료', NEEDS_REVIEW: '확인 필요', MISSING: '답변 필요', DIRECT_INPUT: '직접 처리 필요' }

export function ApplicationOnlineInputGuide({ preparationId, inputRevision }: { preparationId: number; inputRevision: number }) {
  const [guide, setGuide] = useState<Guide | null>(null)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setGuide(null); setError(''); setFeedback('')
    appContainer.resolve('applicationPreparationUseCase').onlineInputGuide(preparationId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        if (result.inputRevision !== inputRevision) throw new Error('저장 답변이 변경되었습니다. 신청 준비 화면을 새로고침해주세요.')
        setGuide(result)
      }).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '입력 안내를 불러오지 못했습니다.')
      })
    return () => controller.abort()
  }, [preparationId, inputRevision, retry])
  useEffect(() => {
    if (!feedback || feedback.startsWith('복사에 실패')) return
    const timer = setTimeout(() => setFeedback(''), 3000)
    return () => clearTimeout(timer)
  }, [feedback])
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setFeedback('복사됨') }
    catch { setFeedback('복사에 실패했습니다. 직접 선택하여 복사해주세요.') }
  }
  function download() {
    if (!guide) return
    const url = URL.createObjectURL(new Blob(['\uFEFF', formatSavedApplicationAnswers(guide)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = `application-answers-${preparationId}.txt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <section className={s.card} aria-labelledby="online-input-guide-title">
    <h2 className={s.cardTitle} id="online-input-guide-title">온라인 신청 입력 도우미</h2>
    <p className={s.muted}>저장된 확정 답변을 복사하거나 TXT로 내려받아 공식 신청 페이지에서 직접 입력해주세요. 자동 입력되지 않으며 최종 제출 전 입력 내용을 반드시 확인해주세요.</p>
    {guide && !guide.externalMappingVerified && <p className={s.notice}>외부 신청 폼의 입력 방식과 문항 위치는 아직 확인되지 않았습니다. 준비된 답변을 복사해 해당 문항에 직접 입력해주세요.</p>}
    {error && <div role="alert"><p>{error}</p><button className={s.button} onClick={() => setRetry((value) => value + 1)}>입력 안내 다시 불러오기</button></div>}
    {!guide && !error && <p role="status">입력 안내를 불러오는 중입니다.</p>}
    {feedback && <p role="status">{feedback}</p>}
    {guide && <>
      <p>준비된 답변 {guide.readyCount} / {guide.totalCount}</p>
      <div className="flex flex-wrap gap-3">
        <button className={s.button} disabled={!guide.savedAnswers.length} onClick={() => { void copy(formatSavedApplicationAnswers(guide)) }}>저장된 확정 답변 전체 복사</button>
        <button className={s.button} disabled={!guide.savedAnswers.length} onClick={download}>저장된 확정 답변 TXT 다운로드</button>
        {guide.officialApplicationUrl && <a className={s.officialLink} href={guide.officialApplicationUrl} target="_blank" rel="noopener noreferrer">공식 신청처 열기</a>}
      </div>
      <ul className="space-y-4">
        {guide.items.map((item) => {
          return <li key={item.fieldId} className="min-w-0 rounded-xl border border-slate-200 p-4">
            <div className="flex flex-wrap gap-2"><strong className="break-words">{item.label}</strong><span>{item.required ? '필수' : '선택'}</span><span>{labels[item.status]}</span></div>
            {item.answer && <p className="my-3 whitespace-pre-wrap break-words">{item.answer}</p>}
            <p className={s.muted}>{item.status === 'MISSING' ? '기존 답변 입력 영역에서 답변을 저장해주세요.' : item.status === 'NEEDS_REVIEW' ? '저장 답변이 공식 선택지와 일치하지 않습니다. 기존 답변 입력 영역에서 확인해주세요.' : item.status === 'DIRECT_INPUT' ? '외부 신청 화면에서 해당 문항을 직접 처리해주세요.' : '입력 형태 미확인: 외부 신청 화면의 해당 문항을 확인해 직접 붙여넣어주세요.'}</p>
            {item.options.length > 0 && <p className="break-words text-sm">공식 선택지: {item.options.join(', ')} (외부 선택 방식 미확인)</p>}
            {item.status === 'READY' && item.copyable && item.answer !== null && <button className={`${s.button} mt-3`} aria-label={`${item.label} 저장 답변 복사`} onClick={() => { void copy(item.answer!) }}>저장 답변 복사</button>}
          </li>
        })}
      </ul>
    </>}
  </section>
}
