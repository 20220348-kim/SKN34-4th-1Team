package ai.govbiz.core.planusage.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import ai.govbiz.core.applicationpreparation.repository.ApplicationDocumentGenerationJobRepository
import ai.govbiz.core.applicationpreparation.repository.ApplicationPreparationRepository
import ai.govbiz.core.planusage.domain.AccountPlan
import ai.govbiz.core.planusage.domain.PlanCode
import ai.govbiz.core.planusage.domain.PlanSource
import ai.govbiz.core.planusage.domain.PlanTrial
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.domain.PlanUsageJob
import ai.govbiz.core.planusage.domain.PlanUsagePeriod
import ai.govbiz.core.planusage.domain.PlanUsageWindow
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.planusage.service.exception.PlanQuotaExceededException
import ai.govbiz.core.planusage.service.exception.PlanTrialException
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate

/** 실제 MySQL 8.4에서 계정 요금제 배정, 사용량의 조건부 증가·되돌리기·삭제 보존·제약·계정 삭제 연쇄와 월 한도 작업 집계 SQL을 확인합니다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.application-document.jobs.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class PlanUsageRepositoryIntegrationTest {
    @Autowired private lateinit var repository: PlanUsageRepository
    @Autowired private lateinit var planUsage: PlanUsageService
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var preparations: ApplicationPreparationRepository
    @Autowired private lateinit var generationJobs: ApplicationDocumentGenerationJobRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    private val seoul = ZoneId.of("Asia/Seoul")
    private lateinit var month: PlanUsageWindow
    private var ownerId = 0L

    @BeforeEach
    fun prepare() {
        month = PlanUsageWindow.current(PlanUsagePeriod.MONTH, ZonedDateTime.now(seoul))
        ownerId = accounts.createAccount(
            NewAccount("plan-usage-${UUID.randomUUID()}@example.test", "test-password-hash", LocalDateTime.of(2026, 10, 1, 0, 0)),
        ).id
    }

    @Test
    fun readsFreeWithoutAnAssignmentAndTheAssignedPlanWithItsPassPeriodOtherwise() {
        assertEquals(AccountPlan.FREE, repository.findPlan(ownerId))
        jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PREMIUM', NOW(6))", ownerId)
        assertEquals(PlanCode.PREMIUM, repository.findPlan(ownerId).code)
        assertNull(repository.findPlan(ownerId).endsAt)

        // 운영 문서의 30일 이용권 배정 SQL은 다시 실행하면 요금제와 기간을 바꿉니다. 시각은 서울 기준으로 읽습니다.
        val starts = LocalDateTime.of(2026, 10, 1, 15, 30)
        jdbc.update("""INSERT INTO account_plan (account_id, plan_code, assigned_at, ends_at) VALUES (?, 'PLUS', ?, ?) AS assigned
            ON DUPLICATE KEY UPDATE plan_code = assigned.plan_code, assigned_at = assigned.assigned_at, ends_at = assigned.ends_at""",
            ownerId, starts, starts.plusDays(30))
        assertEquals(
            AccountPlan(PlanCode.PLUS, starts.atZone(seoul), starts.plusDays(30).atZone(seoul), source = PlanSource.OPERATOR),
            repository.findPlan(ownerId),
        )

        // 행을 지우면 FREE로 돌아갑니다.
        jdbc.update("DELETE FROM account_plan WHERE account_id = ?", ownerId)
        assertEquals(AccountPlan.FREE, repository.findPlan(ownerId))
    }

    @Test
    fun reservesOnlyWithinTheLimitWhenFirstUsesRaceAndReleasesWithoutGoingBelowZero() {
        val pool = Executors.newFixedThreadPool(8)
        val accepted = try {
            (1..12).map { pool.submit(Callable { repository.reserve(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-08", 5) }) }
                .count { it.get(20, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }

        assertEquals(5, accepted)
        assertEquals(5, used(PlanUsageFeature.AI_SEARCH, "2026-10-08"))
        repository.release(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-08")
        assertEquals(4, used(PlanUsageFeature.AI_SEARCH, "2026-10-08"))
        assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-08", 5))
        assertEquals(false, repository.reserve(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-08", 5))
        // 다른 날·다른 기능은 따로 셉니다.
        assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-09", 5))
        assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 1))
        repeat(3) { repository.release(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08") }
        assertEquals(0, used(PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08"))
    }

    @Test
    fun developmentAccountsAreCountedWithoutAnUpperBound() {
        repeat(3) { assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", null)) }
        assertEquals(3, used(PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08"))
        // 한도가 있으면 이미 센 사용량부터 적용됩니다.
        assertEquals(false, repository.reserve(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 3))
    }

    @Test
    fun aPassPeriodKeyCountsSeparatelyFromTheFreeDailyKey() {
        assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "P20261001T153000", 500))
        assertEquals(true, repository.reserve(ownerId, PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08", 10))
        assertEquals(1, used(PlanUsageFeature.EVIDENCE_QUESTION, "P20261001T153000"))
        assertEquals(1, used(PlanUsageFeature.EVIDENCE_QUESTION, "2026-10-08"))
        repository.addCount(ownerId, PlanUsageFeature.APPLICATION_DRAFT, "P20261001T153000", 2)
        assertEquals(2, used(PlanUsageFeature.APPLICATION_DRAFT, "P20261001T153000"))
    }

    @Test
    fun theDatabaseRejectsUnknownFeaturesPlansAndPeriodKeys() {
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'AI_SEARCH', '2026-13-01', 0, NOW(6))", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'AI_SEARCH', 'today', 0, NOW(6))", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'ASSISTANT', '2026-10-08', 0, NOW(6))", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'GOLD', NOW(6))", ownerId)
        }
        // 대소문자를 구분하는 ascii_bin이라 소문자 코드도 받지 않습니다.
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'premium', NOW(6))", ownerId)
        }
        assertEquals(AccountPlan.FREE, repository.findPlan(ownerId))
        // 이용권은 시작보다 늦게 끝나야 합니다.
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at, ends_at) VALUES (?, 'PLUS', NOW(6), NOW(6))", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'AI_SEARCH', 'P20261001', 0, NOW(6))", ownerId)
        }
        jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'AI_SEARCH', '2026-10-31', 0, NOW(6))", ownerId)
        // V59부터 유료 이용 기간 키(P+서울 시각)를 받습니다.
        jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'AI_SEARCH', 'P20261001T153000', 0, NOW(6))", ownerId)
        jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'EVIDENCE_QUESTION', '2026-10-31', 0, NOW(6))", ownerId)
        // V57부터 월 한도 기능과 달 키(YYYY-MM)를 받습니다.
        jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'APPLICATION_DRAFT', '2026-10', 0, NOW(6))", ownerId)
        jdbc.update("INSERT INTO plan_usage_counter VALUES (?, 'COMBINATION_REVIEW', '2026-10', 0, NOW(6))", ownerId)
    }

    @Test
    fun aTrialIsRecordedOncePerPlanAndAssignsATrialPassThatCanMoveUp() {
        val member = requireNotNull(accounts.findById(ownerId)).copy(emailVerifiedAt = LocalDateTime.of(2026, 10, 1, 0, 0))
        val plus = planUsage.startTrial(member, PlanCode.PLUS)
        assertEquals(PlanCode.PLUS, plus.plan)
        assertEquals(PlanSource.TRIAL, plus.planSource)
        assertEquals(listOf(PlanCode.PREMIUM), plus.trialsAvailable)
        val stored = repository.findPlan(ownerId)
        assertEquals(PlanSource.TRIAL, stored.source)
        assertEquals(requireNotNull(stored.startsAt).plusDays(PlanTrial.DAYS), stored.endsAt)
        assertEquals(PlanTrialException.Reason.USED, assertThrows(PlanTrialException::class.java) {
            planUsage.startTrial(member, PlanCode.PLUS)
        }.reason)

        // 플러스 체험 중 프리미엄 체험은 바로 바꾸고 새 이용 기간을 시작합니다.
        val premium = planUsage.startTrial(member, PlanCode.PREMIUM)
        assertEquals(PlanCode.PREMIUM, premium.plan)
        assertEquals(emptyList<PlanCode>(), premium.trialsAvailable)
        assertEquals(setOf(PlanCode.PLUS, PlanCode.PREMIUM), repository.findTrialPlans(ownerId))

        // 운영 문서의 배정 SQL은 체험 배정을 운영자 배정으로 바꿉니다.
        jdbc.update("""INSERT INTO account_plan (account_id, plan_code, source, assigned_at, ends_at) VALUES (?, 'PLUS', 'OPERATOR', NOW(6), NULL) AS assigned
            ON DUPLICATE KEY UPDATE plan_code = assigned.plan_code, source = assigned.source, assigned_at = assigned.assigned_at, ends_at = assigned.ends_at""",
            ownerId)
        assertEquals(PlanSource.OPERATOR, repository.findPlan(ownerId).source)
    }

    @Test
    fun theDatabaseKeepsOneTrialPerPlanOnlyForPaidPlansAndKnownSources() {
        jdbc.update("INSERT INTO plan_trial VALUES (?, 'PLUS', NOW(6), NOW(6) + INTERVAL 14 DAY)", ownerId)
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_trial VALUES (?, 'PLUS', NOW(6), NOW(6) + INTERVAL 14 DAY)", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_trial VALUES (?, 'FREE', NOW(6), NOW(6) + INTERVAL 14 DAY)", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO plan_trial VALUES (?, 'PREMIUM', NOW(6), NOW(6))", ownerId)
        }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO account_plan (account_id, plan_code, source, assigned_at) VALUES (?, 'PLUS', 'PAID', NOW(6))", ownerId)
        }
        // 기존 배정 SQL처럼 source를 적지 않으면 운영자 배정입니다.
        jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PLUS', NOW(6))", ownerId)
        assertEquals(PlanSource.OPERATOR, repository.findPlan(ownerId).source)

        jdbc.update("DELETE FROM account WHERE id = ?", ownerId)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM plan_trial WHERE account_id = ?", Int::class.java, ownerId))
    }

    @Test
    fun keepsDeletedUsageAsACountInTheSameMonth() {
        repository.addCount(ownerId, PlanUsageFeature.COMBINATION_REVIEW, month.key, 2)
        repository.addCount(ownerId, PlanUsageFeature.COMBINATION_REVIEW, month.key, 1)
        assertEquals(mapOf((PlanUsageFeature.COMBINATION_REVIEW to month.key) to 3), repository.findCounts(ownerId, listOf(month.key, month.key)))
    }

    @Test
    fun deletingTheAccountRemovesItsPlanAndUsage() {
        jdbc.update("INSERT INTO account_plan (account_id, plan_code, assigned_at) VALUES (?, 'PLUS', NOW(6))", ownerId)
        repository.reserve(ownerId, PlanUsageFeature.AI_SEARCH, "2026-10-08", 10)
        repository.addDraftProgram(ownerId, "BIZINFO", "PBLN_DELETED")

        jdbc.update("DELETE FROM account WHERE id = ?", ownerId)

        assertEquals(0, records())

        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM account_plan WHERE account_id = ?", Int::class.java, ownerId))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM plan_usage_counter WHERE account_id = ?", Int::class.java, ownerId))
    }

    @Test
    fun countsReviewRunsThatDidNotFailThisMonthExcludingDemoSeedsAndTheGivenRun() {
        val review = review()
        val now = LocalDateTime.now(seoul)
        run(review, "SUCCEEDED", now)
        val failed = review()
        run(failed, "FAILED", now)
        val unknown = review()
        val unknownRun = run(unknown, "UNKNOWN", now)
        val queued = review()
        val queuedRun = run(queued, "QUEUED", now)
        run(review(), "SUCCEEDED", month.startsAt.toLocalDateTime().minusSeconds(1))
        run(review(demoSeed = "combination-review-completed-v1"), "SUCCEEDED", now)

        val window = month
        assertEquals(3, repository.countJobs(ownerId, PlanUsageFeature.COMBINATION_REVIEW, window))
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.COMBINATION_REVIEW, window, PlanUsageJob.ReviewRun(queuedRun)))
        // 결과 불명이 만료돼 실패로 정리되면 별도 처리 없이 사용량에서 빠집니다.
        jdbc.update("UPDATE combination_review_run SET status = 'FAILED', failure_code = 'RUN_OUTCOME_UNKNOWN_EXPIRED' WHERE id = ?", unknownRun)
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.COMBINATION_REVIEW, window))
    }

    @Test
    fun countsDraftProgramsOnceAcrossAnalysisGenerationFilesAndSectionRuns() {
        val now = LocalDateTime.now(seoul)
        val preparation = preparations.create(ownerId, draft()).id
        val job = requireNotNull(generationJobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job)
        discovery("PBLN_000000000118979", "SUCCEEDED", now)
        discovery("PBLN_DISCOVERED", "SUCCEEDED", now)
        discovery("PBLN_FAILED", "FAILED", now)
        discovery("PBLN_LAST_MONTH", "SUCCEEDED", month.startsAt.toLocalDateTime().minusSeconds(1))
        val window = month

        // 같은 공고의 분석과 생성은 한 건이며, 실패한 분석과 지난달 분석은 세지 않습니다.
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, window))
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, window, PlanUsageJob.DocumentGeneration(job.id)))
        assertEquals(3, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, window,
            including = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_NEW")))
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, window,
            including = PlanUsageJob.DraftProgram("BIZINFO", "PBLN_DISCOVERED")))

        // 생성 작업이 실패해도 그 달에 만든 문서 파일과 문항별 AI 실행이 있으면 그 공고는 쓴 것입니다.
        val other = preparations.create(ownerId, draft()).id
        jdbc.update("UPDATE application_preparation SET source_program_id = 'PBLN_FILE_ONLY' WHERE id = ?", other)
        jdbc.update("""INSERT INTO application_document_file
            (preparation_id, input_revision, file_name, media_type, file_bytes, source_sha256, placements_json, created_at)
            VALUES (?, 1, 'draft.hwpx', 'application/octet-stream', X'00', ?, JSON_ARRAY(), ?)""", other, "a".repeat(64), now)
        val section = preparations.create(ownerId, draft()).id
        jdbc.update("UPDATE application_preparation SET source_program_id = 'PBLN_SECTION_ONLY' WHERE id = ?", section)
        jdbc.update("""INSERT INTO application_preparation_interpretation_run
            (preparation_id, section_key, input_revision, request_key, request_hash, run_status, input_json, started_at)
            VALUES (?, 'company-overview', 1, ?, ?, 'SUCCEEDED', JSON_OBJECT(), ?)""", section, UUID.randomUUID().toString(), "b".repeat(64), now)
        jdbc.update("""INSERT INTO application_preparation_draft_run
            (preparation_id, section_key, input_revision, request_key, run_status, input_json, started_at)
            VALUES (?, 'company-overview', 1, ?, 'FAILED', JSON_OBJECT(), ?)""", other, UUID.randomUUID().toString(), now)
        val demo = preparations.create(ownerId, draft()).id
        jdbc.update("UPDATE application_preparation SET source_program_id = 'PBLN_DEMO', demo_seed_key = 'demo-v1' WHERE id = ?", demo)
        jdbc.update("""INSERT INTO application_document_file
            (preparation_id, input_revision, file_name, media_type, file_bytes, source_sha256, placements_json, created_at)
            VALUES (?, 1, 'demo.hwpx', 'application/octet-stream', X'00', ?, JSON_ARRAY(), ?)""", demo, "c".repeat(64), now)

        assertEquals(4, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, window))
    }

    @Test
    fun programsWithoutAJobAreRecordedUnderTheAccountLockSoConcurrentNewProgramsStayWithinTheLimit() {
        // FREE 월 3건입니다. 작업 표를 남기지 않는 경로로 서로 다른 새 공고 6건이 동시에 와도 3건만 기록되고 나머지는 AI 전에 막힙니다.
        val pool = Executors.newFixedThreadPool(6)
        val accepted = try {
            (1..6).map { n ->
                pool.submit(Callable {
                    try {
                        planUsage.consumeDraftProgram(ownerId, "BIZINFO", "PBLN_RACE_$n") { true }
                    } catch (error: PlanQuotaExceededException) {
                        false
                    }
                })
            }.count { it.get(20, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }
        assertEquals(3, accepted)
        assertEquals(3, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, month))
        assertEquals(3, records())

        // 이번 달에 이미 센 공고는 한도에 다다랐어도 다시 할 수 있고 기록이 늘지 않습니다.
        val counted = requireNotNull(jdbc.queryForObject(
            "SELECT source_program_id FROM plan_usage_draft_program WHERE account_id = ? LIMIT 1", String::class.java, ownerId,
        ))
        assertEquals("again", planUsage.consumeDraftProgram(ownerId, "BIZINFO", counted) { "again" })
        assertEquals(3, records())
    }

    @Test
    fun aFailedActionRemovesOnlyTheRecordItLeftAndJobsOfTheSameProgramCountOnce() {
        discovery("PBLN_DISCOVERED", "SUCCEEDED", LocalDateTime.now(seoul))

        // 분석 작업으로 이미 센 공고는 기록하지 않습니다.
        planUsage.consumeDraftProgram(ownerId, "BIZINFO", "PBLN_DISCOVERED") { Unit }
        assertEquals(0, records())
        assertEquals(1, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, month))

        // 새 공고는 AI 전에 기록하고, 실행이 실패하면 그 기록을 지워 사용량을 돌려줍니다.
        assertThrows(IllegalStateException::class.java) {
            planUsage.consumeDraftProgram(ownerId, "BIZINFO", "PBLN_FAILED_AI") { throw IllegalStateException("model timeout") }
        }
        assertEquals(0, records())
        assertEquals(1, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, month))

        // 성공한 기록은 같은 공고의 생성 작업과 합쳐 한 건이고, 지난달 기록은 이번 달에 세지 않습니다.
        planUsage.consumeDraftProgram(ownerId, "BIZINFO", "PBLN_000000000118979") { Unit }
        val preparation = preparations.create(ownerId, draft()).id
        requireNotNull(generationJobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job)
        jdbc.update("""INSERT INTO plan_usage_draft_program (account_id, source_code, source_program_id, created_at)
            VALUES (?, 'BIZINFO', 'PBLN_LAST_MONTH', ?)""", ownerId, month.startsAt.toLocalDateTime().minusSeconds(1))
        assertEquals(2, repository.countJobs(ownerId, PlanUsageFeature.APPLICATION_DRAFT, month))
    }

    private fun records(): Int =
        requireNotNull(jdbc.queryForObject("SELECT COUNT(*) FROM plan_usage_draft_program WHERE account_id = ?", Int::class.java, ownerId))

    private fun used(feature: PlanUsageFeature, periodKey: String): Int =
        repository.findCounts(ownerId, listOf(periodKey))[feature to periodKey] ?: 0

    // 연결 풀에서는 LAST_INSERT_ID()가 다른 연결을 볼 수 있어 고유한 값으로 다시 찾습니다.
    private fun review(demoSeed: String? = null): Long {
        val title = "중복 검토 ${UUID.randomUUID()}"
        jdbc.update("""INSERT INTO combination_review (owner_account_id, demo_seed_key, title, created_at, updated_at)
            VALUES (?, ?, ?, NOW(6), NOW(6))""", ownerId, demoSeed, title)
        return requireNotNull(jdbc.queryForObject("SELECT id FROM combination_review WHERE title = ?", Long::class.java, title))
    }

    private fun run(reviewId: Long, status: String, startedAt: LocalDateTime): Long {
        val finished = status !in setOf("QUEUED", "RUNNING")
        val succeeded = status == "SUCCEEDED"
        val requestKey = UUID.randomUUID().toString()
        jdbc.update("""INSERT INTO combination_review_run
            (review_id, input_revision, request_key, request_hash, status, input_json, evidence_json, configuration_json,
             analysis_json, failure_code, runner_instance_id, started_at, finished_at)
            VALUES (?, 1, ?, ?, ?, JSON_OBJECT(), ?, ?, ?, ?, ?, ?, ?)""",
            reviewId, requestKey, "d".repeat(64), status,
            if (succeeded) "{}" else null, if (succeeded) "{}" else null, if (succeeded) "{}" else null,
            if (finished && !succeeded) "RUN_FAILED" else null, UUID.randomUUID().toString(), startedAt,
            if (finished) startedAt else null)
        return requireNotNull(jdbc.queryForObject(
            "SELECT id FROM combination_review_run WHERE review_id = ? AND request_key = ?", Long::class.java, reviewId, requestKey,
        ))
    }

    private fun discovery(programId: String, status: String, createdAt: LocalDateTime) {
        jdbc.update("""INSERT INTO application_form_discovery_job
            (owner_account_id, request_key, source_code, source_program_id, status, result_json, failure_code,
             created_at, started_at, finished_at, next_publish_at)
            VALUES (?, ?, 'BIZINFO', ?, ?, ?, ?, ?, ?, ?, ?)""",
            ownerId, UUID.randomUUID().toString(), programId, status,
            if (status == "SUCCEEDED") "{}" else null, if (status == "FAILED") "SOURCE_UNAVAILABLE" else null,
            createdAt, createdAt, createdAt, createdAt)
    }

    private fun draft() = NewApplicationPreparation("BIZINFO", "PBLN_000000000118979",
        "bizinfo-pbln-000000000118979-innovation-voucher-2026-v1", ApplicationServiceField.TECHNICAL_SUPPORT)
}
