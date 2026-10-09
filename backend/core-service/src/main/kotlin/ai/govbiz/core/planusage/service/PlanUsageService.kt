package ai.govbiz.core.planusage.service

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanTrial
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.GuestPlanUsageRepository
import ai.govbiz.core.planusage.repository.PlanUsageRepository
import ai.govbiz.core.planusage.service.dto.PlanUsageItem
import ai.govbiz.core.planusage.service.dto.PlanUsageResult
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import ai.govbiz.core.planusage.service.exception.PlanTrialException
import java.time.Clock
import java.time.Duration
import java.time.ZonedDateTime
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/**
 * 요금제 한도를 집행합니다. 요청마다 세는 기능(AI 대화 검색·원문 질문)은 AI를 부르기 전에 한 번을 먼저 빼고 실패하면 돌려주고,
 * 작업으로 세는 기능(신청 문서 초안·중복 검토)은 각 기능이 새 작업을 만든 DB transaction 안에서 그 작업까지 센 사용량을 확인합니다.
 * 작업 표를 남기지 않는 신청 문서 경로는 AI 전에 계정 행을 잠근 짧은 transaction에서 그 공고를 기록하고, 실패하면 지웁니다.
 * 기간은 요금제가 정합니다. 무료는 서울 하루·달, 유료(30일 이용권)는 이용 기간입니다.
 * 로컬 개발용으로 지정한 계정(`app.plan-usage.unlimited-account-emails`, 운영은 비움)은 사용량만 세고 막지 않습니다.
 * 사용량을 확인할 수 없으면 유료 기능을 실행하지 않고 오류로 끝냅니다.
 */
