import { Fragment } from 'react'
import { Link } from 'react-router'
import { pricingPlans as plans, pricingSearchSteps as searchSteps, pricingFrequentlyAskedQuestions as frequentlyAskedQuestions,
  pricingTitle, pricingUnlimitedNote, type PricingPlan } from '@govbiz/shared/design/pricingContent'
import {
  PLAN_TRIAL_DAYS, planEndsText, planLabels, planNameText, planTrialEndDateText, type PlanUsage, type TrialPlanCode,
} from '@govbiz/shared/domain/entities/PlanUsage'

import { appPaths, publicPaths } from '../../../shared/routes/appPaths'
import { loginPathFor } from '../../../shared/auth/returnPath'
import { WorkspaceModal } from '../../../shared/workspace/WorkspaceModal'
import { workspaceModalStyles } from '../../../shared/workspace/WorkspaceModal.styles'
import { workspacePageStyles } from '../../../shared/workspace/WorkspacePage.styles'

import { usePricingPlansViewModel, type PricingPlanAction } from '../viewmodel/usePricingPlansViewModel'
import { pricingPageStyles } from './PricingPage.styles'

type PricingPageLayout = 'public' | 'workspace'

/** 글자 공간과 접근 가능한 제목은 유지하고 시각적인 글자만 순서대로 나타냅니다. */
function PricingTitle() {
  let characterIndex = 0
  return <h1 className={pricingPageStyles.title} id="pricing-title" aria-label={pricingTitle}>
    <span aria-hidden="true">
      {pricingTitle.split(' ').map((word, wordIndex) => {
        if (wordIndex > 0) characterIndex += 1
        return <Fragment key={wordIndex}>
          {wordIndex > 0 ? ' ' : null}
          <span className={pricingPageStyles.titleWord}>
            {Array.from(word).map((character, index) => <span key={index} data-pricing-title-character=""
              className={pricingPageStyles.titleCharacter}
              style={{ animationDelay: `${180 + characterIndex++ * 75}ms` }}>{character}</span>)}
          </span>
        </Fragment>
      })}
    </span>
  </h1>
}

/**
 * 결제 기능 없이 요금제별 한도와 가격을 안내합니다. 로그인 전에는 헤더 아래 공개 페이지로, 로그인 뒤에는 사이드바 안에서
 * 같은 내용을 보여 주고 지금 요금제와 출시 전 무료 체험(플러스·프리미엄 각 14일, 요금제마다 한 번) 버튼을 둡니다.
 * 지금 요금제를 읽으면 그 카드만 강조하고, 로그인 전·읽기 전에는 추천 요금제(플러스)를 강조합니다.
 * 로그인 전 체험 버튼은 로그인 뒤 이 화면으로 돌아오게 합니다.
 */
