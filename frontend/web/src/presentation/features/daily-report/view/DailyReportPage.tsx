import { Link } from 'react-router'
import type { DailyReport, DailyReportItem } from '../../../../domain/entities/DailyReport'
import { appPaths, supportProgramDetailPath } from '../../../shared/routes/appPaths'
import { workspacePageStyles as styles } from '../../../shared/workspace/WorkspacePage.styles'
import { WorkspacePageHeader } from '../../../shared/workspace/WorkspacePageHeader'
import { useDailyReportViewModel } from '../viewmodel/useDailyReportViewModel'

const inputClass = 'w-full rounded-xl border border-sample-border bg-white p-3 text-sm outline-offset-2 focus:outline-brand-primary disabled:opacity-60'
const noteClass = 'm-0 text-sm leading-6 text-sample-muted'
const warningClass = 'rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900'

export function DailyReportPage() {
  const vm = useDailyReportViewModel()
  const busy = vm.busy !== null
  const settings = vm.settings
  return (
    <>
      <WorkspacePageHeader
        title="기업 맞춤 리포트"
        actions={<button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => void vm.load()}>상태 새로고침</button>}
      />
      <main className={styles.content}>
        <p className={noteClass}>등록한 지역·업종과 지원 목적에 맞는 접수 중 공고를 모아 봅니다. 관련도는 검색 순위를 위한 점수이며, 선정확률이나 신청 자격 보장이 아닙니다.</p>
        {vm.error && <p role="alert" className={warningClass}>{vm.error}</p>}
        {vm.notice && <p role="status" className={noteClass}>{vm.notice}</p>}
        {!vm.loaded && !vm.error && <p role="status">리포트 설정을 불러오는 중입니다.</p>}
        {vm.loaded && settings && <>
          {!settings.emailDeliveryAvailable && <p className={warningClass}>현재 서버의 이메일 발송이 꺼져 있습니다. 웹 미리보기는 사용할 수 있지만, 확인 메일과 정기 이메일 발송은 운영자의 설정 후 사용할 수 있습니다.</p>}
          {settings.emailDeliveryAvailable && !settings.schedulerEnabled && <p className={warningClass}>서버의 새 정기 발송 예약이 꺼져 있습니다. 이미 예약된 메일은 처리될 수 있습니다. 주소 확인과 수신 설정은 미리 저장할 수 있습니다. 메일 설정이 있어도 실제 도착을 보장하지는 않습니다.</p>}
          {vm.company === null ? <section className={styles.card}>
            <h2 className={styles.cardTitle}>기업 정보가 필요합니다</h2>
            <p className={noteClass}>지역과 업종을 기준으로 공고를 찾으려면 기업 정보를 먼저 등록해 주세요.</p>
            <Link className={styles.primaryButton} to={appPaths.profile}>기업 정보 등록하기</Link>
            {settings.enabled && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => vm.save(true)}>정기 이메일 수신 중지</button>}
          </section> : <section className={styles.card}>
            <h2 className={styles.cardTitle}>리포트 설정</h2>
            <p className={noteClass}>{vm.company.companyName} · {vm.company.region} · {vm.company.industry}</p>
            <Link className={styles.quietLink} to={appPaths.profile}>기업 조건 수정</Link>
            <p className={noteClass}>수신 주소: {vm.account?.email} · {settings.emailConfirmed ? '리포트 수신 주소 확인 완료' : '리포트 수신 주소 확인 필요'}</p>
            {!settings.emailConfirmed && <button className={styles.secondaryButton} type="button" disabled={busy || !settings.emailDeliveryAvailable} onClick={() => void vm.verifyEmail()}>{vm.busy === 'verify' ? '확인 메일 요청 중…' : '이메일 주소 확인 메일 보내기'}</button>}
            <p className={noteClass}>주소를 확인한 뒤 수신 동의를 저장해야 정기 발송이 켜집니다. 주소 확인은 계정 전체의 이메일 인증과 별개입니다.</p>
            <form aria-label="리포트 설정" onSubmit={(event) => { event.preventDefault(); vm.save() }} className="flex flex-col gap-4">
              <label className="flex flex-col gap-2 text-sm font-bold">지원 목적 (선택, 최대 100자)
                <input className={inputClass} value={vm.supportPurpose} maxLength={100} disabled={busy} placeholder="예: AI 제품 개발, 해외 전시회 참가" onChange={(event) => vm.updateForm({ supportPurpose: event.target.value })} />
              </label>
              <label className="flex items-start gap-2 text-sm leading-6">
                <input className="mt-1" type="checkbox" checked={vm.enabled} disabled={busy || !settings.emailConfirmed || !settings.emailDeliveryAvailable} onChange={(event) => vm.updateForm({ enabled: event.target.checked, consent: false })} />
                <span>매일 {settings.sendHour}시 이후 정기 이메일 받기 (한국 시간)</span>
              </label>
              {vm.enabled && <label className="flex items-start gap-2 text-sm leading-6">
                <input className="mt-1" type="checkbox" checked={vm.consent} disabled={busy} onChange={(event) => vm.updateForm({ consent: event.target.checked })} />
                <span>기업 맞춤 지원사업 리포트의 정기 이메일 수신에 동의합니다. 언제든 이 화면이나 이메일의 수신 해지 링크에서 중지할 수 있습니다.</span>
              </label>}
              <div className={styles.headerActions}>
                <button className={styles.primaryButton} type="submit" disabled={busy}>{vm.busy === 'save' ? '저장 중…' : '리포트 설정 저장'}</button>
                {settings.enabled && <button className={styles.secondaryButton} type="button" disabled={busy} onClick={() => vm.save(true)}>정기 이메일 수신 중지</button>}
              </div>
            </form>
            <p className={noteClass}>정기 수신: {settings.enabled ? '켜짐' : '꺼짐'} · 발송에는 서버 가동과 검색 준비가 필요합니다.</p>
          </section>}
          <section className={styles.card}>
            <h2 className={styles.cardTitle}>오늘의 미리보기와 최신 리포트</h2>
            <p className={noteClass}>미리보기를 생성할 때 AI 분석 비용이 발생할 수 있습니다. 계정당 하루 한 리포트를 웹과 이메일이 함께 사용하며, 저장한 조건을 바꾸어도 오늘의 결과는 다시 만들지 않습니다. 생성에 실패하면 같은 조건으로 최대 1회 재시도할 수 있으며 추가 AI 비용이 발생할 수 있습니다. 변경한 조건은 다음 리포트부터 반영됩니다.</p>
            <p className={noteClass}>미리보기 버튼 자체는 메일을 보내지 않습니다. 정기 수신이 켜져 있으면 생성된 오늘의 리포트가 정기 발송에 사용될 수 있습니다.</p>
            <button className={styles.primaryButton} type="button" disabled={busy || vm.company === null || vm.dirty} onClick={() => void vm.preview()}>{vm.busy === 'preview' ? '오늘의 리포트 생성 중…' : '오늘의 리포트 미리보기'}</button>
            {vm.dirty && <p className={noteClass}>변경한 설정을 먼저 저장해 주세요.</p>}
            {vm.report === null ? <p className={noteClass}>아직 생성된 리포트가 없습니다. 검색 결과가 없다는 뜻은 아닙니다.</p> : <ReportContent report={vm.report} />}
          </section>
          <p className={noteClass}>이 버전의 서류 안내는 지원하는 공식 HTML 본문의 근거에 한정됩니다. PDF·HWP 첨부파일 전체 검토와 뉴스 브리핑은 제공하지 않습니다. 신청 전 최신 공고와 담당 기관에서 최종 확인해 주세요.</p>
        </>}
      </main>
    </>
  )
}