@Service
class PlanUsageService(
    private val repository: PlanUsageRepository,
    private val guests: GuestPlanUsageRepository,
    @param:Qualifier("seoulClock") private val clock: Clock,
    transactionManager: PlatformTransactionManager,
    private val accounts: AccountRepository,
    @param:Value("\${app.plan-usage.unlimited-account-emails:}") unlimitedAccountEmails: String,
) {
    private val transactions = TransactionTemplate(transactionManager)
    private val unlimitedEmails = unlimitedAccountEmails.split(',').map { it.trim().lowercase() }.filter { it.isNotEmpty() }.toSet()

    init {
        // 운영에서 켜지면 비용 상한이 사라지므로 시작할 때 몇 계정인지 남깁니다.
        if (unlimitedEmails.isNotEmpty()) logger.warn("plan_usage_unlimited_accounts count={}", unlimitedEmails.size)
    }

    /**
     * 요청마다 세는 기능의 요청 한 번을 한도에서 먼저 빼고 [action]을 실행합니다. 실행이 실패하면 뺀 한 번을 돌려줍니다.
     * 로그인하지 않았으면 접속 주소 기준 하루 체험 한도를 쓰며, 체험은 AI 대화 검색만 있습니다.
     */
    fun <T> consume(account: Account?, clientAddress: String, feature: PlanUsageFeature, action: () -> T): T {
        require(feature.perRequest) { "$feature is not counted per request" }
        val now = now()
        val release = if (account == null) {
            reserveGuest(clientAddress, feature, now)
        } else {
            reserveMember(account.id, feature, now)
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

    /**
     * 작업으로 세는 기능이 새 작업을 만든 직후 같은 DB transaction에서 부릅니다. 기능 쪽이 계정 행을 잠근 상태라 같은 계정의 접수가
     * 한 줄로 섭니다. 이 작업으로 사용량이 늘고(같은 공고를 다시 하면 늘지 않음) 늘어난 사용량이 한도를 넘으면 예외를 던져
     * transaction을 되돌립니다. 작업 표를 남기지 않는 신청 문서 경로는 [consumeDraftProgram]을 씁니다.
     */
    fun requireMonthlyCapacity(accountId: Long, job: PlanUsageJob) {
        require(job !is PlanUsageJob.DraftProgram) { "draft programs without a job are counted by consumeDraftProgram" }
        val feature = job.feature
        val now = now()
        val plan = planOf(accountId, now)
        val window = plan.windowOf(feature, now)
        val before = repository.countJobs(accountId, feature, window, excluding = job)
        val after = repository.countJobs(accountId, feature, window)
        if (after <= before) return
        val limit = plan.limitOf(feature) ?: return
        val kept = keptCount(accountId, feature, window)
        if (kept + after > limit) throw exceeded(feature, plan.code, limit, kept + before, window, now)
    }

    /**
     * 작업 표를 남기지 않는 신청 문서 경로(이전 동기 양식 분석·문서 생성, 문항별 AI 해석·초안)가 AI를 부르기 전에 씁니다.
     * 계정 행을 잠근 짧은 transaction에서 그 공고가 이번 기간 처음이면 한도를 확인하고 공고 기록을 남긴 뒤, transaction 밖에서
     * [action]을 실행합니다. [action]이 실패하면 이 호출이 남긴 기록만 지워 돌려줍니다. 이번 기간에 이미 센 공고는 늘지 않습니다.
     * 호출 쪽 transaction 안에서 부르지 않습니다(AI 호출 동안 계정 행을 잡지 않기 위해).
     */
    fun <T> consumeDraftProgram(accountId: Long, sourceCode: String, sourceProgramId: String, action: () -> T): T {
        val recordId = transactions.execute { _ -> reserveDraftProgram(accountId, PlanUsageJob.DraftProgram(sourceCode, sourceProgramId)) }
        try {
            return action()
        } catch (error: Throwable) {
            if (recordId != null) {
                try {
                    repository.removeDraftProgram(recordId)
                } catch (releaseError: RuntimeException) {
                    // 돌려주지 못한 한 건은 사용자에게 불리하지만 원래 실패를 가리지 않습니다.
                    error.addSuppressed(releaseError)
                    logger.warn("plan_usage_draft_release_failed recordId={}", recordId, releaseError)
                }
            }
            throw error
        }
    }

    /** 이번 기간 처음인 공고면 한도를 확인하고 기록 ID를, 이미 센 공고면 null을 돌려줍니다. */
    private fun reserveDraftProgram(accountId: Long, program: PlanUsageJob.DraftProgram): Long? {
        repository.lockAccount(accountId)
        val feature = program.feature
        val now = now()
        val plan = planOf(accountId, now)
        val window = plan.windowOf(feature, now)
        val before = repository.countJobs(accountId, feature, window)
        val after = repository.countJobs(accountId, feature, window, including = program)
        if (after <= before) return null
        val limit = plan.limitOf(feature)
        if (limit != null) {
            val kept = keptCount(accountId, feature, window)
            if (kept + after > limit) throw exceeded(feature, plan.code, limit, kept + before, window, now)
        }
        return repository.addDraftProgram(accountId, program.sourceCode, program.sourceProgramId)
    }

    /**
     * 신청 문서·중복 검토를 지우는 DB transaction 안에서 [delete]를 감쌉니다. 지운 작업이 이번 기간에 쓴 횟수를 남겨
     * 삭제로 한도가 다시 늘지 않게 합니다.
     */
    fun <T> keepMonthlyUsage(accountId: Long, feature: PlanUsageFeature, delete: () -> T): T {
        require(!feature.perRequest) { "$feature is not counted from jobs" }
        val now = now()
        val window = planOf(accountId, now).windowOf(feature, now)
        val before = repository.countJobs(accountId, feature, window)
        val result = delete()
        val removed = before - repository.countJobs(accountId, feature, window)
        if (removed > 0) repository.addCount(accountId, feature, window.key, removed)
        return result
    }

    /**
     * 현재 요금제와 기능별 사용량입니다. 로그인하지 않았으면 접속 주소의 AI 대화 검색 체험 사용량만 돌려줍니다.
     * 유료 요금제는 이용 기간 사용량과 이용권이 끝나는 때를 함께 돌려줍니다.
     */
    fun usage(account: Account?, clientAddress: String): PlanUsageResult {
        val now = now()
        if (account == null) {
            val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, now)
            return PlanUsageResult(
                null,
                null,
                listOf(
                    PlanUsageItem(
                        PlanUsageFeature.AI_SEARCH, window.period, PlanCode.GUEST_AI_SEARCH_PER_DAY,
                        guests.used(clientAddress, window), window.resetsAt,
                    ),
                ),
            )
        }
        val plan = planOf(account.id, now)
        val windows = PlanUsageFeature.entries.associateWith { plan.windowOf(it, now) }
        val counts = repository.findCounts(account.id, windows.values.map { it.key })
        val items = PlanUsageFeature.entries.map { feature ->
            val window = windows.getValue(feature)
            val counted = counts[feature to window.key] ?: 0
            val used = if (feature.perRequest) counted else counted + repository.countJobs(account.id, feature, window)
            PlanUsageItem(feature, window.period, plan.limitOf(feature), used, window.resetsAt)
        }
        return PlanUsageResult(plan.code, plan.endsAt, items, plan.source, PlanTrial.available(plan, repository.findTrialPlans(account.id)))
    }

    /**
     * 출시 전 무료 체험을 시작합니다. 계정 행을 잠근 짧은 transaction에서 자격을 확인하고 체험 기록과 이용권을 함께 씁니다.
     * 이메일 인증을 마친 회원만, 요금제마다 한 번, 지금보다 높은 요금제만 시작할 수 있습니다(운영자 배정 유료 요금제를 쓰는 동안은 안 됨).
     */
    fun startTrial(account: Account, plan: PlanCode): PlanUsageResult {
        if (!account.isEmailVerified) throw PlanTrialException(PlanTrialException.Reason.EMAIL_UNVERIFIED)
        transactions.executeWithoutResult { _ ->
            repository.lockAccount(account.id)
            val now = now()
            val used = repository.findTrialPlans(account.id)
            if (plan in used) throw PlanTrialException(PlanTrialException.Reason.USED)
            if (plan !in PlanTrial.available(repository.findPlan(account.id).effectiveAt(now), used)) {
                throw PlanTrialException(PlanTrialException.Reason.UNAVAILABLE)
            }
            repository.startTrial(account.id, plan, now, now.plusDays(PlanTrial.DAYS))
        }
        return usage(account, "")
    }

    private fun reserveGuest(clientAddress: String, feature: PlanUsageFeature, now: ZonedDateTime): () -> Unit {
        require(feature == PlanUsageFeature.AI_SEARCH) { "$feature requires a signed-in account" }
        val window = PlanUsageWindow.current(PlanUsagePeriod.DAY, now)
        val limit = PlanCode.GUEST_AI_SEARCH_PER_DAY
        if (!guests.reserve(clientAddress, window, limit)) throw exceeded(feature, null, limit, limit, window, now)
        return { guests.release(clientAddress, window) }
    }

    private fun reserveMember(accountId: Long, feature: PlanUsageFeature, now: ZonedDateTime): () -> Unit {
        val plan = planOf(accountId, now)
        val window = plan.windowOf(feature, now)
        val limit = plan.limitOf(feature)
        if (!repository.reserve(accountId, feature, window.key, limit) && limit != null) {
            throw exceeded(feature, plan.code, limit, limit, window, now)
        }
        return { repository.release(accountId, feature, window.key) }
    }

    /** 지금 쓰는 요금제입니다. 끝난 이용권은 무료이고, 개발용으로 지정한 계정은 한도 없이 셉니다. */
    private fun planOf(accountId: Long, now: ZonedDateTime): AccountPlan {
        val plan = repository.findPlan(accountId).effectiveAt(now)
        return if (isUnlimitedAccount(accountId)) plan.withoutLimits() else plan
    }

    /** 지정한 계정이 없으면(운영) 계정을 읽지 않습니다. */
    private fun isUnlimitedAccount(accountId: Long): Boolean =
        unlimitedEmails.isNotEmpty() && accounts.findById(accountId)?.email?.lowercase() in unlimitedEmails

    private fun keptCount(accountId: Long, feature: PlanUsageFeature, window: PlanUsageWindow): Int =
        repository.findCounts(accountId, listOf(window.key))[feature to window.key] ?: 0

    private fun exceeded(
        feature: PlanUsageFeature,
        plan: PlanCode?,
        limit: Int,
        used: Int,
        window: PlanUsageWindow,
        now: ZonedDateTime,
    ) = PlanQuotaExceededException(
        feature, window.period, plan, limit, used, window.resetsAt, Duration.between(now, window.resetsAt).seconds.coerceAtLeast(1),
    )

    private fun now(): ZonedDateTime = ZonedDateTime.now(clock)

    private companion object {
        val logger = LoggerFactory.getLogger(PlanUsageService::class.java)
    }
}
