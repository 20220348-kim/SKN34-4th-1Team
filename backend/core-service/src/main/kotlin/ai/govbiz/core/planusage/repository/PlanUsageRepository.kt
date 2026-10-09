package ai.govbiz.core.planusage.repository

import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanSource
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.repository.exception.PlanUsageStoreException
import ai.govbiz.core.planusage.repository.mapper.PlanUsageDraftProgramDbRow
import ai.govbiz.core.planusage.repository.mapper.PlanUsageMapper
import java.time.Clock
import java.time.LocalDateTime
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.dao.DataAccessException
import org.springframework.stereotype.Repository
import org.springframework.transaction.annotation.Transactional

/** 계정 요금제와 사용량을 MySQL에 저장하고 읽습니다. 저장소 오류는 한도를 확인할 수 없다는 예외로만 바꿉니다. */
@Repository
class PlanUsageRepository(
    private val mapper: PlanUsageMapper,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    /** 계정에 배정한 요금제입니다. 배정이 없으면 무료입니다. 끝났는지는 [AccountPlan.effectiveAt]이 가립니다. */
    fun findPlan(accountId: Long): AccountPlan = store {
        mapper.findPlan(accountId)?.let { row ->
            AccountPlan(
                PlanCode.valueOf(row.planCode), requireNotNull(row.assignedAt).atZone(clock.zone), row.endsAt?.atZone(clock.zone),
                source = PlanSource.valueOf(row.source),
            )
        } ?: AccountPlan.FREE
    }

    /** 이 계정이 체험을 시작한 적 있는 요금제입니다. */
    fun findTrialPlans(accountId: Long): Set<PlanCode> = store {
        mapper.findTrialPlanCodes(accountId).map(PlanCode::valueOf).toSet()
    }

    /**
     * 체험 기록을 남기고 그 요금제의 체험 이용권을 배정합니다. 호출한 Service의 transaction 안에서 계정 행을 잠근 뒤 부릅니다.
     * 기록의 기본 키가 (계정, 요금제)라 같은 요금제를 두 번 기록하지 않습니다.
     */
    fun startTrial(accountId: Long, plan: PlanCode, startsAt: ZonedDateTime, endsAt: ZonedDateTime) {
        store {
            val from = startsAt.toLocalDateTime().truncatedTo(ChronoUnit.MICROS)
            val to = endsAt.toLocalDateTime().truncatedTo(ChronoUnit.MICROS)
            check(mapper.insertTrial(accountId, plan.name, from, to) == 1) { "plan trial was not recorded" }
            mapper.assignTrialPlan(accountId, plan.name, from, to)
        }
    }

    /** 호출한 transaction이 끝날 때까지 계정 행을 잠급니다. 월 한도 작업 접수와 같은 행이라 같은 계정의 확인이 한 줄로 섭니다. */
    fun lockAccount(accountId: Long) {
        store { checkNotNull(mapper.lockAccount(accountId)) { "account $accountId is not active" } }
    }

    /** 작업 표를 남기지 않는 신청 문서 경로가 쓴 공고를 기록하고 기록 ID를 돌려줍니다. */
    fun addDraftProgram(accountId: Long, sourceCode: String, sourceProgramId: String): Long = store {
        val row = PlanUsageDraftProgramDbRow(accountId = accountId, sourceCode = sourceCode, sourceProgramId = sourceProgramId, createdAt = now())
        check(mapper.insertDraftProgram(row) == 1 && row.id > 0) { "draft program usage was not recorded" }
        row.id
    }

    /** 실행이 실패한 경로가 남긴 공고 기록을 지워 사용량을 돌려줍니다. */
    fun removeDraftProgram(id: Long) {
        store { mapper.deleteDraftProgram(id) }
    }

    /**
     * 한도 안일 때만 1을 더하고 더했는지 돌려줍니다. 먼저 그 기간의 행을 만들거나 잠그고 조건부 UPDATE 한 문장으로 더하므로,
     * 같은 계정의 요청이 동시에 와도 한도를 넘겨 더하지 않습니다. [limit]이 null(개발용 무제한 계정)이면 사용량만 남기도록 항상 더합니다.
     */
    @Transactional
    fun reserve(accountId: Long, feature: PlanUsageFeature, periodKey: String, limit: Int?): Boolean = store {
        val now = now()
        mapper.ensureCounter(accountId, feature.name, periodKey, now)
        mapper.incrementWithin(accountId, feature.name, periodKey, limit, now) == 1
    }

    fun release(accountId: Long, feature: PlanUsageFeature, periodKey: String) {
        store { mapper.decrement(accountId, feature.name, periodKey, now()) }
    }

    /** 지운 신청 문서·중복 검토가 그 달에 이미 쓴 횟수를 더해 둡니다. */
    fun addCount(accountId: Long, feature: PlanUsageFeature, periodKey: String, amount: Int) {
        require(amount > 0) { "amount must be positive" }
        store { mapper.addCount(accountId, feature.name, periodKey, amount, now()) }
    }

    fun findCounts(accountId: Long, periodKeys: Collection<String>): Map<Pair<PlanUsageFeature, String>, Int> = store {
        mapper.findCounts(accountId, periodKeys.distinct()).associate {
            (PlanUsageFeature.valueOf(it.feature) to it.periodKey) to it.usedCount
        }
    }

    /**
     * 월 한도 기능의 작업 표에서 이번 기간에 실패하지 않은 작업을 셉니다. [excluding]은 방금 만든 작업을 뺀 수를,
     * [including]은 아직 작업이 없는 공고를 더한 수를 셀 때 씁니다.
     */
    fun countJobs(
        accountId: Long,
        feature: PlanUsageFeature,
        window: PlanUsageWindow,
        excluding: PlanUsageJob? = null,
        including: PlanUsageJob.DraftProgram? = null,
    ): Int = store {
        val from = window.startsAt.toLocalDateTime()
        val to = window.resetsAt.toLocalDateTime()
        when (feature) {
            PlanUsageFeature.COMBINATION_REVIEW ->
                mapper.countChargeableReviewRuns(accountId, from, to, (excluding as? PlanUsageJob.ReviewRun)?.runId)
            PlanUsageFeature.APPLICATION_DRAFT -> mapper.countChargeableDraftPrograms(
                accountId, from, to,
                (excluding as? PlanUsageJob.FormDiscovery)?.jobId,
                (excluding as? PlanUsageJob.DocumentGeneration)?.jobId,
                including?.sourceCode, including?.sourceProgramId,
            )
            PlanUsageFeature.AI_SEARCH, PlanUsageFeature.EVIDENCE_QUESTION ->
                throw IllegalArgumentException("$feature is counted per request, not from jobs")
        }
    }

    private fun now(): LocalDateTime = LocalDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)

    private fun <T> store(operation: () -> T): T = try {
        operation()
    } catch (error: DataAccessException) {
        throw PlanUsageStoreException(error)
    }
}
