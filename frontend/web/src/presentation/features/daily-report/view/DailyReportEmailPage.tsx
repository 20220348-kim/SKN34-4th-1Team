import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type { DailyReportEmailAction } from '../../../../domain/entities/DailyReport'
import { DailyReportError } from '../../../../domain/errors/DailyReportError'
import { AuthLogo } from '../../../shared/auth/AuthLogo'
import { authPageStyles } from '../../../shared/auth/AuthPage.styles'
import { appPaths } from '../../../shared/routes/appPaths'
import { dailyReportFailureMessage } from '../viewmodel/dailyReportMessages'

function readLink(hash: string): { action: DailyReportEmailAction; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const action = params.get('action')
  const token = params.get('token') ?? ''
  if ((action !== 'confirm' && action !== 'unsubscribe') || !/^[A-Za-z0-9_-]{43}$/.test(token) || params.getAll('token').length !== 1 || params.getAll('action').length !== 1) return null
  return { action, token }
}

/** 처리 결과입니다. missing은 링크 없이 열었을 때(새로고침 포함), expired는 서버가 만료·재사용으로 거절했을 때입니다. */
type Outcome = DailyReportEmailAction | 'expired' | 'missing'

// 처리 전 안내입니다. 메일 보안 스캐너가 링크를 열어도 처리되지 않도록 버튼을 눌러야 요청합니다.
const prompts: Record<DailyReportEmailAction, { title: string; description: string; button: string }> = {
  confirm: {
    title: '리포트 수신 주소를 확인할까요?', button: '수신 주소 확인',
    description: '아래 버튼을 누르면 이 링크를 받은 이메일을 리포트 수신 주소로 확인해요. 정기 수신 동의는 기업 맞춤 리포트의 수신 설정에서 따로 저장해요.',
  },
  unsubscribe: { title: '정기 리포트 수신을 해지할까요?', button: '수신 해지', description: '아래 버튼을 누르면 이 이메일로 정기 리포트를 더 보내지 않아요.' },
}

// 결과 상태입니다. 결과 표지(원 아이콘) + 제목 + 설명 + [수신 설정 열기].
const outcomes: Record<Outcome, { tone: string; title: string; description: string }> = {
  confirm: {
    tone: 'bg-brand-soft text-brand-primary', title: '리포트 이메일을 확인했어요',
    description: '이 주소로 리포트를 받을 수 있어요. 정기 수신은 아직 자동으로 켜지지 않으니 기업 맞춤 리포트의 수신 설정에서 수신 동의를 저장해 주세요.',
  },
  unsubscribe: {
    tone: 'bg-info-soft text-info', title: '정기 리포트 수신을 해지했어요',
    description: '리포트 메일을 더 보내지 않아요. 다시 받으려면 기업 맞춤 리포트의 수신 설정에서 켜 주세요.',
  },
  expired: {
    tone: 'bg-danger-soft text-danger', title: '링크를 쓸 수 없어요',
    description: '만료됐거나 이미 사용한 링크예요. 기업 맞춤 리포트의 수신 설정에서 확인 메일을 다시 요청해 주세요.',
  },
  missing: {
    tone: 'bg-danger-soft text-danger', title: '링크를 쓸 수 없어요',
    description: '유효한 이메일 링크가 없어요. 새로고침했다면 받은 메일의 링크를 다시 열어 주세요. 만료된 링크는 기업 맞춤 리포트의 수신 설정에서 새로 요청할 수 있어요.',
  },
}

const resultMark = 'mb-1 grid size-14 place-items-center rounded-full'

/**
 * 리포트 메일의 링크로 여는 화면입니다. 로그인 · 소셜 로그인 처리 화면과 같은 가운데 카드에 처리 전 → 처리 중 → 결과를 차례로 보여 줍니다.
 * 메일 보안 스캐너가 링크를 열어도 확인·해지가 실행되지 않습니다. 버튼을 누를 때만 POST합니다.
 */
export function DailyReportEmailPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState(() => readLink(location.hash))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Outcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const useCase = appContainer.resolve('dailyReportUseCase')

  useEffect(() => {
    // fragment는 서버에 전송되지 않으며, 화면 메모리로 옮긴 직후 주소에서도 제거합니다.
    if (!location.hash) return
    request.current?.abort()
    request.current = null
    setLink(readLink(location.hash)); setDone(null); setError(null); setBusy(false)
    void navigate({ pathname: location.pathname, search: location.search, hash: '' }, { replace: true })
  }, [location.hash, location.pathname, location.search, navigate])
  useEffect(() => () => { request.current?.abort() }, [])

  async function submit() {
    if (!link || request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(null)
    try {
      await useCase.emailAction(link.action, link.token, controller.signal)
      if (!controller.signal.aborted) { setDone(link.action); setLink(null) }
    } catch (failure) {
      if (controller.signal.aborted) return
      // 만료·재사용 링크는 다시 눌러도 같으므로 결과로 넘기고, 그 밖의 실패는 버튼을 둔 채 다시 시도하게 합니다.
      if (failure instanceof DailyReportError && failure.code === 'INVALID_EMAIL_TOKEN') { setDone('expired'); setLink(null) }
      else setError(dailyReportFailureMessage(failure))
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const outcome: Outcome | null = done ?? (link ? null : 'missing')
  const failed = outcome === 'expired' || outcome === 'missing'
  return (
    <main className={authPageStyles.page}>
      <section className={authPageStyles.formPanel}>
        <div className={authPageStyles.card}>
          <AuthLogo />
          {outcome ? <>
            <div className={authPageStyles.statusBlock} role={failed ? 'alert' : 'status'}>
              <span className={`${resultMark} ${outcomes[outcome].tone}`} aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {failed ? <path d="M12 7v6m0 3.5v.01" /> : <path d="m6 12.5 4 4 8-9" />}
                </svg>
              </span>
              <h1 className={authPageStyles.statusTitle}>{outcomes[outcome].title}</h1>
              <p className={authPageStyles.statusDescription}>{outcomes[outcome].description}</p>
            </div>
            <Link className={`${authPageStyles.primaryLink} mt-3`} to={`${appPaths.reports}?settings=open`}>수신 설정 열기</Link>
            <p className={authPageStyles.fieldHint}>로그인이 필요하면 로그인한 뒤 바로 이어서 열려요.</p>
          </> : busy ? (
            <div className={authPageStyles.statusBlock} role="status" aria-live="polite">
              <span className={authPageStyles.statusSpinner} aria-hidden="true" />
              <h1 className={authPageStyles.statusTitle}>처리하는 중이에요…</h1>
            </div>
          ) : link ? <>
            <div className={authPageStyles.statusBlock}>
              <h1 className={authPageStyles.statusTitle}>{prompts[link.action].title}</h1>
              <p className={authPageStyles.statusDescription}>{prompts[link.action].description}</p>
            </div>
            {error && <p role="alert" className={`${authPageStyles.fieldError} text-center`}>{error}</p>}
            <button type="button" className={`${authPageStyles.submitButton} mt-3`} onClick={() => void submit()}>{prompts[link.action].button}</button>
          </> : null}
        </div>
      </section>
    </main>
  )
}
