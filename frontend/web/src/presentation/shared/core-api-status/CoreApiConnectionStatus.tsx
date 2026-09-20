import { useCoreApiHealth } from './useCoreApiHealth'
import {
  coreApiStatusDotClassName,
  coreApiStatusStyles,
} from './CoreApiConnectionStatus.styles'

export function CoreApiConnectionStatus() {
  const { data, isError, isLoading, refetch } = useCoreApiHealth()

  if (isLoading) {
    return (
      <div className={coreApiStatusStyles.root} role="status" aria-atomic="true">
        <span className={coreApiStatusDotClassName('loading')} />
        <div>
          <strong className={coreApiStatusStyles.title}>Core API 연결 확인 중</strong>
          <p className={coreApiStatusStyles.description}>Spring Boot 상태를 확인하고 있습니다.</p>
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div className={coreApiStatusStyles.root} role="status" aria-atomic="true">
        <span className={coreApiStatusDotClassName('error')} />
        <div>
          <strong className={coreApiStatusStyles.title}>Core API에 연결할 수 없습니다</strong>
          <p className={coreApiStatusStyles.description}>Spring Boot 실행 주소와 CORS 설정을 확인하세요.</p>
          <button
            type="button"
            className={coreApiStatusStyles.retryButton}
            onClick={() => void refetch()}
          >
            다시 확인
          </button>
        </div>
      </div>
    )
  }

  const isHealthy = data.status === 'up'

  return (
    <div className={coreApiStatusStyles.root} role="status" aria-atomic="true">
      <span
        className={coreApiStatusDotClassName(isHealthy ? 'healthy' : 'error')}
      />
      <div>
        <strong className={coreApiStatusStyles.title}>
          {isHealthy ? 'Core API 연결됨' : 'Core API 상태 확인 필요'}
        </strong>
        <p className={coreApiStatusStyles.description}>
          {data.service} · 상태: {data.status}
        </p>
        {!isHealthy ? (
          <button
            type="button"
            className={coreApiStatusStyles.retryButton}
            onClick={() => void refetch()}
          >
            다시 확인
          </button>
        ) : null}
      </div>
    </div>
  )
}
