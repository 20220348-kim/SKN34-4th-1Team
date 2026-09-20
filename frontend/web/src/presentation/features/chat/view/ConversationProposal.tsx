import { Fragment } from 'react'

import type { ChatConversationProposal } from '../viewmodel/chatConversationProposal'
import { chatPageStyles } from './ChatPage.styles'

export function ConversationProposal({ proposal, onConfirm, onCancel }: {
  proposal: ChatConversationProposal
  onConfirm: () => void
  onCancel: () => void
}) {
  const ready = proposal.kind === 'ready'
  const canConfirm = ready && proposal.canConfirm
  return (
    <section className={chatPageStyles.proposalPanel} aria-label={ready ? '조건 변경 제안' : '조건 추가 확인'}>
      <div className={chatPageStyles.proposalHeader}>
        <span className={chatPageStyles.proposalEyebrow}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
          </svg>
          {ready ? '이렇게 찾아볼게요' : '조금만 더 알려주세요'}
        </span>
        {ready ? <span className={chatPageStyles.proposalScope}>{proposal.acceptingOnly ? '접수 중만' : '전체 접수 상태'}</span> : null}
      </div>
      <h2 className={`${chatPageStyles.proposalTitle} ${ready ? chatPageStyles.proposalQueryTitle : ''}`}>
        {ready ? proposal.query : proposal.question}
      </h2>
      {ready ? <p className={chatPageStyles.proposalDescription}>
        {proposal.acceptingOnly ? '접수 중인 공고에서 관련 지원사업을 찾아볼게요.' : '예정·마감·상태 미확인 공고까지 함께 찾아볼게요.'}
      </p> : null}
      {ready && proposal.changes.length > 0 ? (
        <ul className={chatPageStyles.proposalChanges} aria-label="변경할 조건">
          {proposal.changes.map((row) => <li key={row.label} className={chatPageStyles.proposalChange}
            title={row.after === null ? `${row.label} 해제` : `${row.label}: ${row.after}`}>
            {row.after === null ? `${row.label} 해제` : `${row.label}: ${row.after}`}
          </li>)}
        </ul>
      ) : null}
      {ready && proposal.hasRetainedConditions ? <p className={chatPageStyles.proposalHint}>나머지 조건은 유지됩니다.</p> : null}
      {!ready ? <p className={chatPageStyles.proposalHint}>답변을 입력해 주세요. 아직 검색하지 않았어요.</p> : null}
      {ready ? <details className={chatPageStyles.proposalDetails}>
        <summary className={chatPageStyles.proposalDetailsSummary}>검색 조건 자세히</summary>
        <dl className={chatPageStyles.proposalDetailsList}>
          <dt className={chatPageStyles.proposalDetailsLabel}>검색어</dt>
          <dd className={chatPageStyles.proposalDetailsValue}>{proposal.query}</dd>
          <dt className={chatPageStyles.proposalDetailsLabel}>접수 상태</dt>
          <dd className={chatPageStyles.proposalDetailsValue}>
            {proposal.acceptingOnly ? '접수 중만' : '전체 (접수 중·예정·마감·상태 미확인)'}
          </dd>
          {proposal.appliedConditions.map((condition) => <Fragment key={condition.label}>
            <dt className={chatPageStyles.proposalDetailsLabel}>{condition.label}</dt>
            <dd className={chatPageStyles.proposalDetailsValue}>{condition.value}</dd>
          </Fragment>)}
        </dl>
        <p className={chatPageStyles.proposalHint}>아직 검색하지 않았어요. 바꾸고 싶은 조건은 새 메시지로 알려주세요.</p>
      </details> : null}
      <div className={chatPageStyles.conditionsActions}>
        {ready ? <button type="button" className={chatPageStyles.conditionsButton} disabled={!canConfirm}
          onClick={onConfirm}>이 조건으로 검색 <span aria-hidden="true">→</span></button> : null}
        <button type="button" className={chatPageStyles.proposalCancelButton} onClick={onCancel}>제안 취소</button>
      </div>
      {ready && !canConfirm ? <p className={chatPageStyles.conditionsHint}>
        {proposal.hasUnsentMessage
          ? '기존 조건은 유지됩니다. 작성 중인 메시지를 전송해 조건을 변경하거나, 입력을 비우고 이 조건으로 검색해 주세요.'
          : '공고 검색 준비가 완료되면 확인한 조건으로 검색할 수 있습니다.'}
      </p> : null}
    </section>
  )
}
