package ai.govbiz.core.applicationpreparation.repository

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationJobStatus
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentGenerationStage
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.domain.NewApplicationPreparation
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationRunConflictException
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMappingChangeResult
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentMigrationNoticeResult
import java.time.LocalDateTime
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.context.annotation.Import
import org.springframework.dao.DataAccessException
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.support.TransactionTemplate

/** 실제 MySQL 8.4에서 생성 작업의 접수 규칙(요청 키 재사용·준비 건당 하나·계정당 3개)과 상태 전이를 확인한다. */
@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1",
    "app.bizinfo.sync.enabled=false",
    "app.support-program-index.enabled=false",
    "app.application-document.jobs.enabled=false",
])
@Import(MySqlTestContainerConfig::class)
class ApplicationDocumentGenerationJobRepositoryIntegrationTest {
    @Autowired private lateinit var jobs: ApplicationDocumentGenerationJobRepository
    @Autowired private lateinit var preparations: ApplicationPreparationRepository
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var transactions: PlatformTransactionManager
    private var ownerId = 0L
    private var otherId = 0L

    @BeforeEach
    fun prepare() {
        jdbc.update("DELETE FROM application_document_generation_job")
        jdbc.update("DELETE FROM application_preparation")
        ownerId = createAccount()
        otherId = createAccount()
    }

