package ai.govbiz.core.dailyreport.repository

import ai.govbiz.core.account.config.AccountSessionProperties
import ai.govbiz.core.dailyreport.domain.DailyReportPushDelivery
import ai.govbiz.core.dailyreport.domain.DailyReportPushOutcome
import ai.govbiz.core.dailyreport.repository.mapper.DailyReportPushMapper
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

@Repository
class DailyReportPushRepository(private val mapper: DailyReportPushMapper, private val sessions: AccountSessionProperties,
    @param:Qualifier("seoulClock") private val clock: Clock) {
    @Transactional
    fun register(deviceId: String, accountId: Long, sessionHash: String, token: String) {
        mapper.removeConflictingToken(deviceId, token)
        mapper.register(deviceId, accountId, sessionHash, token, now())
        check(enabled(deviceId, accountId))
    }
    fun disable(deviceId: String, accountId: Long) { mapper.disable(deviceId, accountId) }
    fun enabled(deviceId: String, accountId: Long) = mapper.enabled(deviceId, accountId, now(), idleBefore())
    fun hasSubscriber(accountId: Long) = mapper.hasSubscriber(accountId, now(), idleBefore())
    fun dueAccounts(date: LocalDate, limit: Int) = mapper.dueAccounts(date, now(), idleBefore(), limit)
    fun reserveDeliveries(date: LocalDate) { mapper.reserveDeliveries(date, now(), idleBefore()) }
    fun pending(): List<DailyReportPushDelivery> = mapper.pending(now(), idleBefore()).map {
        DailyReportPushDelivery(it.id, it.reportId, it.deviceId, it.expoToken, requireNotNull(it.reportDate), it.ticketId)
    }
    fun claim(id: Long) = mapper.claim(id, now(), idleBefore()) == 1
    fun valid(id: Long) = mapper.valid(id, now(), idleBefore())
    @Transactional
    fun finish(delivery: DailyReportPushDelivery, outcome: DailyReportPushOutcome) {
        check(mapper.finish(delivery.id, outcome.status, outcome.ticketId, outcome.errorCode,
            if (outcome.status == "ACCEPTED") now().plusMinutes(15) else null) == 1)
        if (outcome.errorCode == "DeviceNotRegistered") mapper.invalidateToken(delivery.deviceId, delivery.expoToken)
    }
    fun receipts(): List<DailyReportPushDelivery> = mapper.receipts(now()).map {
        DailyReportPushDelivery(it.id, it.reportId, it.deviceId, it.expoToken, requireNotNull(it.reportDate), it.ticketId)
    }
    fun expire() { mapper.expire(now()) }
    private fun now() = LocalDateTime.now(clock)
    private fun idleBefore() = now().minus(sessions.sessionIdleTtl)
}
