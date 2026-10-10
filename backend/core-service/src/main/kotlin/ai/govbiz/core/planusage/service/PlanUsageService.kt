package ai.govbiz.core.planusage.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.dto.PlanUsageItem
import ai.govbiz.core.planusage.service.dto.PlanUsageResult
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import java.time.Clock
import java.time.Duration
import java.time.ZonedDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service

/**
 * 요금제 한도를 집행합니다. 하루 한도 기능은 AI를 부르기 전에 한 번을 먼저 빼고 실패하면 돌려줍니다.
 * 한도를 아직 정하지 않은 요금제와 로컬 개발용으로 지정한 계정(`app.plan-usage.unlimited-account-emails`, 운영은 비움)은
 * 막지 않고 사용량만 셉니다. 사용량을 확인할 수 없으면 유료 기능을 실행하지 않고 오류로 끝냅니다.
 */
@Service
class PlanUsageService(
    private val repository: PlanUsageRepository,
    private val guests: GuestPlanUsageRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
    @param:Value("\${app.plan-usage.unlimited-account-emails:}") unlimitedAccountEmails: String,
) {
    private val unlimitedEmails = unlimitedAccountEmails.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    init {
        // 운영에서 켜지면 비용 상한이 사라지므로 시작할 때 몇 계정인지 남깁니다.
        if (unlimitedEmails.isNotEmpty()) logger.warn("plan_usage_unlimited_accounts count={}", unlimitedEmails.size)
    }

    /**
     * 하루 한도 기능의 요청 한 번을 한도에서 먼저 빼고 [action]을 실행합니다. 실행이 실패하면 뺀 한 번을 돌려줍니다.
     * 로그인하지 않았으면 접속 주소 기준 체험 한도를 쓰며, 체험은 AI 대화 검색만 있습니다.
     */
    fun <T> consume(account: Account?, clientAddress: String, feature: PlanUsageFeature, action: () -> T): T {
        val now = now()
        val window = PlanUsageWindow.current(feature.period, now)
        val release = if (account == null) {
            reserveGuest(clientAddress, feature, window, now)
        } else {
            reserveMember(account, feature, window, now)
        }
        try {
            return action()
        } catch (error: Throwable) {
            try {
                release()
            } catch (releaseError: RuntimeException) {
                // 돌려주지 못한 한 번은 사용자에게 불리하지만 원래 실패를 가리지 않습니다.
                error.addSuppressed(releaseError)
                logger.warn("plan_usage_release_failed feature={}", feature, releaseError)
            }
            throw error
        }
    }

    /** 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 접속 주소의 AI 대화 검색 체험 사용량만 돌려줍니다. */
    fun usage(account: Account?, clientAddress: String): PlanUsageResult {
        val now = now()
        if (account == null) {
            val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, now)
            return PlanUsageResult(
                null,
                listOf(
                    PlanUsageItem(
                        PlanUsageFeature.AI_SEARCH, PlanCode.GUEST_AI_SEARCH_PER_DAY, guests.used(clientAddress, window), window.resetsAt,
                    ),
                ),
            )
        }
        val plan = repository.findPlan(account.id)
        val windows = PlanUsageFeature.entries.associateWith { PlanUsageWindow.current(it.period, now) }
        val counts = repository.findCounts(account.id, windows.values.map { it.key })
        val items = PlanUsageFeature.entries.map { feature ->
            val window = windows.getValue(feature)
            PlanUsageItem(feature, limitOf(account, plan, feature), counts[feature to window.key] ?: 0, window.resetsAt)
        }
        return PlanUsageResult(plan, items)
    }

    private fun reserveGuest(clientAddress: String, feature: PlanUsageFeature, window: PlanUsageWindow, now: ZonedDateTime): () -> Unit {
        require(feature == PlanUsageFeature.AI_SEARCH) { "$feature requires a signed-in account" }
        val limit = PlanCode.GUEST_AI_SEARCH_PER_DAY
        if (!guests.reserve(clientAddress, window, limit)) throw exceeded(feature, null, limit, limit, window, now)
        return { guests.release(clientAddress, window) }
    }

    /** 한도가 없는 요금제·계정도 사용량을 보여 주기 위해 세지만, 한도로 막지는 않습니다. */
    private fun reserveMember(account: Account, feature: PlanUsageFeature, window: PlanUsageWindow, now: ZonedDateTime): () -> Unit {
        val plan = repository.findPlan(account.id)
        val limit = limitOf(account, plan, feature)
        if (!repository.reserve(account.id, feature, window.key, limit) && limit != null) {
            throw exceeded(feature, plan, limit, limit, window, now)
        }
        return { repository.release(account.id, feature, window.key) }
    }

    /** 계정의 이 기능 한도입니다. 개발용으로 지정한 계정은 사용량만 세고 막지 않도록 null입니다. */
    private fun limitOf(account: Account, plan: PlanCode, feature: PlanUsageFeature): Int? =
        if (account.email.lowercase() in unlimitedEmails) null else plan.limitOf(feature)

    private fun exceeded(
        feature: PlanUsageFeature,
        plan: PlanCode?,
        limit: Int,
        used: Int,
        window: PlanUsageWindow,
        now: ZonedDateTime,
    ) = PlanQuotaExceededException(
        feature, plan, limit, used, window.resetsAt, Duration.between(now, window.resetsAt).seconds.coerceAtLeast(1),
    )

    private fun now(): ZonedDateTime = ZonedDateTime.now(clock)

    private companion object {
        val logger = LoggerFactory.getLogger(PlanUsageService::class.java)
    }
}
