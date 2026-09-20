import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { appContainer } from '../../../../app/appContainer'
import type { DailyReportEmailAction } from '../../../../domain/entities/DailyReport'
import { appPaths } from '../../../shared/routes/appPaths'
import { workspacePageStyles as styles } from '../../../shared/workspace/WorkspacePage.styles'
import { dailyReportFailureMessage } from '../viewmodel/dailyReportMessages'

function readLink(hash: string): { action: DailyReportEmailAction; token: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const action = params.get('action')
  const token = params.get('token') ?? ''
  if ((action !== 'confirm' && action !== 'unsubscribe') || !/^[A-Za-z0-9_-]{43}$/.test(token) || params.getAll('token').length !== 1 || params.getAll('action').length !== 1) return null
  return { action, token }
}

/** 메일 보안 스캐너가 링크를 열어도 확인·해지가 실행되지 않습니다. 버튼을 누를 때만 POST합니다. */
export function DailyReportEmailPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const [link, setLink] = useState(() => readLink(location.hash))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<DailyReportEmailAction | null>(null)
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
      if (!controller.signal.aborted) setError(dailyReportFailureMessage(failure))
    } finally {
      if (request.current === controller) request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return <main className="mx-auto flex max-w-2xl flex-col gap-5 px-5 py-14">
    <h1 className={styles.title}>리포트 이메일 확인·수신 해지</h1>
    {error && <p role="alert">{error}</p>}
    {done ? <p role="status">{done === 'confirm' ? '리포트 수신 주소를 확인했습니다. 정기 수신은 아직 자동으로 켜지지 않습니다. 리포트 설정 화면에서 수신 동의를 저장해 주세요.' : '정기 리포트 이메일 수신을 중지했습니다.'}</p> : link ? <>
      <p>{link.action === 'confirm' ? '아래 버튼을 누르면 이 링크를 받은 이메일을 리포트 수신 주소로 확인합니다. 정기 수신 동의는 설정 화면에서 별도로 진행합니다.' : '아래 버튼을 누르면 이 이메일의 정기 리포트 수신을 중지합니다.'}</p>
      <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => void submit()}>{busy ? '처리 중…' : link.action === 'confirm' ? '리포트 수신 주소 확인' : '정기 리포트 수신 해지'}</button>
    </> : <p role="alert">유효한 이메일 링크가 없습니다. 새로고침했다면 받은 메일의 링크를 다시 열어 주세요. 만료된 링크는 리포트 설정에서 새로 요청할 수 있습니다.</p>}
    <Link className={styles.quietLink} to={appPaths.reports}>리포트 설정으로 이동 (로그인 필요)</Link>
  </main>
}
