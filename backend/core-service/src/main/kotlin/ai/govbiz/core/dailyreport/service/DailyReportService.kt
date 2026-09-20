package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.exception.CompanyNotRegisteredException
import ai.govbiz.core.dailyreport.client.DailyReportMailClient
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.repository.DailyReportRepository
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramCompanyConditions
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchState
import ai.govbiz.core.supportprogram.service.dto.SupportProgramSearchReadinessResult
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchService
import java.time.Clock
import java.time.LocalDate
import java.time.LocalTime
import java.util.concurrent.atomic.AtomicBoolean
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Service

/** 검색과 근거 답변을 재사용한다. 리포트가 저장되어야만 별도 단계에서 메일을 보낸다. */
@Service
class DailyReportService(
    private val repository: DailyReportRepository, private val companies: CompanyRepository,
    private val accounts: AccountRepository, private val search: SupportProgramSearchService,
    private val readiness: SupportProgramSearchReadinessService, private val evidence: SupportProgramEvidenceService,
    private val mail: DailyReportMailClient, private val properties: DailyReportProperties,
    private val admission: SupportProgramRequestAdmissionService,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    private val generating = AtomicBoolean(false)
    private val log = LoggerFactory.getLogger(javaClass)

    fun latest(account: Account): DailyReport? {
        repository.expireStaleWork()
        return repository.latest(account.id)
    }

    fun preview(account: Account): DailyReport = admission.execute("daily-report:${account.id}") { generate(account) }

    /** 정기 실행은 모델을 호출하지 않고 생성 예약과 Outbox만 함께 저장한다. */
    fun enqueueScheduled(account: Account): DailyReport {
        val company = companies.findByAccountId(account.id) ?: throw CompanyNotRegisteredException()
        val date = LocalDate.now(clock)
        repository.forDay(account.id, date)?.let {
            if (it.status != DailyReportStatus.FAILED || it.generationAttempts >= 2) return it
        }
        if (!readiness.get().indexReady) throw DailyReportException(DailyReportErrorCode.SEARCH_NOT_READY)
        val input = DailyReportInput(company.companyName, company.profile.region, company.profile.industry,
            repository.subscription(account.id)?.supportPurpose.orEmpty())
        return repository.reserveScheduled(account.id, date, input, properties.maxReportsPerDay).report
    }

    private fun generate(account: Account): DailyReport {
        val company = companies.findByAccountId(account.id) ?: throw CompanyNotRegisteredException()
        val date = LocalDate.now(clock)
        repository.expireStaleWork()
        repository.forDay(account.id, date)?.let {
            if (it.status != DailyReportStatus.FAILED || it.generationAttempts >= 2) return it
        }
        if (!generating.compareAndSet(false, true)) throw DailyReportException(DailyReportErrorCode.REPORT_CAPACITY_EXCEEDED)
        try {
            val ready = readiness.get()
            if (!ready.indexReady) throw DailyReportException(DailyReportErrorCode.SEARCH_NOT_READY)
            val input = DailyReportInput(company.companyName, company.profile.region, company.profile.industry,
                repository.subscription(account.id)?.supportPurpose.orEmpty())
            val reservation = repository.reserve(account.id, date, input, properties.maxReportsPerDay)
            val report = reservation.report
            if (!reservation.acquired) return report
            try {
                repository.succeed(report, generateContent(report, ready))
            } catch (_: Exception) {
                repository.fail(report)
                log.warn("Daily report generation failed; reportId={}", report.id)
            }
            return requireNotNull(repository.forDay(account.id, date))
        } finally {
            generating.set(false)
        }
    }

    /** 중복 전달은 DB의 QUEUED → RUNNING 전이로 차단한다. 미리보기와도 프로세스 내 생성 슬롯을 공유한다. */
    fun generateQueued(jobId: Long): Boolean {
        if (!generating.compareAndSet(false, true)) return false
        try {
            val report = repository.claimGenerationJob(jobId) ?: return true
            try {
                val account = accounts.findById(report.accountId)
                val subscription = repository.subscription(report.accountId)
                if (account == null || account.isSuspended || report.reportDate != LocalDate.now(clock) ||
                    subscription?.enabled != true || subscription.confirmedEmail != account.email ||
                    subscription.confirmedAt == null || subscription.consentAt == null ||
                    companies.findByAccountId(report.accountId) == null) {
                    repository.finishGenerationJob(jobId, report, null, skipped = true)
                    return true
                }
                val content = admission.execute("daily-report:${report.accountId}") {
                    val ready = readiness.get()
                    if (!ready.indexReady) throw DailyReportException(DailyReportErrorCode.SEARCH_NOT_READY)
                    generateContent(report, ready)
                }
                repository.finishGenerationJob(jobId, report, content)
            } catch (_: Exception) {
                repository.finishGenerationJob(jobId, report, null)
                log.warn("Queued daily report generation failed; jobId={}", jobId)
            }
            return true
        } finally { generating.set(false) }
    }

    private fun generateContent(report: DailyReport, ready: SupportProgramSearchReadinessResult): DailyReportContent {
        // 재시도도 첫 생성 때 고정한 조건을 사용한다. 정확한 설립일은 보유하지 않아 전송하지 않는다.
        val conditions = SupportProgramCompanyConditions(region = report.input.region, industry = report.input.industry,
            supportPurpose = report.input.supportPurpose.takeIf(String::isNotBlank))
        val query = listOf(report.input.region, report.input.industry, report.input.supportPurpose, "지원사업")
            .filter(String::isNotBlank).joinToString(" ")
        val programs = search.search(query, true, conditions).programs.take(properties.maxPrograms).map(::analyze)
        val warnings = buildList {
            add("관련도 점수는 검색 조건과 공고의 관련성입니다. 선정확률이나 신청 자격 확정이 아닙니다.")
            add("정확한 설립일·매출·인력·제외 요건은 확인하지 않았습니다. 첨부 PDF·HWP와 제출서류 전체는 직접 확인해 주세요.")
            if (ready.searchState != SupportProgramSearchState.SEARCHABLE) {
                add("일부 제공처가 준비 중이거나 최근 수집에 실패했습니다. 현재 검색 가능한 기존 공고만 포함합니다.")
            }
            ready.sources.filter { it.indexReady }.forEach {
                add("${it.sourceName} 최근 수집 성공: ${it.lastSuccessfulSyncAt ?: "확인할 수 없음"}")
            }
            if (programs.any { it.evidenceStatus == DailyReportEvidenceStatus.FAILED }) {
                add("일부 공고의 원문 근거 분석에 실패했습니다. 해당 공고는 공식 원문에서 확인해 주세요.")
            }
            if (programs.isEmpty()) add("현재 조건에 추천할 접수 중 공고를 찾지 못했습니다. 전체 공고의 부재를 의미하지는 않습니다.")
        }
        return DailyReportContent(programs, warnings)
    }

    /** SMTP 설정이 없으면 미선점 상태를 유지한다. Outbox가 기한 안에서 다시 전달한다. */
    fun deliverQueued(reportId: Long) {
        if (!mail.isAvailable() || LocalTime.now(clock).hour < properties.sendHour) return
        repository.queuedDelivery(reportId)?.let(::deliver)
    }

    fun deliver(report: DailyReport) {
        if (report.status != DailyReportStatus.READY || report.deliveryStatus != DailyReportDeliveryStatus.NOT_REQUESTED || !mail.isAvailable()) return
        val account = accounts.findById(report.accountId)?.takeUnless { it.isSuspended } ?: return
        val token = DailyReportSubscriptionService.newToken()
        if (!repository.claimDelivery(report.id, account.email, DailyReportSubscriptionService.hashToken(token))) return
        // 발송을 예약한 직후 구독 해제·계정 정지가 발생했는지 다시 확인한다.
        val current = accounts.findById(account.id)
        val subscription = repository.subscription(account.id)
        if (current == null || current.isSuspended || current.email != account.email || subscription?.enabled != true ||
            subscription.confirmedEmail != account.email || companies.findByAccountId(account.id) == null) {
            check(repository.finishDelivery(report.id, DailyReportDeliveryStatus.SKIPPED))
            return
        }
        val outcome = try {
            mail.sendReport(account.email, report.input.companyName, report.reportDate, renderSummary(report), token)
            DailyReportDeliveryStatus.SENT
        } catch (_: Exception) {
            // SMTP timeout은 서버 접수 이후일 수도 있다. 자동 재발송하지 않고 확인 필요 상태로 남긴다.
            log.warn("Daily report delivery outcome unknown; reportId={}", report.id)
            DailyReportDeliveryStatus.UNKNOWN
        }
        // SMTP 응답과 DB 저장은 원자적이지 않다. 저장 실패는 소비자에서 DLQ로 보내고 재발송하지 않는다.
        check(repository.finishDelivery(report.id, outcome))
    }

    private fun analyze(program: SupportProgram): DailyReportItem {
        var evidenceStatus = DailyReportEvidenceStatus.UNSUPPORTED
        var answer: String? = null
        var citations = emptyList<DailyReportCitation>()
        if (program.sourceCode == "BIZINFO") {
            try {
                val result = evidence.answer(program.sourceCode, program.id, "이 공고의 신청 대상, 신청 전에 확인해야 할 제한 조건, 제출이 필요한 서류를 원문에 있는 내용만 근거와 함께 설명해 주세요. 자료에서 확인할 수 없는 내용은 확인할 수 없다고 알려 주세요.")
                evidenceStatus = DailyReportEvidenceStatus.valueOf(result.answerStatus.name)
                answer = result.answer
                citations = result.citations.map { DailyReportCitation(it.excerpt, it.sourceUrl) }
            } catch (_: Exception) {
                evidenceStatus = DailyReportEvidenceStatus.FAILED
                log.warn("Daily report evidence analysis failed; sourceCode={}", program.sourceCode)
            }
        }
        return DailyReportItem(program.sourceCode, program.id, program.title, program.sourceUrl, program.applicationPeriod,
            program.recommendationScore, program.matchedReasons, program.eligibilityReview?.status?.name ?: "UNKNOWN",
            program.eligibilityReview?.let { "지원 대상: ${it.target.explanation}\n지역: ${it.region.explanation}" }
                ?: "신청 자격을 확인할 근거가 충분하지 않습니다. 공식 공고를 확인해 주세요.",
            evidenceStatus, answer, citations)
    }

    private fun renderSummary(report: DailyReport): String = buildString {
        appendLine("기업: ${report.input.companyName}")
        appendLine("조건: ${report.input.region} / ${report.input.industry} / ${report.input.supportPurpose.ifBlank { "일반 지원사업" }}")
        appendLine()
        report.content?.warnings?.forEach { appendLine("안내: $it") }
        report.content?.programs?.forEachIndexed { index, item ->
            appendLine("\n${index + 1}. ${item.title}")
            appendLine("접수 기간: ${item.applicationPeriod}")
            appendLine("검색 관련도: ${item.relevanceScore?.let { "$it / 100" } ?: "확인할 수 없음"} (선정확률 아님)")
            item.matchedReasons.forEach { appendLine("추천 근거: $it") }
            appendLine("자격 검토: ${item.eligibilityStatus}\n${item.eligibilityNote}")
            appendLine("원문 분석 상태: ${item.evidenceStatus}")
            item.evidenceAnswer?.let { appendLine(it) }
            item.citations.forEach { appendLine("근거: ${it.excerpt}\n출처: ${it.sourceUrl}") }
            appendLine("공식 공고: ${item.sourceUrl}")
        }
    }
}