    @Test
    fun reusesTheSameRequestKeyAndAllowsOneActiveJobPerPreparationAndThreePerAccount() {
        val preparation = preparations.create(ownerId, draft()).id
        val key = UUID.randomUUID().toString()
        val first = requireNotNull(jobs.reserve(ownerId, key, preparation, 1).job)
        assertEquals(ApplicationDocumentGenerationJobStatus.QUEUED, first.status)
        assertEquals(first, jobs.reserve(ownerId, key, preparation, 1).job)
        // 같은 키를 다른 준비 건·버전에 쓰면 충돌이고, 다른 키라도 준비 건에 진행 중인 작업이 있으면 충돌이다.
        assertThrows(ApplicationPreparationRunConflictException::class.java) { jobs.reserve(ownerId, key, preparation, 2) }
        assertThrows(ApplicationPreparationRunConflictException::class.java) { jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1) }
        assertThrows(DataAccessException::class.java) {
            jdbc.update("INSERT INTO application_document_generation_job (owner_account_id, preparation_id, request_key, expected_revision, created_at) VALUES (?, ?, ?, 1, NOW(6))",
                ownerId, preparation, UUID.randomUUID().toString())
        }
        val second = preparations.create(ownerId, draft()).id
        val third = preparations.create(ownerId, draft()).id
        val fourth = preparations.create(ownerId, draft()).id
        jobs.reserve(ownerId, UUID.randomUUID().toString(), second, 1)
        jobs.reserve(ownerId, UUID.randomUUID().toString(), third, 1)
        assertTrue(jobs.reserve(ownerId, UUID.randomUUID().toString(), fourth, 1).capacityExceeded)
        assertNull(jobs.findOwned(otherId, preparation, first.id))
        assertEquals(listOf(first.id), jobs.listOwned(ownerId, preparation).map { it.id })
        assertThrows(ApplicationPreparationNotFoundException::class.java) { jobs.reserve(Long.MAX_VALUE, UUID.randomUUID().toString(), preparation, 1) }
    }

    @Test
    fun recordsStagesResultsAndFailureDetailsAndReleasesTheActiveSlot() {
        val preparation = preparations.create(ownerId, draft()).id
        val job = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job)
        assertEquals(listOf(job.id), jobs.claimable(10))
        val claimed = requireNotNull(jobs.claim(job.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.RUNNING, claimed.status)
        assertEquals(ApplicationDocumentGenerationStage.PREPARING, claimed.stage)
        assertNull(jobs.claim(job.id))
        assertTrue(jobs.updateStage(job.id, ApplicationDocumentGenerationStage.WRITING))
        assertTrue(jobs.beginAi(job.id))
        assertFalse(jobs.beginAi(job.id))
        jobs.succeed(job.id, listOf(7L, 9L))
        val done = requireNotNull(jobs.findOwned(ownerId, preparation, job.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.SUCCEEDED, done.status)
        assertEquals(listOf(7L, 9L), done.fileIds)
        assertEquals(ApplicationDocumentGenerationStage.WRITING, done.stage)
        // 끝난 작업은 활성 슬롯을 비워 같은 준비 건에 새 작업을 받을 수 있다.
        val next = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 2).job)
        requireNotNull(jobs.claim(next.id))
        val notice = ApplicationDocumentMigrationNoticeResult("11111111-2222-3333-4444-555555555555", 2,
            changes = listOf(ApplicationDocumentMappingChangeResult("기업 개요 / 업체명", "TARGET_CHANGED", "p1", "p2")))
        jobs.fail(next.id, "APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", "입력 위치가 변경됐습니다.", detail = notice)
        val failed = requireNotNull(jobs.findOwned(ownerId, preparation, next.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.FAILED, failed.status)
        assertEquals("입력 위치가 변경됐습니다.", failed.failureMessage)
        assertEquals(notice, jobs.failureDetail(ownerId, preparation, next.id, ApplicationDocumentMigrationNoticeResult::class.java))
        assertNull(jobs.failureDetail(otherId, preparation, next.id, ApplicationDocumentMigrationNoticeResult::class.java))
        val unknown = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 3).job)
        requireNotNull(jobs.claim(unknown.id))
        jobs.fail(unknown.id, "RUN_OUTCOME_UNKNOWN", "결과 불명", unknown = true)
        assertEquals(ApplicationDocumentGenerationJobStatus.UNKNOWN, requireNotNull(jobs.findOwned(ownerId, preparation, unknown.id)).status)
        // 결과 불명은 활성 슬롯을 유지해 같은 준비 건의 새 작업을 막는다(사람이 확인할 때까지).
        assertThrows(ApplicationPreparationRunConflictException::class.java) { jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 3) }
    }

    @Test
    fun expiresStaleQueuedAndRunningJobs() {
        val queued = preparations.create(ownerId, draft()).id
        val running = preparations.create(ownerId, draft()).id
        val interrupted = preparations.create(ownerId, draft()).id
        val queuedJob = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), queued, 1).job)
        val runningJob = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), running, 1).job)
        val interruptedJob = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), interrupted, 1).job)
        requireNotNull(jobs.claim(runningJob.id))
        requireNotNull(jobs.claim(interruptedJob.id))
        assertTrue(jobs.beginAi(runningJob.id))
        jdbc.update("UPDATE application_document_generation_job SET created_at = DATE_SUB(created_at, INTERVAL 2 HOUR) WHERE id = ?", queuedJob.id)
        jdbc.update("UPDATE application_document_generation_job SET started_at = DATE_SUB(started_at, INTERVAL 31 MINUTE) WHERE id IN (?, ?)",
            runningJob.id, interruptedJob.id)
        jobs.expireStaleWork(java.time.Duration.ofHours(24))
        // 유료 AI 호출 전에 멈춘 실행(재시작 등)은 결과가 없으니 바로 실패로 끝내 활성 슬롯을 비운다.
        val expiredInterrupted = requireNotNull(jobs.findOwned(ownerId, interrupted, interruptedJob.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.FAILED, expiredInterrupted.status)
        assertEquals("RUN_INTERRUPTED", expiredInterrupted.failureCode)
        val retried = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), interrupted, 1).job)
        val expiredQueued = requireNotNull(jobs.findOwned(ownerId, queued, queuedJob.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.FAILED, expiredQueued.status)
        assertEquals("QUEUE_EXPIRED", expiredQueued.failureCode)
        val expiredRunning = requireNotNull(jobs.findOwned(ownerId, running, runningJob.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.UNKNOWN, expiredRunning.status)
        assertEquals("RUN_OUTCOME_UNKNOWN", expiredRunning.failureCode)
        // 만료된 작업은 다시 집히지 않고, 끊긴 준비 건에 새로 접수한 작업만 실행 대상이다.
        assertEquals(listOf(retried.id), jobs.claimable(10))
        // 결과 불명은 TTL이 지나면 실패로 내려가 준비 건의 활성 슬롯을 비운다.
        jdbc.update("UPDATE application_document_generation_job SET finished_at = DATE_SUB(finished_at, INTERVAL 25 HOUR) WHERE id = ?", runningJob.id)
        jobs.expireStaleWork(java.time.Duration.ofHours(24))
        assertEquals("RUN_OUTCOME_UNKNOWN_EXPIRED", requireNotNull(jobs.findOwned(ownerId, running, runningJob.id)).failureCode)
        assertEquals(ApplicationDocumentGenerationJobStatus.FAILED, requireNotNull(jobs.findOwned(ownerId, running, runningJob.id)).status)
        requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), running, 1).job)
        // 준비 건을 지우면 작업 기록도 함께 사라진다.
        jdbc.update("DELETE FROM application_preparation WHERE id = ?", queued)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_generation_job WHERE preparation_id = ?", Int::class.java, queued))
    }

    @ParameterizedTest
    @ValueSource(strings = ["QUEUED", "RUNNING", "UNKNOWN"])
    fun deletionPreservesPreparationAndActiveJob(status: String) {
        val preparation = preparations.create(ownerId, draft())
        val job = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation.id, 1).job)
        if (status != "QUEUED") requireNotNull(jobs.claim(job.id))
        if (status == "UNKNOWN") jobs.fail(job.id, "RUN_OUTCOME_UNKNOWN", "결과 불명", unknown = true)
        assertFalse(preparations.deleteOwned(otherId, preparation.id))
        assertThrows(ApplicationPreparationRunConflictException::class.java) { preparations.deleteOwned(ownerId, preparation.id) }
        assertEquals(preparation, preparations.findOwned(ownerId, preparation.id))
        assertEquals(ApplicationDocumentGenerationJobStatus.valueOf(status), requireNotNull(jobs.findOwned(ownerId, preparation.id, job.id)).status)
    }

    @ParameterizedTest
    @ValueSource(strings = ["SUCCEEDED", "FAILED"])
    fun deletionCascadesOnlyFinishedJobs(status: String) {
        val preparation = preparations.create(ownerId, draft()).id
        val job = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job)
        requireNotNull(jobs.claim(job.id))
        if (status == "SUCCEEDED") jobs.succeed(job.id, emptyList()) else jobs.fail(job.id, "GENERATION_FAILED", "생성 실패")
        assertTrue(preparations.deleteOwned(ownerId, preparation))
        assertNull(preparations.findOwned(ownerId, preparation))
        assertNull(jobs.findOwned(ownerId, preparation, job.id))
    }

    @Test
    fun reservationCommittingFirstPreventsConcurrentDeletion() {
        val preparation = preparations.create(ownerId, draft()).id
        val reserved = CountDownLatch(1)
        val release = CountDownLatch(1)
        val deleting = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val reservation = pool.submit<Long> {
                TransactionTemplate(transactions).execute {
                    val job = requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job)
                    reserved.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    job.id
                }!!
            }
            assertTrue(reserved.await(10, TimeUnit.SECONDS))
            val deletion = pool.submit<Boolean> { deleting.countDown(); preparations.deleteOwned(ownerId, preparation) }
            assertTrue(deleting.await(10, TimeUnit.SECONDS))
            assertThrows(TimeoutException::class.java) { deletion.get(200, TimeUnit.MILLISECONDS) }
            release.countDown()
            val jobId = reservation.get(10, TimeUnit.SECONDS)
            val failure = assertThrows(ExecutionException::class.java) { deletion.get(10, TimeUnit.SECONDS) }
            assertTrue(failure.cause is ApplicationPreparationRunConflictException)
            assertTrue(preparations.findOwned(ownerId, preparation) != null)
            assertEquals(ApplicationDocumentGenerationJobStatus.QUEUED, requireNotNull(jobs.findOwned(ownerId, preparation, jobId)).status)
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun deletionCommittingFirstMakesConcurrentReservationNotFound() {
        val preparation = preparations.create(ownerId, draft()).id
        val deleted = CountDownLatch(1)
        val release = CountDownLatch(1)
        val reserving = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val deletion = pool.submit<Boolean> {
                TransactionTemplate(transactions).execute {
                    val result = preparations.deleteOwned(ownerId, preparation)
                    deleted.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    result
                }!!
            }
            assertTrue(deleted.await(10, TimeUnit.SECONDS))
            val reservation = pool.submit<Long> {
                reserving.countDown()
                requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job).id
            }
            assertTrue(reserving.await(10, TimeUnit.SECONDS))
            assertThrows(TimeoutException::class.java) { reservation.get(200, TimeUnit.MILLISECONDS) }
            release.countDown()
            assertTrue(deletion.get(10, TimeUnit.SECONDS))
            val failure = assertThrows(ExecutionException::class.java) { reservation.get(10, TimeUnit.SECONDS) }
            assertTrue(failure.cause is ApplicationPreparationNotFoundException)
            assertNull(preparations.findOwned(ownerId, preparation))
            assertTrue(jobs.listOwned(ownerId, preparation).isEmpty())
        } finally {
            release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun deletionReadsTheLatestJobEvenWithAnOlderRepeatableReadSnapshot() {
        val preparation = preparations.create(ownerId, draft()).id
        val pool = Executors.newSingleThreadExecutor()
        try {
            assertThrows(ApplicationPreparationRunConflictException::class.java) {
                TransactionTemplate(transactions).execute {
                    // 먼저 일반 조회로 작업이 없던 시점의 MySQL REPEATABLE READ snapshot을 만든다.
                    assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM application_document_generation_job WHERE preparation_id = ?", Int::class.java, preparation))
                    pool.submit<Long> { requireNotNull(jobs.reserve(ownerId, UUID.randomUUID().toString(), preparation, 1).job).id }
                        .get(10, TimeUnit.SECONDS)
                    preparations.deleteOwned(ownerId, preparation)
                }
            }
            assertTrue(preparations.findOwned(ownerId, preparation) != null)
            assertEquals(1, jobs.listOwned(ownerId, preparation).size)
        } finally { pool.shutdownNow() }
    }

    private fun createAccount(): Long = accounts.createAccount(
        NewAccount("document-job-${UUID.randomUUID()}@example.test", "test-password-hash", LocalDateTime.of(2026, 9, 30, 0, 0)),
    ).id

    private fun draft() = NewApplicationPreparation("BIZINFO", "PBLN_000000000118979",
        "bizinfo-pbln-000000000118979-innovation-voucher-2026-v1", ApplicationServiceField.TECHNICAL_SUPPORT)
}
