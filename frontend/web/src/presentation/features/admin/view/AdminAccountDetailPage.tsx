
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { useAdminAccountDetailViewModel } from '../viewmodel/useAdminAccountDetailViewModel'
import { adminAccountsPageStyles as styles } from './AdminAccountsPage.styles'

type DetailViewModel = ReturnType<typeof useAdminAccountDetailViewModel>

/** 관리자 계정 상세입니다. 계정·기업·활동·조치 기록을 보여 주고, 정지·정지 해제·강제 로그아웃은 사유를 받아 처리합니다. */
export function AdminAccountDetailPage() {
  const vm = useAdminAccountDetailViewModel()

  return (
    <>
      {/* 파트너 모집글 상세처럼 "계정 관리 > 계정 상세" 이동 경로로 목록에 돌아갑니다. */}
      <WorkspacePageHeader
        parent={{ to: vm.listPath, label: '계정 관리' }}
        title="계정 상세"
      />

      <div className={workspacePageStyles.content}>
        {vm.notice ? (
          <p className={styles.notice} role="status">
            <span>{vm.notice}</span>
            <button className={workspacePageStyles.quietLink} type="button" onClick={vm.dismissNotice}>닫기</button>
          </p>
        ) : null}

        {vm.phase === 'missing' ? (
          <p className={workspacePageStyles.emptyNote}>계정을 찾을 수 없습니다. 삭제됐거나 주소가 잘못되었습니다.</p>
        ) : vm.phase === 'failed' ? (
          <p className={workspacePageStyles.emptyNote}>
            계정을 불러오지 못했습니다.{' '}
            <button className={workspacePageStyles.quietLink} type="button" onClick={vm.retry}>다시 시도</button>
          </p>
        ) : vm.account === null ? (
          <p className={workspacePageStyles.emptyNote}>계정을 불러오는 중입니다.</p>
        ) : (
          <div className={styles.detailGrid}>
            <section className={workspacePageStyles.card} aria-label="계정 정보">
              <div className={styles.accountHeading}>
                <h2 className={styles.accountEmail}>{vm.account.email}</h2>
                <span className={workspaceTagClassName(vm.account.isSuspended ? 'danger' : 'ok')}>{vm.account.statusLabel}</span>
              </div>
              <InfoList rows={vm.account.rows} />
              {vm.actions.length > 0 ? (
                <div className={styles.actionRow} role="group" aria-label="계정 조치">
                  {vm.actions.map((action) => (
                    <button
                      className={action.tone === 'danger' ? workspacePageStyles.dangerButton : workspacePageStyles.primaryButton}
                      key={action.kind}
                      type="button"
                      onClick={action.open}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {vm.actionNote ? <p className={styles.actionNote}>{vm.actionNote}</p> : null}
            </section>

            <section className={workspacePageStyles.card} aria-label="기업 정보">
              <h2 className={workspacePageStyles.cardTitle}>기업</h2>
              {vm.companyRows ? <InfoList rows={vm.companyRows} /> : <p className={styles.actionNote}>등록한 기업이 없습니다.</p>}
            </section>

            <section className={workspacePageStyles.card} aria-label="활동">
              <h2 className={workspacePageStyles.cardTitle}>활동</h2>
              <InfoList rows={vm.activityRows} />
            </section>

            <section className={workspacePageStyles.card} aria-label="조치 기록">
              <h2 className={workspacePageStyles.cardTitle}>조치 기록</h2>
              {vm.history.length === 0 ? (
                <p className={styles.actionNote}>조치 기록이 없습니다.</p>
              ) : (
                <ol className={styles.historyList}>
                  {vm.history.map((item) => (
                    <li className={styles.historyItem} key={item.id}>
                      <strong>{item.label}</strong>
                      <span>{item.reason}</span>
                      <span className={styles.historyMeta}>{item.meta}</span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </div>

      <AdminAccountActionModal vm={vm.modal} />
    </>
  )
}

function InfoList({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className={styles.infoList}>
      {rows.map((row) => (
        <div className={styles.infoRow} key={row.label}>
          <dt className={styles.infoLabel}>{row.label}</dt>
          <dd className={styles.infoValue}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 조치 확인 모달입니다. 사유는 조치 기록에 남으므로 비어 있으면 보내지 않습니다. */
function AdminAccountActionModal({ vm }: { vm: DetailViewModel['modal'] }) {
  return (
    <WorkspaceModal isOpen={vm.isOpen} title={vm.title} description={vm.description} tone={vm.tone} onClose={vm.close}>
      <form className={workspaceModalStyles.form} aria-label="계정 조치" onSubmit={vm.submit} noValidate>
        <div className={workspaceModalStyles.field}>
          <label className={workspaceModalStyles.label} htmlFor="admin-action-reason">사유 (조치 기록에 남습니다)</label>
          <textarea
            className={`${workspaceModalStyles.input} ${styles.reasonInput}`}
            id="admin-action-reason"
            maxLength={vm.reasonMaxLength}
            aria-invalid={vm.error !== null}
            aria-describedby={vm.error ? 'admin-action-reason-error' : 'admin-action-reason-count'}
            value={vm.reason}
            onChange={(event) => vm.updateReason(event.target.value)}
          />
          <p id="admin-action-reason-count" className={styles.reasonCount}>{vm.reason.length} / {vm.reasonMaxLength}</p>
          {vm.error ? <p id="admin-action-reason-error" className={workspaceModalStyles.error} role="alert">{vm.error}</p> : null}
        </div>
        <div className={workspaceModalStyles.actions}>
          <button className={workspaceModalStyles.ghostButton} type="button" onClick={vm.close}>취소</button>
          <button
            className={vm.tone === 'danger' ? workspacePageStyles.dangerButton : workspacePageStyles.primaryButton}
            type="submit"
            disabled={!vm.canSubmit}
          >
            {vm.confirmLabel}
          </button>
        </div>
      </form>
    </WorkspaceModal>
  )
}
