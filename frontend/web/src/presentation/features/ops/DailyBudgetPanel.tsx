import type { DailyBudget } from '../../../data/ops/opsApi'

export function DailyBudgetPanel({ value }: { value: DailyBudget | undefined }) {
  return <section aria-label="일별 평가 예산" className="space-y-3 rounded-xl border border-sample-border p-4 text-sm">
    <h3 className="font-semibold">일별 평가 예산 · 서울 시간</h3>
    {!value ? <p>서버에서 일별 예산 정보를 제공하지 않습니다.</p> : <>
      <p>{value.period_start.slice(0, 10)} 00:00부터 다음 날 00:00까지 · Asia/Seoul</p>
      {value.state === 'disabled' ? <p>일별 제한 미적용 · 누적 한도는 계속 적용됩니다.</p> : <>
        {value.state === 'unknown' && <p role="alert" className="text-red-700">일별 사용량 미확인 · 신규 예약을 차단합니다. 누락·불일치 장부를 먼저 확인하세요.</p>}
        {value.state === 'exceeded' && <p role="alert" className="text-red-700">일별 한도 초과 · 신규 예약을 차단합니다.</p>}
        {value.state === 'enforced' && <p>일별 한도 적용 중 · 누적 한도도 함께 검사합니다.</p>}
        <div className="overflow-x-auto"><table className="w-full text-left">
          <caption className="sr-only">일별 한도와 오늘의 할당량 및 이월량</caption>
          <thead><tr><th scope="col">항목</th><th scope="col">일별 한도</th><th scope="col">오늘 접수 몫</th><th scope="col">전날 이전 이월</th><th scope="col">일별 잔여</th></tr></thead>
          <tbody>{([['calls', '호출'], ['input_tokens', '입력 토큰'], ['output_tokens', '출력 토큰']] as const).map(([key, label]) => <tr key={key}>
            <th scope="row">{label}</th>{[value.limits, value.current_day, value.carried, value.remaining].map((amount, index) => <td key={index}>{amount?.[key].toLocaleString('ko-KR') ?? '확인 불가'}</td>)}
          </tr>)}</tbody>
        </table></div>
        <p>접수 날짜 기준의 예약량입니다. 이전 날짜의 미확정 호출·미승인 예약·종료 전 반환 대기는 이월하며, 이미 확정된 이전 날짜 사용량은 누적 장부에 남습니다. 자정을 넘긴 예약은 새 호출을 승인하지 않습니다.</p>
      </>}
      {value.recent_changes.length > 0 && <details><summary className="cursor-pointer">일별 정책 변경 이력 · 최근 {value.recent_changes.length}건</summary>
        <p>CLI 변경자는 운영자가 입력한 식별자이며 로그인으로 인증한 신원은 아닙니다.</p>
        <ol className="space-y-2">{value.recent_changes.map((change) => <li key={change.request_id}>
          <p>{new Date(change.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} · {change.actor} · CLI</p>
          <p>{change.policy.enabled ? '적용' : '해제'} · 호출 {change.policy.limits.calls.toLocaleString()} / 입력 {change.policy.limits.input_tokens.toLocaleString()} / 출력 {change.policy.limits.output_tokens.toLocaleString()}</p>
          <p>사유: {change.reason}</p>
        </li>)}</ol>
      </details>}
    </>}
    <p className="text-xs text-sample-muted">일별 정책 변경은 운영 명령으로 기록합니다. 월별 한도·금액 한도와 정기 실행 활성화는 별도입니다.</p>
  </section>
}
