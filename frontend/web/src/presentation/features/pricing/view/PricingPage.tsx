import { Fragment } from 'react'
import { Link } from 'react-router'
import { pricingPlans as plans, pricingSearchSteps as searchSteps, pricingFrequentlyAskedQuestions as frequentlyAskedQuestions,
  pricingTitle, pricingReleaseNote } from '@govbiz/shared/design/pricingContent'

import { appPaths, publicPaths } from '../../../shared/routes/appPaths'
import { loginPathFor } from '../../../shared/auth/returnPath'

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
 * 결제 기능 없이 현재 공개 기능과 출시 예정 요금제를 안내합니다. 로그인 전에는 헤더 아래 공개 페이지로,
 * 로그인 뒤에는 사이드바 안에서 같은 내용을 보여 주며 검색 진입 버튼만 각 세계의 검색 화면으로 향합니다.
 */
export function PricingPage({ layout = 'public' }: { layout?: PricingPageLayout }) {
  const searchPath = layout === 'workspace' ? appPaths.chat : publicPaths.landing
  // 플러스 기능은 회원 전용이라 로그인 전에는 로그인 뒤 관심 공고함으로 돌아오게 하고, 로그인 뒤에는 바로 관심 공고함으로 갑니다.
  const proPath = layout === 'workspace' ? appPaths.savedPrograms : loginPathFor(appPaths.savedPrograms)
  return (
    <main className={pricingPageStyles.page}>
      <section className={pricingPageStyles.hero} aria-labelledby="pricing-title">
        <PricingTitle />
        <p className={pricingPageStyles.description}>
          지원사업 탐색부터 신청 준비까지 지금 무료로 시작하세요.
          <br />
          신청서 AI 초안과 우선 처리는 프리미엄으로 준비하고 있습니다.
        </p>
      </section>

      <section className={pricingPageStyles.plansSection} aria-labelledby="pricing-plans-title">
        <h2 className={pricingPageStyles.plansHeading} id="pricing-plans-title">
          지금 시작하고, 필요한 만큼 확장하세요
        </h2>
        <div className={pricingPageStyles.plansGrid}>
          {plans.map((plan) => {
            const cardTone = plan.isFeatured
              ? pricingPageStyles.featuredCard
              : pricingPageStyles.regularCard
            const mutedTone = plan.isFeatured
              ? pricingPageStyles.featuredMuted
              : pricingPageStyles.regularMuted
            const iconTone = plan.isFeatured
              ? pricingPageStyles.featuredIcon
              : pricingPageStyles.regularIcon

            return (
              <article
                className={`${pricingPageStyles.planCard} ${cardTone}`}
                aria-labelledby={`pricing-${plan.id}-title`}
                key={plan.id}
              >
                <div className={pricingPageStyles.planTop}>
                  <p className={`${pricingPageStyles.planEyebrow} ${mutedTone}`}>{plan.label}</p>
                  <span className={`${pricingPageStyles.planStatus} ${plan.isFeatured
                    ? pricingPageStyles.featuredStatus
                    : pricingPageStyles.regularStatus}`}
                  >
                    {plan.status}
                  </span>
                </div>
                <h3 className={pricingPageStyles.planTitle} id={`pricing-${plan.id}-title`}>
                  {plan.name}
                </h3>
                <p className={`${pricingPageStyles.planDescription} ${mutedTone}`}>
                  {plan.description}
                </p>
                <div className={pricingPageStyles.priceBlock}>
                  <p className={pricingPageStyles.price}>
                    {plan.price}
                  </p>
                  <p className={`${pricingPageStyles.priceNote} ${mutedTone}`}>{plan.priceNote}</p>
                </div>
                <div className={`${pricingPageStyles.divider} ${plan.isFeatured
                  ? pricingPageStyles.featuredDivider
                  : pricingPageStyles.regularDivider}`}
                  aria-hidden="true"
                />
                <p className={pricingPageStyles.featureHeading}>{plan.featureHeading}</p>
                <ul className={pricingPageStyles.featureList}>
                  {plan.features.map((feature) => (
                    <li className={pricingPageStyles.featureItem} key={feature}>
                      <svg
                        className={`${pricingPageStyles.featureIcon} ${iconTone}`}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d={plan.isAvailable ? 'm5 12 4 4L19 6' : 'M12 5v14M5 12h14'} />
                      </svg>
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
                <div className={pricingPageStyles.planFooter}>
                  {plan.action === 'search' ? (
                    <Link className={`${pricingPageStyles.planButton} ${pricingPageStyles.availableButton}`} to={searchPath}>
                      무료로 지원사업 찾기
                    </Link>
                  ) : plan.action === 'pro' ? (
                    <Link className={`${pricingPageStyles.planButton} ${pricingPageStyles.availableButton}`} to={proPath}>
                      지금 무료로 이용하기
                    </Link>
                  ) : (
                    <button
                      className={`${pricingPageStyles.planButton} ${plan.isFeatured
                        ? pricingPageStyles.featuredPendingButton
                        : pricingPageStyles.regularPendingButton}`}
                      type="button"
                      disabled
                    >
                      출시 준비 중
                    </button>
                  )}
                  <p className={`${pricingPageStyles.footerNote} ${mutedTone}`}>{plan.footerNote}</p>
                </div>
              </article>
            )
          })}
        </div>
        <p className={pricingPageStyles.releaseNote}>
          {pricingReleaseNote}
        </p>
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
