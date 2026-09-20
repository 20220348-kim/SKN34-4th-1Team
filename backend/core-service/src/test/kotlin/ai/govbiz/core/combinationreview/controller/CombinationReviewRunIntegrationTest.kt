package ai.govbiz.core.combinationreview.controller

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.account.domain.NewAccount
import ai.govbiz.core.account.helper.SessionCookieHelper
import ai.govbiz.core.account.repository.AccountRepository
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.domain.exception.CombinationReviewRunConflictException
import ai.govbiz.core.combinationreview.helper.CombinationReviewHashHelper
import ai.govbiz.core.combinationreview.repository.CombinationReviewRepository
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import ai.govbiz.core.combinationreview.service.exception.*
import ai.govbiz.core.combinationreview.service.CombinationReviewRunService
import ai.govbiz.core.combinationreview.service.CombinationReviewOutboxScheduler
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachment
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachments
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.detail.exception.SupportProgramNotFoundException
import jakarta.servlet.http.Cookie
import java.io.ByteArrayOutputStream
import java.time.LocalDateTime
import java.util.UUID
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc
import org.springframework.context.annotation.Import
import org.springframework.dao.DuplicateKeyException
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.mockito.MockitoBean
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.transaction.support.TransactionSynchronizationManager
import tools.jackson.databind.ObjectMapper

@SpringBootTest(properties = [
    "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
    "app.ai-service.base-url=http://127.0.0.1:1", "app.ai-service.connect-timeout=10ms", "app.ai-service.read-timeout=10ms",
    "app.combination-review.queue.enabled=true", "spring.rabbitmq.listener.simple.auto-startup=false",
    "app.bizinfo.sync.enabled=false", "app.support-program-index.enabled=false", "app.account.cookie-secure=false",
])
@AutoConfigureMockMvc
@Import(MySqlTestContainerConfig::class)
class CombinationReviewRunIntegrationTest {
    @Autowired private lateinit var mvc: MockMvc
    @Autowired private lateinit var jdbc: JdbcTemplate
    @Autowired private lateinit var json: ObjectMapper
    @Autowired private lateinit var accounts: AccountRepository
    @Autowired private lateinit var sessions: AccountSessionService
    @Autowired private lateinit var reviews: CombinationReviewRepository
    @Autowired private lateinit var runs: CombinationReviewRunRepository
    @Autowired private lateinit var service: CombinationReviewRunService
    @MockitoBean private lateinit var publisher: CombinationReviewOutboxScheduler
    @Autowired private lateinit var admission: SupportProgramRequestAdmissionService
    @MockitoBean private lateinit var source: BizInfoAttachmentClient
    @MockitoBean private lateinit var msitSource: MsitAttachmentClient
    @MockitoBean private lateinit var kStartupSource: KStartupAttachmentClient
    @MockitoBean private lateinit var cnTradeNoticeSource: CnTradeNoticeAttachmentClient
    @MockitoBean private lateinit var programDetails: SupportProgramDetailService
    @MockitoBean private lateinit var ai: AiCombinationReviewClient
    private var ownerId = 0L
    private var otherId = 0L
    private var reviewId = 0L
    private lateinit var owner: Cookie
    private lateinit var other: Cookie
    private lateinit var answer: AiCombinationReviewPayload
    private lateinit var request: AiCombinationReviewRequest
    private lateinit var general: ByteArray
    private lateinit var deep: ByteArray
    private val g = ReviewProgramIdentity("BIZINFO", "PBLN_000000000117820")
    private val d = ReviewProgramIdentity("BIZINFO", "PBLN_000000000117172")
    private val draft get() = CombinationReviewDraft("처음 검토", CombinationReviewInput(listOf(SelectedReviewProgram(g), SelectedReviewProgram(d))))
    private val path get() = "/api/v1/combination-reviews/$reviewId/runs"

