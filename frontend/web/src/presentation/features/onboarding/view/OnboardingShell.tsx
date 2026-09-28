import { Fragment, type ReactNode } from 'react'
import { Link } from 'react-router'

import { publicPaths } from '../../../shared/routes/appPaths'
import type { OnboardingIcon } from '../viewmodel/onboardingOptions'
import { onboardingStyles as s } from './Onboarding.styles'

const iconPaths: Record<OnboardingIcon | 'info' | 'check', string> = {
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4 21a8 8 0 0 1 16 0',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M3 21h18M8 7h4M8 11h4M8 15h4',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 11v5M12 8h.01',
  check: 'm5 12 5 5L20 7',
}

export function OnboardingIconGlyph({ name, size = 18, strokeWidth = 1.75 }: { name: keyof typeof iconPaths; size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={iconPaths[name]} />
    </svg>
  )
}

export type OnboardingStep = { label: string; state: 'on' | 'done' | 'idle' }

/**
 * 온보딩 두 화면의 껍데기입니다. 머리글이 화면 맨 위에 가로로 놓이고 왼쪽에 로고, 가운데에 단계 표시(1 회원 유형 — 2 기업 정보)가
 * 있습니다. 좁은 화면은 단계 표시가 오른쪽의 "2 / 2 기업 정보" 글자로 바뀝니다. 본문은 머리글 아래 가운데 열에 들어가고
 * 버튼 줄은 본문 끝(좁은 화면은 아래 고정)에 놓입니다. 사이드바·도우미 없이 단독으로 뜹니다.
 */
export function OnboardingShell({ titleId, steps, width = 'narrow', children, foot }: {
  titleId: string
  steps: OnboardingStep[]
  /** 기업 정보 폼은 좁은 열, 회원 유형 카드 두 장은 넓은 열입니다. */
  width?: 'narrow' | 'wide'
  children: ReactNode
  foot: ReactNode
}) {
  const current = steps.findIndex((step) => step.state === 'on')
  return (
    <main className={s.page} aria-labelledby={titleId}>
      <header className={s.header}>
        <Link className={s.brand} to={publicPaths.landing} aria-label="GovBiz 홈으로"><span className={s.brandMark} aria-hidden="true">G</span>GovBiz</Link>
        <ol className={s.steps} aria-label="가입 단계">
          {steps.map((step, index) => (
            <Fragment key={step.label}>
              {index > 0 ? <li className={s.stepLine} aria-hidden="true" /> : null}
              <li className={`${s.step} ${step.state === 'on' ? s.stepOn : ''}`} aria-current={step.state === 'on' ? 'step' : undefined}>
                <span className={`${s.stepMark} ${step.state === 'done' ? s.stepMarkDone : step.state === 'on' ? s.stepMarkOn : s.stepMarkIdle}`} aria-hidden="true">
                  {step.state === 'done' ? <OnboardingIconGlyph name="check" size={14} strokeWidth={2.5} /> : index + 1}
                </span>
                {step.label}
              </li>
            </Fragment>
          ))}
        </ol>
        {current >= 0 ? (
          <span className={s.stepsMobile} aria-hidden="true">
            <span className={s.stepsMobileNumber}>{current + 1}</span> / {steps.length} {steps[current]!.label}
          </span>
        ) : null}
        <span className={s.headerEnd} />
      </header>
      <section className={`${s.body} ${width === 'wide' ? s.bodyWide : s.bodyNarrow}`}>
        {children}
        <div className={s.foot}>{foot}</div>
      </section>
    </main>
  )
}
