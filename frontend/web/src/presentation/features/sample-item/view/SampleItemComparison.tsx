import { Link } from 'react-router'

import {
  sampleComparisonCellClassName,
  sampleItemStyles,
  sampleVersionButtonClassName,
} from './SampleItem.styles'

type SampleItemVersion = 'hook' | 'redux'

type SampleItemVersionSwitchProps = {
  activeVersion: SampleItemVersion
}

export function SampleItemVersionSwitch({ activeVersion }: SampleItemVersionSwitchProps) {
  return (
    <nav className={sampleItemStyles.versionSwitch}>
      <Link
        className={sampleVersionButtonClassName(activeVersion === 'hook')}
        to="/examples/sample-item/hook"
      >
        React Hook 버전
      </Link>
      <Link
        className={sampleVersionButtonClassName(activeVersion === 'redux')}
        to="/examples/sample-item/redux"
      >
        Redux Toolkit 버전
      </Link>
    </nav>
  )
}

export function SampleItemComparisonSummary({ activeVersion }: { activeVersion: SampleItemVersion }) {
  return (
    <section className={sampleItemStyles.comparison}>
      <div>
        <p className={sampleItemStyles.eyebrow}>
          같은 기능, 다른 상태 관리
        </p>
        <h2 className={sampleItemStyles.comparisonTitle}>
          두 버전에서 직접 확인할 차이
        </h2>
      </div>
      <div className={sampleItemStyles.comparisonTable}>
        <div className={sampleItemStyles.comparisonRow}>
          <strong className={sampleComparisonCellClassName(false, 'header')}>
            항목
          </strong>
          <strong
            className={sampleComparisonCellClassName(activeVersion === 'hook', 'header')}
          >
            React Hook
          </strong>
          <strong
            className={sampleComparisonCellClassName(activeVersion === 'redux', 'header')}
          >
            Redux Toolkit
          </strong>
        </div>
        <ComparisonRow label="상태 위치" hook="화면 Hook" redux="전역 Store slice" activeVersion={activeVersion} />
        <ComparisonRow label="화면 이동" hook="입력·결과 초기화" redux="입력·결과 유지" activeVersion={activeVersion} />
        <ComparisonRow label="새로고침" hook="초기화" redux="초기화" activeVersion={activeVersion} />
        <ComparisonRow label="API·UseCase" hook="동일" redux="동일" activeVersion={activeVersion} />
      </div>
    </section>
  )
}

function ComparisonRow({
  activeVersion,
  hook,
  label,
  redux,
}: {
  activeVersion: SampleItemVersion
  hook: string
  label: string
  redux: string
}) {
  return (
    <div className={sampleItemStyles.comparisonRow}>
      <span className={sampleComparisonCellClassName(false, 'body')}>{label}</span>
      <span
        className={sampleComparisonCellClassName(activeVersion === 'hook', 'body')}
      >
        {hook}
      </span>
      <span
        className={sampleComparisonCellClassName(activeVersion === 'redux', 'body')}
      >
        {redux}
      </span>
    </div>
  )
}
