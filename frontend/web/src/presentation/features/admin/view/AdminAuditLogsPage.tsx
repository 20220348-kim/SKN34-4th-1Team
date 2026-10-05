import { Link } from 'react-router'

import { SelectField } from '../../../shared/workspace/SelectField'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { adminAccessMessages } from '../viewmodel/adminAccountAccess'
import { adminAuditLogMessages, useAdminAuditLogListViewModel } from '../viewmodel/useAdminAuditLogListViewModel'
import { adminAccountsPageStyles } from './AdminAccountsPage.styles'
import { adminAuditLogsPageStyles as styles } from './AdminAuditLogsPage.styles'

/**
 * 관리자 감사 기록입니다. 회원 정보 조회·계정 조치·권한 변경·이 화면 조회가 요청마다 한 줄씩 남은 기록을 최신순으로 보여 줍니다.
 * 기록은 고치거나 지울 수 없어 이 화면에도 조회와 조건만 있습니다.
 */
export function AdminAuditLogsPage() {
  const vm = useAdminAuditLogListViewModel()
  const form = vm.form

  return (
    <>
      <WorkspacePageHeader title="감사 기록" />

      <div className={workspacePageStyles.content}>
        <p className={styles.intro}>관리자가 회원 정보를 보거나 계정을 조치한 기록이며, 이 화면을 연 것도 남아요.</p>

        <section className={workspacePageStyles.card} aria-label="감사 기록 목록">
          {/* 조건은 조회를 눌러야 적용됩니다. 같은 조건으로 다시 누르면 최신 기록부터 다시 읽습니다. */}
          <form className={styles.filterForm} aria-label="감사 기록 검색" onSubmit={form.submit} noValidate>
            <label className={styles.field}>시작일
              <input className={styles.dateInput} type="date" name="from" value={form.values.from}
                max={form.values.to || undefined} onChange={(event) => form.updateFrom(event.target.value)} />
            </label>
            <label className={styles.field}>종료일
              <input className={styles.dateInput} type="date" name="to" value={form.values.to}
                min={form.values.from || undefined} onChange={(event) => form.updateTo(event.target.value)} />
            </label>
            <label className={styles.field}>작업
              <SelectField className={styles.actionSelect} label="작업" value={form.values.action}
                options={form.actionOptions} onChange={form.updateAction} />
            </label>
            <label className={styles.field}>관리자 ID
              <input className={styles.idInput} type="text" name="actorAccountId" inputMode="numeric" autoComplete="off"
                value={form.values.actorAccountId} onChange={(event) => form.updateActorAccountId(event.target.value)} />
            </label>
            <label className={styles.field}>대상 ID
              <input className={styles.idInput} type="text" name="targetAccountId" inputMode="numeric" autoComplete="off"
                value={form.values.targetAccountId} onChange={(event) => form.updateTargetAccountId(event.target.value)} />
            </label>
            <div className={styles.formActions}>
              <button className={workspacePageStyles.primaryButton} type="submit">조회</button>
              {vm.hasFilters ? (
                <button className={workspacePageStyles.quietLink} type="button" onClick={vm.resetFilters}>조건 초기화</button>
              ) : null}
            </div>
          </form>
          {form.error ? <p className={styles.formError} role="alert">{form.error}</p> : null}

          {vm.phase === 'forbidden' ? (
            <p className={workspacePageStyles.emptyNote} role="alert">{adminAccessMessages.forbidden}</p>
          ) : vm.phase === 'failed' ? (
            <p className={workspacePageStyles.emptyNote} role="alert">
              {adminAuditLogMessages.failed}{' '}
              <button className={workspacePageStyles.quietLink} type="button" onClick={vm.retry}>다시 시도</button>
            </p>
          ) : vm.phase === 'loading' && vm.rows.length === 0 ? (
            <p className={workspacePageStyles.emptyNote} role="status">{adminAuditLogMessages.loading}</p>
          ) : vm.rows.length === 0 ? (
            <p className={workspacePageStyles.emptyNote}>
              {adminAuditLogMessages.empty}{' '}
              {vm.hasFilters ? (
                <button className={workspacePageStyles.quietLink} type="button" onClick={vm.resetFilters}>조건 초기화</button>
              ) : null}
            </p>
          ) : (
            <div className={adminAccountsPageStyles.tableScroll} role="region" aria-label="감사 기록 표 가로 스크롤" tabIndex={0}>
              <table className={workspacePageStyles.table}>
                <thead>
                  <tr>
                    <th className={workspacePageStyles.tableHeadCell}>시각</th>
                    <th className={workspacePageStyles.tableHeadCell}>작업</th>
                    <th className={workspacePageStyles.tableHeadCell}>처리한 관리자</th>
                    <th className={workspacePageStyles.tableHeadCell}>대상 회원</th>
                    <th className={workspacePageStyles.tableHeadCell}>요청 내용</th>
                    <th className={workspacePageStyles.tableHeadCell}>접속 주소</th>
                  </tr>
                </thead>
                <tbody>
                  {vm.rows.map((row) => (
                    <tr key={row.id}>
                      <td className={`${workspacePageStyles.tableCell} ${styles.timeCell}`}>{row.time}</td>
                      <td className={workspacePageStyles.tableCell}>
                        <span className={workspaceTagClassName(row.actionTone)}>{row.actionLabel}</span>
                      </td>
                      <td className={workspacePageStyles.tableCell}>
                        <span className={styles.personCell}>
                          <span className={styles.personEmail}>{row.actorEmail}</span>
                          <span className={styles.personId}>{row.actorId}</span>
                        </span>
                      </td>
                      <td className={workspacePageStyles.tableCell}>
                        {row.target ? (
                          <Link className={adminAccountsPageStyles.emailLink} to={row.target.path}>{row.target.label}</Link>
                        ) : (
                          <span className={adminAccountsPageStyles.mutedText}>{row.targetNote}</span>
                        )}
                      </td>
                      <td className={workspacePageStyles.tableCell}>
                        <span className={styles.summaryCell}>{row.summary}</span>
                      </td>
                      <td className={workspacePageStyles.tableCell}>
                        <span className={styles.personCell}>
                          <span className={styles.timeCell}>{row.clientIp}</span>
                          {row.userAgent ? <span className={styles.userAgent} title={row.userAgent}>{row.userAgent}</span> : null}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {vm.hasPrevious || vm.hasNext ? (
            <nav className={styles.pagination} aria-label="감사 기록 쪽">
              <button className={workspacePageStyles.secondaryButton} type="button" disabled={!vm.hasPrevious} onClick={vm.goToPrevious}>
                이전
              </button>
              <span className={styles.pageLabel}>{vm.pageNumber}쪽</span>
              <button className={workspacePageStyles.secondaryButton} type="button" disabled={!vm.hasNext} onClick={vm.goToNext}>
                다음
              </button>
            </nav>
          ) : null}
        </section>
      </div>
    </>
  )
}