export function PricingPage({ layout = 'public' }: { layout?: PricingPageLayout }) {
  const searchPath = layout === 'workspace' ? appPaths.chat : publicPaths.landing
  const viewModel = usePricingPlansViewModel(layout === 'workspace')
  const startedPlan = viewModel.started ? planNameText(viewModel.started.usage) : null
  return (
    <main className={pricingPageStyles.page}>
      <section className={pricingPageStyles.hero} aria-labelledby="pricing-title">
        <PricingTitle />
        <p className={pricingPageStyles.description}>
          지원사업 탐색부터 신청 준비까지 지금 무료로 시작하세요.
        </p>
      </section>

      <section className={pricingPageStyles.plansSection} aria-labelledby="pricing-plans-title">
        <h2 className={pricingPageStyles.plansHeading} id="pricing-plans-title">
          지금 시작하고, 필요한 만큼 확장하세요
        </h2>
        {viewModel.load?.status === 'failed' ? (
          <p className={pricingPageStyles.statusMessage} role="alert">
            지금 요금제를 불러오지 못해 체험 버튼을 쓸 수 없어요.{' '}
            <button className={pricingPageStyles.inlineButton} type="button" onClick={viewModel.retry}>다시 불러오기</button>
          </p>
        ) : null}
        {viewModel.started ? (
          <p className={pricingPageStyles.statusMessage} role="status">
            {startedPlan}을 시작했어요. {planEndsText(viewModel.started.usage)}
          </p>
        ) : null}
        <div className={pricingPageStyles.plansGrid}>
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              action={viewModel.actionOf(plan.code)}
              emphasized={viewModel.current ? viewModel.actionOf(plan.code) === 'current' : plan.isFeatured}
              current={viewModel.current}
              searchPath={searchPath}
              onConfirm={viewModel.confirm}
            />
          ))}
        </div>
        <TrialDialog
          plan={viewModel.confirming}
          current={viewModel.current}
          starting={viewModel.trial.status === 'starting'}
          failure={viewModel.trial.status === 'failed' ? viewModel.trial.message : null}
          onCancel={viewModel.cancel}
          onStart={viewModel.start}
        />
        <p className={pricingPageStyles.releaseNote}>{pricingUnlimitedNote}</p>
      </section>

      <section className={pricingPageStyles.valueSection} aria-labelledby="pricing-value-title">
        <div>
          <p className={pricingPageStyles.sectionEyebrow}>현재 무료로 이용할 수 있어요</p>
          <h2 className={pricingPageStyles.sectionHeading} id="pricing-value-title">
            찾고, 확인하고, 질문하세요
          </h2>
        </div>
        <div className={pricingPageStyles.valueGrid}>
          {searchSteps.map((step) => (
            <div className={pricingPageStyles.valueItem} key={step.number}>
              <span className={pricingPageStyles.valueNumber} aria-hidden="true">{step.number}</span>
              <h3 className={pricingPageStyles.valueTitle}>{step.title}</h3>
              <p className={pricingPageStyles.valueDescription}>{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className={pricingPageStyles.faqSection} aria-labelledby="pricing-faq-title">
        <div className={pricingPageStyles.faqHeader}>
          <h2 className={pricingPageStyles.sectionHeading} id="pricing-faq-title">자주 묻는 질문</h2>
          <p className={pricingPageStyles.faqDescription}>이용 전에 궁금한 점을 확인하세요.</p>
        </div>
        <div className={pricingPageStyles.faqList}>
          {frequentlyAskedQuestions.map((faq) => (
            <details className={pricingPageStyles.faqItem} key={faq.question}>
              <summary className={pricingPageStyles.faqQuestion}>
                <span className={pricingPageStyles.faqQuestionText}>{faq.question}</span>
                <svg
                  className={pricingPageStyles.faqIcon}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </summary>
              <p className={pricingPageStyles.faqAnswer}>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <section className={pricingPageStyles.closingSection} aria-labelledby="pricing-start-title">
        <h2 className={pricingPageStyles.sectionHeading} id="pricing-start-title">
          다음 기회가 될 공고를 만나보세요
        </h2>
        <p className={pricingPageStyles.closingDescription}>
          우리 기업의 지역, 업종, 지원 목적부터 이야기해 주세요.
          <br />
          지금 제공하는 검색 기능으로 탐색을 시작할 수 있습니다.
        </p>
        <Link className={pricingPageStyles.closingButton} to={searchPath}>
          지원사업 찾기 시작하기
          <svg
            className={pricingPageStyles.arrowIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M5 12h14m-6-6 6 6-6 6" />
          </svg>
        </Link>
      </section>
    </main>
  )
}

const actionLabels: Record<Exclude<PricingPlanAction, 'search' | 'login' | 'trial'>, string> = {
  loading: `${PLAN_TRIAL_DAYS}일 무료 체험 시작`,
  current: '현재 요금제',
  included: '현재 요금제에 포함',
  trialUsed: '체험 완료',
  unavailable: '체험할 수 없음',
}

/**
 * 요금제 카드 하나입니다. 기능은 모든 요금제가 같아 기능 목록 대신 한도를 적습니다.
 * 체험 버튼은 바로 시작하지 않고 확인 다이얼로그([TrialDialog])를 엽니다.
 */
function PlanCard({ plan, action, emphasized, current, searchPath, onConfirm }: {
  plan: PricingPlan
  action: PricingPlanAction
  emphasized: boolean
  current: PlanUsage | null
  searchPath: string
  onConfirm: (plan: TrialPlanCode) => void
}) {
  const isCurrent = action === 'current'
  const mutedTone = emphasized ? pricingPageStyles.featuredMuted : pricingPageStyles.regularMuted
  const iconTone = emphasized ? pricingPageStyles.featuredIcon : pricingPageStyles.regularIcon
  const disabledButton = isCurrent ? pricingPageStyles.currentButton
    : emphasized ? pricingPageStyles.featuredPendingButton : pricingPageStyles.regularPendingButton
  const cardTone = isCurrent ? pricingPageStyles.currentCard : emphasized ? pricingPageStyles.featuredCard : pricingPageStyles.regularCard
  const trialPlan = plan.code === 'FREE' ? null : plan.code
  // 지금 쓰는 유료 요금제면 언제까지인지, 체험할 수 있는 요금제면 끝난 뒤를 적습니다.
  const footerNote = action === 'current' && current?.planEndsAt ? planEndsText(current)
    : trialPlan && (action === 'trial' || action === 'login' || action === 'loading') ? '체험이 끝나면 무료로 돌아가며 자동 결제는 없어요.'
      : plan.footerNote
  return (
    <article
      className={`${pricingPageStyles.planCard} ${cardTone}`}
      aria-labelledby={`pricing-${plan.id}-title`}
      aria-current={isCurrent ? 'true' : undefined}
    >
      <div className={pricingPageStyles.planTop}>
        <p className={`${pricingPageStyles.planEyebrow} ${mutedTone}`}>{plan.label}</p>
        {isCurrent ? <span className={`${pricingPageStyles.planStatus} ${pricingPageStyles.currentStatus}`}>이용 중</span> : null}
      </div>
      <h3 className={pricingPageStyles.planTitle} id={`pricing-${plan.id}-title`}>{plan.name}</h3>
      <p className={`${pricingPageStyles.planDescription} ${mutedTone}`}>{plan.description}</p>
      <div className={pricingPageStyles.priceBlock}>
        <p className={pricingPageStyles.price}>
          {plan.price}
          {plan.pricePeriod ? <span className={pricingPageStyles.pricePeriod}> {plan.pricePeriod}</span> : null}
        </p>
        <p className={`${pricingPageStyles.priceNote} ${mutedTone}`}>{plan.priceNote}</p>
      </div>
      <div className={`${pricingPageStyles.divider} ${emphasized ? pricingPageStyles.featuredDivider : pricingPageStyles.regularDivider}`} aria-hidden="true" />
      <ul className={pricingPageStyles.limitList} aria-label={`${plan.name} 한도`}>
        {plan.limits.map((limit) => (
          <li className={pricingPageStyles.featureItem} key={limit}>
            <svg className={`${pricingPageStyles.featureIcon} ${iconTone}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="m5 12 4 4L19 6" />
            </svg>
            <span>{limit}</span>
          </li>
        ))}
      </ul>
      <div className={pricingPageStyles.planFooter}>
        {action === 'search' ? (
          <Link className={`${pricingPageStyles.planButton} ${pricingPageStyles.availableButton}`} to={searchPath}>무료로 지원사업 찾기</Link>
        ) : action === 'login' ? (
          <Link className={`${pricingPageStyles.planButton} ${pricingPageStyles.availableButton}`} to={loginPathFor(appPaths.pricing)}>
            로그인하고 {PLAN_TRIAL_DAYS}일 무료 체험
          </Link>
        ) : action === 'trial' && trialPlan ? (
          <button className={`${pricingPageStyles.planButton} ${pricingPageStyles.availableButton}`} type="button" onClick={() => onConfirm(trialPlan)}>
            {PLAN_TRIAL_DAYS}일 무료 체험 시작
          </button>
        ) : (
          <button className={`${pricingPageStyles.planButton} ${disabledButton}`} type="button" disabled>
            {actionLabels[action as keyof typeof actionLabels]}
          </button>
        )}
        <p className={`${pricingPageStyles.footerNote} ${mutedTone}`}>{footerNote}</p>
      </div>
    </article>
  )
}

/**
 * 체험 시작 확인 다이얼로그입니다. 끝나는 날, 자동 결제가 없다는 것, 요금제마다 한 번이라는 것을 보여 주고 [체험 시작]을 눌러야 시작합니다.
 * 다른 체험을 쓰는 중이면 그 체험이 바로 끝난다는 것을 함께 알립니다. 시작하는 동안에는 닫지 않고, 거절되면 이유를 다이얼로그 안에 보여 줍니다.
 */
function TrialDialog({ plan, current, starting, failure, onCancel, onStart }: {
  plan: TrialPlanCode | null
  current: PlanUsage | null
  starting: boolean
  failure: string | null
  onCancel: () => void
  onStart: (plan: TrialPlanCode) => void
}) {
  const name = plan ? planLabels[plan] : ''
  const switching = plan !== null && current?.planSource === 'TRIAL' && current.plan !== 'FREE' && current.plan !== plan
  return (
    <WorkspaceModal
      isOpen={plan !== null}
      title={`${name} ${PLAN_TRIAL_DAYS}일 무료 체험을 시작할까요?`}
      description={`${planTrialEndDateText()}까지 ${name} 한도로 쓰고, 끝나면 무료로 돌아가요.`}
      onClose={() => { if (!starting) onCancel() }}
    >
      <ul className={pricingPageStyles.trialPoints}>
        <li>결제 수단을 받지 않아 자동 결제는 없어요.</li>
        <li>요금제마다 한 번만 체험할 수 있어요.</li>
        {switching && current ? <li>지금 쓰는 {planNameText(current)}은 바로 끝나고 {name} 이용 기간이 새로 시작돼요.</li> : null}
      </ul>
      {failure ? <p className={workspaceModalStyles.error} role="alert">{failure}</p> : null}
      <div className={workspaceModalStyles.actions}>
        <button className={workspacePageStyles.secondaryButton} type="button" disabled={starting} onClick={onCancel}>취소</button>
        <button className={workspacePageStyles.primaryButton} type="button" disabled={starting} aria-busy={starting}
          onClick={() => { if (plan) onStart(plan) }}>
          {starting ? '체험을 시작하는 중' : '체험 시작'}
        </button>
      </div>
    </WorkspaceModal>
  )
}
