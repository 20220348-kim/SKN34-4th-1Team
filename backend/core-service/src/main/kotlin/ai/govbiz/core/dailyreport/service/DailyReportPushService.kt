package ai.govbiz.core.dailyreport.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.helper.SessionTokenHelper
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.repository.CompanyRepository
import ai.govbiz.core.account.service.exception.CompanyNotRegisteredException
import ai.govbiz.core.dailyreport.client.DailyReportPushClient
import ai.govbiz.core.dailyreport.config.DailyReportPushProperties
import ai.govbiz.core.dailyreport.config.DailyReportProperties
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import ai.govbiz.core.dailyreport.repository.DailyReportPushRepository
import ai.govbiz.core.dailyreport.service.dto.DailyReportPushSettingsResult
import java.time.Clock
import java.time.LocalDate
import java.time.LocalTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service
import org.springframework.web.server.ResponseStatusException

@Service
class DailyReportPushService(private val repository: DailyReportPushRepository, private val client: DailyReportPushClient,
    private val properties: DailyReportPushProperties, private val reports: DailyReportProperties,
    private val sessions: AccountSessionService, private val companies: CompanyRepository,
    @param:Qualifier("seoulClock") private val clock: Clock) {
    private val log = LoggerFactory.getLogger(javaClass)
    fun available() = properties.enabled
    fun settings(account: Account, deviceId: String) = DailyReportPushSettingsResult(
        repository.enabled(deviceId, account.id), available(), reports.sendHour, reports.enabled)
    fun register(account: Account, deviceId: String, token: String, bearer: String?) {
        if (!available()) throw ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "앱 알림 발송이 설정되지 않았습니다.")
        if (sessions.requireAccount(bearer).id != account.id) throw AuthenticationRequiredException()
        companies.findByAccountId(account.id) ?: throw CompanyNotRegisteredException()
        repository.register(deviceId, account.id, SessionTokenHelper.hash(requireNotNull(bearer)), token)
    }
    fun disable(account: Account, deviceId: String) = repository.disable(deviceId, account.id)
    fun hasSubscriber(accountId: Long) = available() && repository.hasSubscriber(accountId)
    fun dueAccounts(date: LocalDate, limit: Int) = if (available()) repository.dueAccounts(date, limit) else emptyList()

    fun dispatch() {
        if (!available()) return
        repository.expire()
        // 메일과 별개로, READY 리포트만 공통 발송시각 이후 영속 예약한다.
        if (reports.enabled && LocalTime.now(clock).hour >= reports.sendHour) {
            repository.reserveDeliveries(LocalDate.now(clock))
            for (delivery in repository.pending()) {
                if (!repository.claim(delivery.id)) continue
                val outcome = if (!repository.valid(delivery.id)) DailyReportPushOutcome("SKIPPED") else try {
                    client.send(delivery)
                } catch (_: Exception) {
                    log.warn("Daily report push outcome unknown; deliveryId={}", delivery.id)
                    DailyReportPushOutcome("UNKNOWN", errorCode = "SendUnconfirmed")
                }
                repository.finish(delivery, outcome)
            }
        }
        for (delivery in repository.receipts()) {
            val outcome = try { client.receipt(requireNotNull(delivery.ticketId)) } catch (_: Exception) {
                log.warn("Daily report push receipt unavailable; deliveryId={}", delivery.id)
                null
            }
            if (outcome != null) repository.finish(delivery, outcome)
        }
    }
}
