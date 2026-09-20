import { Link } from 'react-router'

import { partnerRoleLabels } from '../../../../domain/entities/PartnerRecruitment'
import { workspacePageStyles, workspaceTagClassName } from '../../../shared/workspace/WorkspacePage.styles'
import {
  companyAgeLabel,
  programDeadlineLabel,
  recruitmentDeadlineLabel,
} from '../../../shared/partner-recruitment/partnerRecruitmentLabels'
import { publicPaths } from '../../../shared/routes/appPaths'
import { usePublicPartnerRecruitmentDetailViewModel } from '../viewmodel/usePublicPartnerRecruitmentDetailViewModel'
import { MaskedCompanyRow } from './MaskedCompanyRow'
import { PublicLoginPromptDialog } from './PublicLoginPromptDialog'
import { publicPartnerRecruitmentStyles as styles } from './PublicPartnerRecruitment.styles'

/**
 * 로그인 전 공개 모집글 상세입니다. 공고 원문과 모집 조건은 그대로 보여 주지만 작성 기업 정보는 가리고, 프로필 매칭과
 * 참여 제안 폼은 두지 않습니다. 제안 버튼은 로그인하면 할 수 있는 일을 다이얼로그로 안내하고 로그인 뒤 같은 모집글의
 * 내부 상세로 돌아옵니다.
 */
export function PublicPartnerRecruitmentDetailPage() {
  const {
    phase,
    recruitment,
    loginPath,
    proposalFlowSteps,
    isLoginPromptOpen,
    openLoginPrompt,
    closeLoginPrompt,
  } = usePublicPartnerRecruitmentDetailViewModel()

  if (phase === 'loading') {
    return (
      <main className={styles.page} aria-label="모집글 불러오는 중">
        <Link className={styles.backLink} to={publicPaths.partners}>← 파트너 모집 목록</Link>
        <p className={styles.description}>모집글을 불러오는 중입니다.</p>
      </main>
    )
  }

  if (phase === 'failed' || !recruitment) {
    return (
      <main className={styles.page}>
        <Link className={styles.backLink} to={publicPaths.partners}>← 파트너 모집 목록</Link>
        <h1 className={styles.detailTitle}>{phase === 'failed' ? '모집글을 불러오지 못했습니다' : '모집글을 찾을 수 없습니다'}</h1>
        <p className={styles.description}>
          {phase === 'failed' ? '잠시 후 다시 시도해 주세요.' : '요청한 모집글이 없거나 내려갔습니다. 다른 모집글로 대신 표시하지 않습니다.'}
        </p>
      </main>
    )
  }

  const isClosed = recruitment.status === 'CLOSED'
  const conditions = [
    { label: '우리 역할', value: partnerRoleLabels[recruitment.ownRole] },
    { label: '찾는 역할', value: `${partnerRoleLabels[recruitment.seekingRole]} ${recruitment.seekingCount}곳` },
    { label: '희망 지역', value: recruitment.region },
    { label: '희망 업력', value: companyAgeLabel(recruitment.minimumCompanyAgeYears) },
    { label: '필요 역량', value: recruitment.capabilities.length > 0 ? recruitment.capabilities.join(', ') : '없음' },
    { label: '제안 현황', value: `${recruitment.proposalCount}건` },
  ]

  return (
    <main className={styles.page}>
      <div className={styles.hero}>
        <Link className={styles.backLink} to={publicPaths.partners}>← 파트너 모집 목록</Link>
        <div className={styles.tagRow}>
          <span className={workspaceTagClassName('ok')}>기업마당 공고</span>
          <span className={workspaceTagClassName('muted')}>{isClosed ? '모집 마감' : '모집 중'}</span>
          <span className={styles.cardDeadline}>
            {isClosed ? '모집 마감' : recruitmentDeadlineLabel(recruitment.recruitmentDeadline)} · {recruitment.recruitmentDeadline}
          </span>
        </div>
        <h1 className={styles.detailTitle}>{recruitment.title}</h1>
        <div className={styles.heroActions}>
          <button className={workspacePageStyles.primaryButton} type="button" onClick={openLoginPrompt}>로그인하고 제안하기</button>
        </div>
      </div>

      <div className={styles.columns}>
        <div className={styles.column}>
          <section className={styles.card} aria-label="모집 조건">
            <MaskedCompanyRow />
            <div className={styles.conditionGrid}>
              {conditions.map((condition) => (
                <div className={styles.conditionCell} key={condition.label}>
                  <span className={styles.conditionLabel}>{condition.label}</span>
                  <span className={styles.conditionValue}>{condition.value}</span>
                </div>
              ))}
            </div>
          </section>

          <section className={styles.card} aria-label="연결된 공고">
            <p className={workspacePageStyles.sectionEyebrow}>연결된 공고</p>
            <div className={styles.cardTop}>
              <span className={workspaceTagClassName('ok')}>기업마당</span>
              <span className={styles.cardDeadline}>{programDeadlineLabel(recruitment.program.applicationEndDate)}</span>
            </div>
            <div className="flex flex-col gap-[0.15rem]">
              <strong className={workspacePageStyles.cardTitle}>{recruitment.program.title}</strong>
              <span className={styles.cardProgram}>{recruitment.program.organization}</span>
            </div>
            <p className={styles.bodyParagraph}>{recruitment.program.summary}</p>
            <div className={styles.rawBox}>
              <span><strong className={styles.rawBoxLabel}>신청기간 원문</strong> · {recruitment.program.applicationPeriod}</span>
              <span><strong className={styles.rawBoxLabel}>지원대상 원문</strong> · {recruitment.program.targetDescription}</span>
            </div>
            <a className={workspacePageStyles.quietLink} href={recruitment.program.sourceUrl} rel="noreferrer" target="_blank">
              공식 원문 보기
            </a>
          </section>

          <section className={styles.card} aria-label="모집 소개">
            <h2 className={workspacePageStyles.cardTitle}>모집 소개</h2>
            {recruitment.body.split(/\n{2,}/).map((paragraph, index) => (
              <p className={styles.bodyParagraph} key={`${index}-${paragraph.slice(0, 12)}`}>{paragraph}</p>
            ))}
            <p className={styles.disclaimer}>
              모집글의 내용은 작성 기업이 직접 입력한 것이며 GovBiz가 검증하지 않습니다. 공고 요건은 위 공식 원문에서 확인하세요.
            </p>
          </section>
        </div>

        <aside className={styles.column} aria-label="참여 제안 안내">
          <section className={styles.noticeCard} aria-label="제안 상태 흐름">
            <p className={workspacePageStyles.sectionEyebrow}>제안 상태 흐름</p>
            <div className={styles.flowRow}>
              {proposalFlowSteps.map((step, index) => (
                <span className="flex items-center gap-[0.35rem]" key={step}>
                  {index > 0 ? <span aria-hidden="true">›</span> : null}
                  <span className={styles.flowStep}>{step}</span>
                </span>
              ))}
            </div>
            <p className={styles.noticeText}>거절되거나 7일간 응답이 없으면 제안은 자동 종료됩니다.</p>
          </section>
        </aside>
      </div>

      <PublicLoginPromptDialog isOpen={isLoginPromptOpen} loginPath={loginPath} onClose={closeLoginPrompt} />
    </main>
  )
}