const deliveryLabels: Record<DailyReport['deliveryStatus'], string> = {
  NOT_REQUESTED: '미발송 (예약 전 또는 대기 중)', SENDING: '발송 처리 중', SENT: '메일 서버에 전달 완료',
  UNKNOWN: '발송 결과 확인 필요 — 중복 방지를 위해 자동 재발송하지 않음', SKIPPED: '발송하지 않음',
}

function ReportContent({ report }: { report: DailyReport }) {
  return <div className="flex flex-col gap-4">
    <h3 className={styles.cardTitle}>{report.reportDate} 리포트</h3>
    <p className={noteClass}>생성 기준: {report.companyName} · {report.region} · {report.industry} · {report.supportPurpose || '지원 목적 지정 없음'}</p>
    <p className={noteClass}>이메일: {deliveryLabels[report.deliveryStatus]}</p>
    {report.generatedAt && <p className={noteClass}>생성 시각: {new Date(report.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (한국 시간)</p>}
    {report.warnings.map((warning, index) => <p key={index} className={warningClass}>{warning}</p>)}
    {report.status === 'GENERATING' && <p role="status">리포트를 생성 중입니다. 잠시 후 상태 새로고침으로 결과를 확인해 주세요.</p>}
    {report.status === 'FAILED' && <p role="alert" className={warningClass}>리포트 생성에 실패했습니다. {report.errorMessage || '서비스 상태를 확인해 주세요.'} 관련 공고가 없다는 뜻은 아닙니다.</p>}
    {report.status === 'READY' && (report.programs.length === 0
      ? <p className={noteClass}>이번 검색에서 추천할 접수 중 공고를 찾지 못했습니다. 전체 지원사업 중 신청 가능한 공고가 전혀 없다는 뜻은 아닙니다.</p>
      : report.programs.map((item) => <ReportItem key={JSON.stringify([item.sourceCode, item.sourceProgramId])} item={item} />))}
  </div>
}

const evidenceLabels: Record<DailyReportItem['evidenceStatus'], string> = {
  ANSWERED: '공식 본문 근거 확인', INSUFFICIENT_EVIDENCE: '공식 본문만으로 확인할 수 없음',
  UNSUPPORTED: '이 제공처의 원문 분석은 아직 지원하지 않음', FAILED: '원문 분석 실패 — 서류와 조건을 확인하지 못함',
}

function ReportItem({ item }: { item: DailyReportItem }) {
  return <article className={styles.outlinedCard}>
    <h4 className={styles.cardTitle}><Link className={styles.quietLink} to={supportProgramDetailPath({ sourceCode: item.sourceCode, sourceProgramId: item.sourceProgramId }, true)}>{item.title}</Link></h4>
    <p className={noteClass}>접수 기간: {item.applicationPeriod || '원문 확인 필요'}</p>
    <p className={noteClass}>검색 관련도: {item.relevanceScore === null ? '점수 없음' : `${item.relevanceScore}/100점`} · 선정확률 아님</p>
    {item.matchedReasons.length > 0 && <div><h5 className="m-0 text-sm font-bold">매칭 근거</h5><ul className="m-0 list-disc pl-5 text-sm leading-6">{item.matchedReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></div>}
    <p className={`${noteClass} whitespace-pre-wrap`}>대상·지역 확인: {item.eligibilityStatus === 'MATCH' ? '본문 기준 일치 (전체 신청 자격 보장 아님)' : '추가 확인 필요'}. {item.eligibilityNote}</p>
    <h5 className="m-0 text-sm font-bold">신청 전 확인할 조건·필요서류</h5>
    <p className={item.evidenceStatus === 'FAILED' ? warningClass : noteClass}>{evidenceLabels[item.evidenceStatus]}</p>
    {item.evidenceAnswer && <p className={`${noteClass} whitespace-pre-wrap`}>{item.evidenceAnswer}</p>}
    {item.citations.length > 0 && <ul className="m-0 list-disc space-y-2 pl-5 text-sm leading-6">{item.citations.map((citation, index) => <li key={index}><blockquote className="m-0 whitespace-pre-wrap">{citation.excerpt}</blockquote><a className={styles.quietLink} href={citation.sourceUrl} target="_blank" rel="noopener noreferrer">인용 원문 확인 {index + 1}</a></li>)}</ul>}
    <a className={styles.quietLink} href={item.sourceUrl} target="_blank" rel="noopener noreferrer">최신 공식 공고 확인</a>
  </article>
}
