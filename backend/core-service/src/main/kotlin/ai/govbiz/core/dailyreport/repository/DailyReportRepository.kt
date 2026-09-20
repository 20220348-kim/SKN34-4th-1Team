package ai.govbiz.core.dailyreport.repository

import ai.govbiz.core.dailyreport.domain.*
import ai.govbiz.core.dailyreport.repository.mapper.DailyReportDbRow
import ai.govbiz.core.dailyreport.repository.mapper.DailyReportMapper
import ai.govbiz.core.dailyreport.domain.exception.DailyReportErrorCode
import ai.govbiz.core.dailyreport.domain.exception.DailyReportException
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import java.util.UUID
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Isolation
import org.springframework.transaction.annotation.Transactional
import tools.jackson.databind.ObjectMapper

/** 외부 검색·LLM·메일 호출과 분리된 짧은 저장 transaction만 담당한다. */
@Repository
class DailyReportRepository(
    private val mapper: DailyReportMapper, private val json: ObjectMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    fun subscription(accountId: Long): DailyReportSubscription? = mapper.findSubscription(accountId)?.let {
        DailyReportSubscription(it.accountId, it.supportPurpose, it.enabled, it.confirmedEmail, it.confirmedAt, it.consentAt)
    }

    @Transactional
    fun saveSettings(accountId: Long, email: String, purpose: String, enabled: Boolean, consent: Boolean): DailyReportSubscription {
        mapper.ensureSubscription(accountId, now())
        val current = requireNotNull(mapper.lockSubscription(accountId))
        if (enabled && (!consent || current.confirmedAt == null || current.confirmedEmail != email)) {
            throw DailyReportException(if (!consent) DailyReportErrorCode.EMAIL_CONSENT_REQUIRED else DailyReportErrorCode.EMAIL_CONFIRMATION_REQUIRED)
        }
        mapper.updateSettings(accountId, purpose, enabled, now())
        return requireNotNull(subscription(accountId))
    }

    @Transactional
    fun reserveVerification(accountId: Long, email: String, hash: String) {
        val now = now()
        mapper.ensureSubscription(accountId, now)
        if (mapper.reserveVerification(accountId, email, hash, now, now.plusMinutes(30), now.minusMinutes(5)) != 1) {
            throw DailyReportException(DailyReportErrorCode.EMAIL_VERIFICATION_RATE_LIMITED)
        }
    }

    fun confirmEmail(hash: String): Boolean = mapper.confirmEmail(hash, now()) == 1

    @Transactional
    fun unsubscribe(hash: String): Boolean {
        if (!mapper.tokenExists(hash)) return false
        mapper.unsubscribe(hash, now())
        return true
    }

    fun latest(accountId: Long): DailyReport? = mapper.findLatest(accountId)?.toDomain()
    fun forDay(accountId: Long, date: LocalDate): DailyReport? = mapper.findDay(accountId, date)?.toDomain()

    // 없는 날짜별 report의 gap lock과 공유 예산 행 잠금 사이 교착을 피한다.
    // 같은 계정은 이미 존재하는 subscription 행 잠금으로 직렬화한다.
    @Transactional(isolation = Isolation.READ_COMMITTED)
    fun reserve(accountId: Long, date: LocalDate, input: DailyReportInput, maximumDailyAttempts: Int): DailyReportReservation {
        require(maximumDailyAttempts > 0)
        val now = now()
        mapper.ensureSubscription(accountId, now)
        mapper.lockSubscription(accountId)
        var existing = mapper.lockDay(accountId, date)
        if (existing != null && (existing.status != "FAILED" || existing.generationAttempts >= 2 || mapper.hasUnknownGeneration(existing.id))) {
            return DailyReportReservation(existing.toDomain(), false)
        }
        // 날짜 행 잠금으로 서버가 여러 개여도 생성 시도 한도를 넘지 않는다. 이후 실패도 예산을 돌려주지 않는다.
        mapper.ensureBudget(date)
        if (mapper.consumeBudget(date, maximumDailyAttempts) != 1) {
            throw DailyReportException(DailyReportErrorCode.REPORT_DAILY_BUDGET_EXCEEDED)
        }
        val key = UUID.randomUUID().toString()
        if (existing == null) {
            existing = DailyReportDbRow(accountId = accountId, reportDate = date, inputJson = json.writeValueAsString(input), generationKey = key, startedAt = now)
            check(mapper.insertReport(existing) == 1)
        } else {
            check(mapper.retryReport(existing.id, key, now) == 1)
            existing = requireNotNull(mapper.findDay(accountId, date))
        }
        return DailyReportReservation(existing.toDomain(), true)
    }

    /** 리포트·일별 예산·발행 대기 작업을 함께 커밋한다. 브로커는 이 transaction에서 호출하지 않는다. */
    @Transactional(isolation = Isolation.READ_COMMITTED)
    fun reserveScheduled(accountId: Long, date: LocalDate, input: DailyReportInput, maximumDailyAttempts: Int): DailyReportReservation {
        val reserved = reserve(accountId, date, input, maximumDailyAttempts)
        if (reserved.acquired) {
            val now = now()
            check(mapper.insertGenerationJob(reserved.report.id, reserved.report.generationKey, now,
                minOf(now.plusHours(1), date.plusDays(1).atStartOfDay())) == 1)
        }
        return reserved
    }

    fun publishableJobs(): List<Long> = mapper.findPublishableJobs(now())
    fun reserveJobPublication(id: Long): Boolean {
        val now = now()
        return mapper.reserveJobPublication(id, now, now.plusMinutes(1)) == 1
    }
    fun markJobPublished(id: Long) { check(mapper.markJobPublished(id, now()) == 1) }

    @Transactional
    fun claimGenerationJob(id: Long): DailyReport? {
        // MySQL multi-table UPDATE는 job와 report 양쪽 변경 행 수를 반환할 수 있다.
        if (mapper.claimGenerationJob(id, now()) == 0) return null
        return requireNotNull(mapper.findJobReport(id)).toDomain()
    }

    @Transactional
    fun finishGenerationJob(id: Long, report: DailyReport, content: DailyReportContent?, skipped: Boolean = false) {
        val status = if (skipped) "SKIPPED" else if (content == null) "FAILED" else "SUCCEEDED"
        check(mapper.finishGenerationJob(id, report.generationKey, status, now()) == 1)
        check(mapper.finishReport(report.id, report.generationKey, if (content == null) "FAILED" else "READY",
            content?.let(json::writeValueAsString),
            if (skipped) "계정·구독·기업 상태가 변경되어 정기 생성을 건너뛰었습니다."
            else if (content == null) "리포트를 생성하지 못했습니다. 저장된 공고와 검색 서비스 상태를 확인한 뒤 다시 시도해 주세요." else null,
            now()) == 1)
    }

    fun succeed(report: DailyReport, content: DailyReportContent): Boolean =
        mapper.finishReport(report.id, report.generationKey, "READY", json.writeValueAsString(content), null, now()) == 1
    fun fail(report: DailyReport): Boolean = mapper.finishReport(report.id, report.generationKey, "FAILED", null,
        "리포트를 생성하지 못했습니다. 저장된 공고와 검색 서비스 상태를 확인한 뒤 다시 시도해 주세요.", now()) == 1

    @Transactional
    fun expireStaleWork() {
        mapper.expireQueuedJobs(now())
        mapper.expireRunningJobs(now().minusMinutes(20), now())
        mapper.expireGeneration(now().minusMinutes(20))
        mapper.expireDelivery(now().minusMinutes(20))
        mapper.expireQueuedDeliveries(now())
    }

    fun enqueueDelivery(id: Long): Boolean {
        val now = now()
        return mapper.enqueueDelivery(id, now, minOf(now.plusHours(1), now.toLocalDate().plusDays(1).atStartOfDay())) == 1
    }
    fun queuedDelivery(id: Long): DailyReport? = mapper.findQueuedDelivery(id)?.toDomain()
    fun publishableDeliveries(): List<Long> = mapper.findPublishableDeliveries(now())
    fun reserveDeliveryPublication(id: Long): Boolean {
        val now = now()
        return mapper.reserveDeliveryPublication(id, now, now.plusMinutes(1)) == 1
    }
    fun markDeliveryPublished(id: Long) { check(mapper.markDeliveryPublished(id, now()) == 1) }

    fun claimDelivery(id: Long, email: String, unsubscribeHash: String): Boolean = mapper.claimDelivery(id, email, unsubscribeHash, now()) == 1
    fun finishDelivery(id: Long, status: DailyReportDeliveryStatus): Boolean {
        require(status in setOf(DailyReportDeliveryStatus.SENT, DailyReportDeliveryStatus.UNKNOWN, DailyReportDeliveryStatus.SKIPPED))
        return mapper.finishDelivery(id, status.name, now()) == 1
    }
    fun dueAccountIds(date: LocalDate, limit: Int, includeQueuedDeliveries: Boolean = true): List<Long> {
        require(limit in 1..101)
        return mapper.findDueAccountIds(date, limit, includeQueuedDeliveries)
    }

    private fun now(): LocalDateTime = LocalDateTime.now(clock)
    private fun DailyReportDbRow.toDomain() = DailyReport(id, accountId, requireNotNull(reportDate), DailyReportStatus.valueOf(status),
        DailyReportDeliveryStatus.valueOf(deliveryStatus), json.readValue(inputJson, DailyReportInput::class.java),
        contentJson?.let { json.readValue(it, DailyReportContent::class.java) }, generatedAt, errorMessage,
        generationAttempts, generationKey, requireNotNull(startedAt))
}
