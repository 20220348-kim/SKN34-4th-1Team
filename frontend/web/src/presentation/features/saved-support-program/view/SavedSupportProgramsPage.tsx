import { Link } from 'react-router'

import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { savedSupportProgramMessages, useSavedSupportProgramsViewModel } from '../viewmodel/useSavedSupportProgramsViewModel'
import { savedSupportProgramStyles as styles } from './SavedSupportProgramsPage.styles'

/** 관심 공고함입니다. 공고 상세에서 담은 공고를 최근 순서로 보여 주고, 제목을 누르면 상세로 갑니다. */
export function SavedSupportProgramsPage() {
  const { phase, items, retry, searchPath } = useSavedSupportProgramsViewModel()

  return (
    <>
      <WorkspacePageHeader title="관심 공고함" />

      <div className={workspacePageStyles.content}>
        <div className={workspacePageStyles.column}>
          {phase === 'failed' ? (
            <section className={workspacePageStyles.card} aria-label="관심 공고 불러오기 실패">
              <p className={workspacePageStyles.emptyNote}>{savedSupportProgramMessages.failed}</p>
              <button className={workspacePageStyles.quietLink} type="button" onClick={retry}>다시 시도</button>
            </section>
          ) : phase === 'loading' && items.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="관심 공고 불러오는 중">
              <p className={workspacePageStyles.emptyNote}>{savedSupportProgramMessages.loading}</p>
            </section>
          ) : items.length === 0 ? (
            <section className={workspacePageStyles.card} aria-label="관심 공고 없음">
              <p className={workspacePageStyles.emptyNote}>{savedSupportProgramMessages.empty}</p>
              <div className={styles.linkRow}>
                <Link className={workspacePageStyles.primaryButton} to={searchPath}>지원사업 찾기</Link>
              </div>
            </section>
          ) : (
            <div className={styles.cardGrid}>
              {items.map((item) => (
                <article className={styles.card} key={item.key} aria-label={item.title}>
                  <div className={styles.cardTop}>
                    <span className={workspaceTagClassName(item.statusTone)}>{item.statusLabel}</span>
                    <span className={workspaceTagClassName('muted')}>{item.sourceName}</span>
                  </div>
                  <h2 className={styles.title}>
                    <Link className={styles.titleLink} to={item.detailPath} state={item.detailState}>{item.title}</Link>
                  </h2>
                  <p className={styles.organization}>{item.organization}</p>
                  {item.tags.length > 0 ? (
                    <div className={styles.tagRow}>
                      {item.tags.map((tag) => <span className={workspaceTagClassName('info')} key={tag}>{tag}</span>)}
                    </div>
                  ) : null}
                  <p className={styles.meta}>
                    <span>{item.deadlineLabel}</span>
                    <span>{item.savedOnLabel}</span>
                  </p>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