    @BeforeEach
    fun prepare() {
        jdbc.update("DELETE FROM combination_review")
        val first = session(); ownerId = first.first; owner = first.second
        val second = session(); otherId = second.first; other = second.second
        reviewId = reviews.create(ownerId, draft).id
        general = resource("general.hwpx"); deep = resource("deeptech.hwpx")
        answer = json.readValue(resource("contract-response.json"), AiCombinationReviewPayload::class.java)
        request = json.readValue(resource("contract-request.json"), AiCombinationReviewRequest::class.java)
        `when`(source.collect(g.sourceCode, g.sourceProgramId)).thenAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            fetched(general, "general.hwpx")
        }
        `when`(source.collect(d.sourceCode, d.sourceProgramId)).thenReturn(fetched(deep, "deeptech.hwpx"))
        `when`(ai.configuration()).thenReturn(AiReviewConfigurationPayload(answer.contractVersion, answer.model, answer.promptVersion))
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            answer
        }
    }

    @Test
    fun busySharedAiSlotsKeepTheJobQueuedUntilCapacityReturns() {
        val runId = id(submit().andExpect(status().isAccepted()))
        fun occupy(remaining: Int) {
            if (remaining == 0) { service.executeQueued(runId); return }
            admission.executeBackground { occupy(remaining - 1) }
        }
        occupy(4)
        assertEquals(ReviewRunStatus.QUEUED, runs.findOwned(ownerId, reviewId, runId)!!.status)
        verifyNoInteractions(source, ai)
        service.executeQueued(runId)
        assertEquals(ReviewRunStatus.SUCCEEDED, runs.findOwned(ownerId, reviewId, runId)!!.status)
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun acceptsWithoutCallingSourcesAndReplaysTheSameQueuedSnapshot() {
        val key = UUID.randomUUID().toString()
        val submitted = submit(key).andExpect(status().isAccepted())
            .andExpect(jsonPath("$.status").value("QUEUED"))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
        val runId = id(submitted)
        assertNotNull(jdbc.queryForObject("SELECT next_publish_at FROM combination_review_run WHERE id = ?", LocalDateTime::class.java, runId))
        assertNotNull(jdbc.queryForObject("SELECT queue_expires_at FROM combination_review_run WHERE id = ?", LocalDateTime::class.java, runId))
        repeat(8) { submit(key).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(runId)) }
        submit().andExpect(status().isConflict())
        verifyNoInteractions(source, ai)
        reviews.replaceOwned(ownerId, reviewId, 1, draft.copy(title = "접수 후 변경"))
        service.executeQueued(runId)
        service.executeQueued(runId)
        mvc.perform(get("$path/$runId").cookie(owner)).andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("SUCCEEDED")).andExpect(jsonPath("$.input.title").value("처음 검토"))
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun accountCanReserveOnlyThreePendingReviewsAndOtherAccountsAreIndependent() {
        repeat(3) {
            reviewId = reviews.create(ownerId, draft).id
            submit().andExpect(status().isAccepted())
        }
        reviewId = reviews.create(ownerId, draft).id
        submit().andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("RUN_CAPACITY_EXCEEDED"))
        reviewId = reviews.create(otherId, draft).id
        submit(cookie = other).andExpect(status().isAccepted())
        verifyNoInteractions(source, ai)
    }

    @Test
    fun expiredQueuedWorkAndSuspendedOwnersNeverReachAi() {
        val expired = id(submit().andExpect(status().isAccepted()))
        jdbc.update("UPDATE combination_review_run SET queue_expires_at = '2000-01-01' WHERE id = ?", expired)
        service.executeQueued(expired)
        runs.expireStaleWork()
        assertEquals("QUEUE_EXPIRED", runs.findOwned(ownerId, reviewId, expired)!!.failureCode)
        val suspended = id(submit().andExpect(status().isAccepted()))
        jdbc.update("UPDATE account SET suspended_at = NOW() WHERE id = ?", ownerId)
        service.executeQueued(suspended)
        runs.expireStaleWork()
        assertEquals("ACCOUNT_INACTIVE", runs.findOwned(ownerId, reviewId, suspended)!!.failureCode)
        verifyNoInteractions(source, ai)
    }

    @Test
    fun timedOutExecutionBlocksNewWorkAndRejectsLateCompletionAndRedelivery() {
        val runId = id(submit().andExpect(status().isAccepted()))
        assertNotNull(runs.claim(runId, UUID.randomUUID().toString()))
        jdbc.update("UPDATE combination_review_run SET execution_started_at = '2000-01-01' WHERE id = ?", runId)
        runs.expireStaleWork()
        assertEquals(ReviewRunStatus.UNKNOWN, runs.findOwned(ownerId, reviewId, runId)!!.status)
        service.executeQueued(runId)
        runs.fail(runId, "LATE_FAILURE")
        assertEquals(ReviewRunStatus.UNKNOWN, runs.findOwned(ownerId, reviewId, runId)!!.status)
        submit().andExpect(status().isConflict())
        verifyNoInteractions(source, ai)
    }

    @Test
    fun deletedQueuedReviewCannotBeExecuted() {
        val runId = id(submit().andExpect(status().isAccepted()))
        assertTrue(reviews.deleteOwned(ownerId, reviewId))
        service.executeQueued(runId)
        assertFalse(runs.publishable().contains(runId))
        verifyNoInteractions(source, ai)
    }

    @Test
    fun rejectsALegacyThreeProgramReviewBeforeCreatingAnAnalysisRun() {
        jdbc.update(
            """INSERT INTO combination_review_program
                (review_id, position, source_code, source_program_id, sub_program_id,
                 application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received)
                SELECT review_id, 2, source_code, CONCAT(source_program_id, '-legacy'), sub_program_id,
                       application_submitted, selected, commitment_submitted, agreement_signed, execution_status, funding_received
                FROM combination_review_program WHERE review_id = ? AND position = 0""",
            reviewId,
        )

        start().andExpect(status().isUnprocessableContent())
            .andExpect(jsonPath("$.code").value("INPUT_PROGRAM_COUNT_UNSUPPORTED"))
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run WHERE review_id = ?", Int::class.java, reviewId))
    }

    @Test
    fun executesThroughAuthenticatedHttpParserServiceAndRealMysqlAndDownloadsOwnedOriginalBytes() {
        val result = start().andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.status").value("SUCCEEDED"))
            .andExpect(jsonPath("$.inputRevision").value(1))
            .andExpect(jsonPath("$.evidence.reviewStatus").value("AUTOMATIC_UNREVIEWED"))
            .andExpect(jsonPath("$.evidence.documents[0].sourcePageUrl").value(BIZINFO_PAGE_URL))
            .andExpect(jsonPath("$.configuration.model").value("test-model"))
            .andExpect(jsonPath("$.analysis.pairs[0].stages.length()").value(6)).andReturn().response
        val id = json.readTree(result.contentAsString).path("id").asLong()
        mvc.perform(get("$path/$id").cookie(owner)).andExpect(status().isOk()).andExpect(content().json(result.contentAsString))
        mvc.perform(get("$path/$id/sources/0").cookie(owner)).andExpect(status().isOk())
            .andExpect(content().bytes(general)).andExpect(header().string("X-Content-Type-Options", "nosniff"))
        mvc.perform(get(path).cookie(owner)).andExpect(status().isOk()).andExpect(jsonPath("$.items[0].id").value(id))
            .andExpect(jsonPath("$.items[0].input").doesNotExist())
        val stored = requireNotNull(runs.findOwned(ownerId, reviewId, id))
        assertEquals(CombinationReviewHashHelper.sha256(general), stored.evidence!!.documents.first().rawHash)
        assertTrue(stored.evidence.blocks.any { it.text.contains("글로벌기업 협업 프로그램") })
    }

    @Test
    fun collectsMsitOfficialAttachmentsThroughTheCatalogIdentityOutsideTransactions() {
        val msit = ReviewProgramIdentity("MSIT", "3186573")
        val sourceUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&mId=311&mPid=121&nttSeqNo=${msit.sourceProgramId}&sCode=user"
        val attachmentUrl = "https://www.msit.go.kr/ssm/file/fileDown.do?atchFileNo=52935&fileOrd=6&fileBtn=A"
        reviewId = reviews.create(
            ownerId,
            CombinationReviewDraft("과기정통부 포함 검토", CombinationReviewInput(listOf(SelectedReviewProgram(g), SelectedReviewProgram(msit)))),
        ).id
        `when`(programDetails.get(msit.sourceCode, msit.sourceProgramId)).thenAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            supportProgram(msit, sourceUrl)
        }
        `when`(msitSource.collect(msit.sourceCode, msit.sourceProgramId, sourceUrl)).thenAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            fetched(deep, "과기정통부-공고.hwpx", attachmentUrl, sourceUrl)
        }

        val runId = id(start().andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("SUCCEEDED"))
            .andExpect(jsonPath("$.evidence.documents[1].programIndex").value(1))
            .andExpect(jsonPath("$.evidence.documents[1].sourceUrl").value(attachmentUrl))
            .andExpect(jsonPath("$.evidence.documents[1].sourcePageUrl").value(sourceUrl)))

        val stored = requireNotNull(runs.findOwned(ownerId, reviewId, runId))
        assertEquals(listOf(0, 1), stored.evidence!!.documents.map { it.programIndex })
        verify(source).collect(g.sourceCode, g.sourceProgramId)
        verify(programDetails).get(msit.sourceCode, msit.sourceProgramId)
        verify(msitSource).collect(msit.sourceCode, msit.sourceProgramId, sourceUrl)
    }

    @Test
    fun collectsKStartupAndCnTradeAttachmentsThroughTheSameReviewFlow() {
        val kStartup = ReviewProgramIdentity("KSTARTUP", "177911")
        val cnTrade = ReviewProgramIdentity("CNTRADE_NOTICE", "3862")
        val kStartupUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=177911&schM=view"
        val cnTradeUrl = "https://cntrade.chungnam.go.kr/home/kor/M102638244/board.do"
        reviewId = reviews.create(
            ownerId,
            CombinationReviewDraft("두 신규 제공처 검토", CombinationReviewInput(listOf(SelectedReviewProgram(kStartup), SelectedReviewProgram(cnTrade)))),
        ).id
        val kStartupProgram = supportProgram(kStartup, kStartupUrl)
        val cnTradeProgram = supportProgram(cnTrade, cnTradeUrl).copy(targetDescription = "충남 공식 본문")
        `when`(programDetails.get(kStartup.sourceCode, kStartup.sourceProgramId)).thenReturn(kStartupProgram)
        `when`(programDetails.get(cnTrade.sourceCode, cnTrade.sourceProgramId)).thenReturn(cnTradeProgram)
        `when`(kStartupSource.collect(kStartup.sourceCode, kStartup.sourceProgramId, kStartupUrl))
            .thenReturn(fetched(general, "K-Startup-신청서.hwpx", sourcePageUrl = kStartupUrl))
        `when`(cnTradeNoticeSource.collect(cnTrade.sourceCode, cnTrade.sourceProgramId, cnTradeProgram.title, cnTradeProgram.targetDescription))
            .thenReturn(fetched(deep, "충남-신청서.hwpx", sourcePageUrl = cnTradeUrl))

        val runId = id(start().andExpect(status().isOk())
            .andExpect(jsonPath("$.status").value("SUCCEEDED"))
            .andExpect(jsonPath("$.evidence.documents[0].programIndex").value(0))
            .andExpect(jsonPath("$.evidence.documents[1].programIndex").value(1)))

        assertEquals(listOf(0, 1), requireNotNull(runs.findOwned(ownerId, reviewId, runId)).evidence!!.documents.map { it.programIndex })
        verify(kStartupSource).collect(kStartup.sourceCode, kStartup.sourceProgramId, kStartupUrl)
        verify(cnTradeNoticeSource).collect(cnTrade.sourceCode, cnTrade.sourceProgramId, cnTradeProgram.title, cnTradeProgram.targetDescription)
    }

    @Test
    fun missingMsitCatalogIdentityFailsAsSourceNotFoundBeforeAttachmentOrAiCalls() {
        val msit = ReviewProgramIdentity("MSIT", "3186573")
        reviewId = reviews.create(
            ownerId,
            CombinationReviewDraft("과기정통부 누락 검토", CombinationReviewInput(listOf(SelectedReviewProgram(g), SelectedReviewProgram(msit)))),
        ).id
        `when`(programDetails.get(msit.sourceCode, msit.sourceProgramId)).thenThrow(SupportProgramNotFoundException())

        val response = start().andExpect(status().isOk())
            .andExpect(jsonPath("$.failureCode").value("SOURCE_NOT_FOUND")).andReturn().response

        val runId = json.readTree(response.contentAsString).path("id").asLong()
        assertEquals(ReviewRunStatus.FAILED, runs.findOwned(ownerId, reviewId, runId)!!.status)
        verifyNoInteractions(msitSource)
        verifyNoInteractions(ai)
    }

    @Test
    fun rejectsMoreThanTwelveCollectedDocumentsWithoutPartialAnalysis() {
        val first = ReviewProgramIdentity("MSIT", "3186573")
        val second = ReviewProgramIdentity("MSIT", "3186574")
        reviewId = reviews.create(
            ownerId,
            CombinationReviewDraft("원본 한도 검토", CombinationReviewInput(listOf(SelectedReviewProgram(first), SelectedReviewProgram(second)))),
        ).id
        listOf(first, second).forEach { identity ->
            val sourceUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&nttSeqNo=${identity.sourceProgramId}"
            `when`(programDetails.get(identity.sourceCode, identity.sourceProgramId)).thenReturn(supportProgram(identity, sourceUrl))
            `when`(msitSource.collect(identity.sourceCode, identity.sourceProgramId, sourceUrl)).thenReturn(
                SupportProgramAttachments(
                    "과기정통부 공고",
                    (1..8).map { index ->
                        SupportProgramAttachment(
                            "https://www.msit.go.kr/ssm/file/fileDown.do?atchFileNo=${identity.sourceProgramId}&fileOrd=$index&fileBtn=A",
                            "첨부-$index.hwpx",
                            "HWPX",
                            general,
                        )
                    },
                    emptyList(),
                ),
            )
        }

        val response = start().andExpect(status().isOk())
            .andExpect(jsonPath("$.failureCode").value("SOURCE_TOO_LARGE")).andReturn().response

        val runId = json.readTree(response.contentAsString).path("id").asLong()
        assertEquals(ReviewRunStatus.FAILED, runs.findOwned(ownerId, reviewId, runId)!!.status)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run_source WHERE run_id = ?", Int::class.java, runId))
        verifyNoInteractions(ai)
    }

    @Test
    fun skipsUnreadableAttachmentWhenTheSameProgramHasAUsableOfficialDocument() {
        val blankPdf = blankPdf()
        `when`(source.collect(g.sourceCode, g.sourceProgramId)).thenReturn(SupportProgramAttachments(
            "공식 공고",
            listOf(
                SupportProgramAttachment("https://www.mss.go.kr/general.hwpx", "공고문.hwpx", "HWPX", general),
                SupportProgramAttachment("https://www.mss.go.kr/appendix.pdf", "이미지형 붙임.pdf", "PDF", blankPdf),
            ),
            emptyList(),
        ))

        val runId = id(start().andExpect(status().isOk()).andExpect(jsonPath("$.status").value("SUCCEEDED")))
        val stored = requireNotNull(runs.findOwned(ownerId, reviewId, runId))
        assertEquals(2, stored.evidence!!.documents.size)
        assertTrue(stored.evidence.coverageWarnings.any {
            it.contains("SOURCE_UNSUPPORTED") && it.contains("이미지형 붙임.pdf")
        })
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run_source WHERE run_id = ?", Int::class.java, runId))
    }

    @Test
    fun failsWhenAProgramHasNoUsableOfficialDocument() {
        `when`(source.collect(g.sourceCode, g.sourceProgramId)).thenReturn(SupportProgramAttachments(
            "공식 공고",
            listOf(SupportProgramAttachment("https://www.mss.go.kr/appendix.pdf", "이미지형 붙임.pdf", "PDF", blankPdf())),
            emptyList(),
        ))

        val response = start().andExpect(status().isOk())
            .andExpect(jsonPath("$.failureCode").value("SOURCE_UNSUPPORTED")).andReturn().response
        val runId = json.readTree(response.contentAsString).path("id").asLong()
        assertEquals(ReviewRunStatus.FAILED, runs.findOwned(ownerId, reviewId, runId)!!.status)
        verifyNoInteractions(ai)
    }

    @Test
    fun replayDoesNotCallAiAgainEvenAfterInputRevisionChangedAndDifferentPayloadConflicts() {
        val key = UUID.randomUUID().toString()
        val id = id(start(key = key).andExpect(status().isOk()))
        reviews.replaceOwned(ownerId, reviewId, 1, draft.copy(title = "새 입력"))
        start(key = key).andExpect(status().isOk()).andExpect(jsonPath("$.id").value(id)).andExpect(jsonPath("$.inputRevision").value(1))
        start(key = key, facts = "다른 내용").andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_RUN_CONFLICT"))
        start().andExpect(status().isConflict()).andExpect(jsonPath("$.code").value("COMBINATION_REVIEW_REVISION_CONFLICT"))
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun inputEditsDuringAiCallDoNotOverwriteHistoricalSnapshotOrResult() {
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenAnswer {
            assertFalse(TransactionSynchronizationManager.isActualTransactionActive())
            assertTrue(reviews.replaceOwned(ownerId, reviewId, 1, draft.copy(title = "분석 중 수정")))
            answer
        }
        val id = id(start().andExpect(status().isOk()).andExpect(jsonPath("$.input.title").value("처음 검토")))
        assertEquals(1L, runs.findOwned(ownerId, reviewId, id)!!.inputRevision)
        assertEquals(2L, reviews.findOwned(ownerId, reviewId)!!.inputRevision)
        assertEquals("분석 중 수정", reviews.findOwned(ownerId, reviewId)!!.draft.title)
    }

    @Test
    fun aiFailurePersistsEvidenceAndMetadataAndSameKeyDoesNotRetry() {
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenThrow(AiServiceCallException.unavailable(null))
        val key = UUID.randomUUID().toString()
        val failure = start(key = key).andExpect(status().isOk()).andExpect(jsonPath("$.failureCode").value("RUN_OUTCOME_UNKNOWN")).andReturn().response
        val id = json.readTree(failure.contentAsString).path("id").asLong()
        mvc.perform(get("$path/$id").cookie(owner)).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UNKNOWN"))
            .andExpect(jsonPath("$.analysis").isEmpty()).andExpect(jsonPath("$.evidence.documents.length()").value(2))
        start(key = key).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("UNKNOWN"))
        start().andExpect(status().isConflict())
        verify(ai, times(1)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
        assertArrayEquals(general, runs.findSource(ownerId, reviewId, id, 0))
    }

    @Test
    fun invalidCitationDoesNotBecomeASuccessfulAnalysis() {
        val first = answer.pairs.first()
        answer = answer.copy(pairs = listOf(first.copy(stages = first.stages.mapIndexed { i, s ->
            if (i == 0) s.copy(citations = listOf(AiReviewCitationPayload("E0", "조작된 존재하지 않는 인용"))) else s
        })))
        val response = start().andExpect(status().isOk()).andExpect(jsonPath("$.failureCode").value("ANALYSIS_INVALID")).andReturn().response
        val runId = json.readTree(response.contentAsString).path("id").asLong()
        assertNull(runs.findOwned(ownerId, reviewId, runId)!!.analysis)
        assertEquals(ReviewRunStatus.FAILED, runs.findOwned(ownerId, reviewId, runId)!!.status)
    }

    @Test
    fun sourceFailureIsStoredAndDoesNotReachAi() {
        `when`(source.collect(g.sourceCode, g.sourceProgramId)).thenThrow(SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNSUPPORTED))
        val result = start().andExpect(status().isOk()).andExpect(jsonPath("$.failureCode").value("SOURCE_UNSUPPORTED")).andReturn().response
        val runId = json.readTree(result.contentAsString).path("id").asLong()
        val run = requireNotNull(runs.findOwned(ownerId, reviewId, runId))
        assertEquals(ReviewRunStatus.FAILED, run.status)
        assertNull(run.analysis); assertNull(run.evidence)
        verifyNoInteractions(ai)
    }

    @Test
    fun allRunAndRawSourceRoutesEnforceOwnerEvenForAdmin() {
        val runId = id(start().andExpect(status().isOk()))
        jdbc.update("UPDATE account SET role = 'ADMIN' WHERE id = ?", otherId)
        for (url in listOf(path, "$path/$runId", "$path/$runId/sources/0")) {
            mvc.perform(get(url).cookie(other)).andExpect(status().isNotFound())
            mvc.perform(get(url)).andExpect(status().isUnauthorized())
        }
        start(cookie = other).andExpect(status().isNotFound())
        assertNull(runs.findSource(otherId, reviewId, runId, 0))
        val secondReview = reviews.create(ownerId, draft).id
        mvc.perform(get("/api/v1/combination-reviews/$secondReview/runs/$runId").cookie(owner)).andExpect(status().isNotFound())
    }

    @ParameterizedTest
    @ValueSource(strings = ["expired", "suspended", "deleted", "logged-out"])
    fun inactiveSessionsCannotReadOrStartRuns(state: String) {
        val runId = id(start().andExpect(status().isOk()))
        when (state) {
            "expired" -> jdbc.update("UPDATE account_session SET expires_at = '2000-01-01' WHERE account_id = ?", ownerId)
            "suspended" -> jdbc.update("UPDATE account SET suspended_at = NOW() WHERE id = ?", ownerId)
            "deleted" -> jdbc.update("UPDATE account SET deleted_at = NOW() WHERE id = ?", ownerId)
            "logged-out" -> sessions.logOut(owner.value)
        }
        for (url in listOf(path, "$path/$runId", "$path/$runId/sources/0")) mvc.perform(get(url).cookie(owner)).andExpect(status().`is`(if (state == "suspended") 403 else 401))
        start().andExpect(status().`is`(if (state == "suspended") 403 else 401))
    }

    @Test
    fun requestValidationAndOriginProtectionPrecedeRunCreation() {
        mvc.perform(post(path).cookie(owner).contentType(MediaType.APPLICATION_JSON).content(body())).andExpect(status().isForbidden())
        for (content in listOf("{}", body(key = "invalid"), body(revision = 0), body(facts = "x".repeat(8001)))) {
            mvc.perform(post(path).cookie(owner).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(content)).andExpect(status().isBadRequest())
        }
        mvc.perform(post(path).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(body())).andExpect(status().isUnauthorized())
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run", Int::class.java))
    }

    @Test
    fun concurrentReservationOfSameKeyHasOneCreatorAndDifferentKeyCannotOverlap() {
        val executor = Executors.newFixedThreadPool(2)
        val ready = CountDownLatch(1)
        val key = UUID.randomUUID().toString()
        try {
            val jobs = (1..2).map { executor.submit(Callable {
                ready.await(10, TimeUnit.SECONDS)
                runs.reserve(ownerId, reviewId, 1, key, "", UUID.randomUUID().toString())
            }) }
            ready.countDown()
            val results = jobs.map { it.get(20, TimeUnit.SECONDS) }
            assertEquals(1, results.count { it.created })
            assertEquals(1, results.map { it.run.id }.distinct().size)
            assertThrows(CombinationReviewRunConflictException::class.java) { runs.reserve(ownerId, reviewId, 1, UUID.randomUUID().toString(), "", UUID.randomUUID().toString()) }
            assertThrows(DuplicateKeyException::class.java) {
                jdbc.update("""INSERT INTO combination_review_run (review_id,input_revision,request_key,request_hash,status,input_json,runner_instance_id,started_at)
                    SELECT review_id,input_revision,?,request_hash,status,input_json,runner_instance_id,started_at FROM combination_review_run WHERE id = ?""", UUID.randomUUID().toString(), results.first().run.id)
            }
        } finally { executor.shutdownNow() }
    }

    @Test
    fun failedSourceIntegrityCheckRollsBackEvidenceAndAllSourceWrites() {
        val run = runs.reserve(ownerId, reviewId, 1, UUID.randomUUID().toString(), "", UUID.randomUUID().toString()).run
        requireNotNull(runs.claim(run.id, UUID.randomUUID().toString()))
        val doc = ReviewSourceDocument(0, "https://www.mss.go.kr/example", "test.hwpx", "HWPX", "0".repeat(64), "0".repeat(64), "test", LocalDateTime.now())
        assertThrows(IllegalArgumentException::class.java) { runs.saveEvidence(run.id, ReviewEvidenceSnapshot(listOf(doc), emptyList(), emptyList()), listOf(general)) }
        assertNull(runs.findOwned(ownerId, reviewId, run.id)!!.evidence)
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM combination_review_run_source WHERE run_id = ?", Int::class.java, run.id))
    }

    @Test
    fun limitsNewRunsByAuthenticatedAccountBeforeCallingSourcesOrAi() {
        repeat(6) { start().andExpect(status().isOk()) }
        start().andExpect(status().isTooManyRequests()).andExpect(jsonPath("$.code").value("RUN_RATE_LIMITED"))
            .andExpect(header().exists(HttpHeaders.RETRY_AFTER))
        verify(ai, times(6)).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun runningReplayIsReadOnlyAndAnotherKeyConflictsWhileTheFirstCallIsActive() {
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        `when`(ai.analyze(any(AiCombinationReviewRequest::class.java) ?: request)).thenAnswer {
            entered.countDown(); check(release.await(20, TimeUnit.SECONDS)); answer
        }
        val executor = Executors.newSingleThreadExecutor()
        val key = UUID.randomUUID().toString()
        try {
            val job = executor.submit(Callable { start(key = key).andReturn().response.status })
            assertTrue(entered.await(15, TimeUnit.SECONDS))
            start(key = key).andExpect(status().isOk()).andExpect(jsonPath("$.status").value("RUNNING"))
            start().andExpect(status().isConflict())
            release.countDown()
            assertEquals(200, job.get(20, TimeUnit.SECONDS))
        } finally { release.countDown(); executor.shutdownNow() }
    }

    private fun fetched(
        bytes: ByteArray,
        name: String,
        sourceUrl: String = "https://www.mss.go.kr/common/board/Download.do?bcIdx=1&cbIdx=310&streFileNm=$name",
        sourcePageUrl: String = BIZINFO_PAGE_URL,
    ) = SupportProgramAttachments("공식 공고", listOf(SupportProgramAttachment(sourceUrl, name, "HWPX", bytes)), listOf("기관 해석 미확인"), sourcePageUrl)
    private fun supportProgram(identity: ReviewProgramIdentity, sourceUrl: String) = SupportProgram(
        identity.sourceProgramId, identity.sourceCode, "과기정통부 공고", "과학기술정보통신부", "공고 요약",
        emptyList(), emptyList(), "중소기업", "접수 기간 미확인", null, null, SupportProgramStatus.UNKNOWN,
        "과학기술정보통신부", sourceUrl, emptyList(),
    )
    private fun blankPdf(): ByteArray = ByteArrayOutputStream().use { output ->
        PDDocument().use { document ->
            document.addPage(PDPage())
            document.save(output)
        }
        output.toByteArray()
    }
    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }
    private fun session(): Pair<Long, Cookie> {
        val account = accounts.createAccount(NewAccount("${UUID.randomUUID()}@example.com", "test-hash", LocalDateTime.now()))
        val issued = sessions.issue(account.id, false); accounts.createSession(account.id, issued.session)
        return account.id to Cookie(SessionCookieHelper.COOKIE_NAME, issued.sessionToken)
    }
    private fun body(key: String = UUID.randomUUID().toString(), revision: Long = 1, facts: String = "") = json.writeValueAsString(mapOf("requestKey" to key, "expectedRevision" to revision, "additionalFacts" to facts))
    private fun submit(key: String = UUID.randomUUID().toString(), facts: String = "", cookie: Cookie = owner) = mvc.perform(post(path).cookie(cookie).header(HttpHeaders.ORIGIN, ORIGIN).contentType(MediaType.APPLICATION_JSON).content(body(key = key, facts = facts)))
    /** 분석 본문 회귀 테스트에서는 큐 실행을 직접 구동하고 공개 GET으로 저장 결과를 확인한다. */
    private fun start(key: String = UUID.randomUUID().toString(), facts: String = "", cookie: Cookie = owner): org.springframework.test.web.servlet.ResultActions {
        val submitted = submit(key, facts, cookie)
        if (submitted.andReturn().response.status != 202) return submitted
        val runId = id(submitted)
        service.executeQueued(runId)
        return mvc.perform(get("$path/$runId").cookie(cookie))
    }
    private fun id(result: org.springframework.test.web.servlet.ResultActions) = json.readTree(result.andReturn().response.contentAsString).path("id").asLong()
    companion object {
        const val ORIGIN = "http://localhost:5173"
        const val BIZINFO_PAGE_URL = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_000000000117820"
    }
}
