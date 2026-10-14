package ai.govbiz.core.combinationreview.service

import ai.govbiz.core.combinationreview.config.CombinationReviewProperties
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.facade.AiCombinationReviewFacade
import ai.govbiz.core.combinationreview.repository.CombinationReviewRunRepository
import ai.govbiz.core.planusage.PlanUsageTestHelper
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.*
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.client.ops.ProductionQualityClient
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityContextRequest
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.admission.config.SupportProgramRequestAdmissionProperties
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import java.time.Clock
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*

class CombinationReviewProductionQualityTest {
    private val runs = mock(CombinationReviewRunRepository::class.java)
    private val reviews = mock(CombinationReviewService::class.java)
    private val attachments = mock(BizInfoAttachmentClient::class.java)
    private val parser = mock(SupportProgramDocumentParser::class.java)
    private val ai = mock(AiCombinationReviewFacade::class.java)
    private val quality = mock(ProductionQualityClient::class.java)
    private val clock = Clock.fixed(java.time.Instant.parse("2026-10-15T03:00:00Z"), ZoneId.of("Asia/Seoul"))
    private val service = CombinationReviewRunService(runs, reviews, attachments, mock(MsitAttachmentClient::class.java),
        mock(KStartupAttachmentClient::class.java), mock(CnTradeNoticeAttachmentClient::class.java),
        mock(SupportProgramDetailService::class.java), parser, ai,
        SupportProgramRequestAdmissionService(SupportProgramRequestAdmissionProperties()),
        PlanUsageTestHelper.allowAll(), PlanUsageTestHelper.noTransactions(), clock, true, CombinationReviewProperties(), quality)
    private val input = ReviewRunSnapshot("개인 식별 가능 제목은 수집하지 않음", listOf(
        SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "program-a")),
        SelectedReviewProgram(ReviewProgramIdentity("BIZINFO", "program-b"))), "같은 장비 비용으로 신청 예정", LocalDate.of(2026, 10, 15),
        ReviewRelation(ParticipationAnswer.YES, ParticipationAnswer.YES))
    private val run = StoredCombinationReviewRun(1, 2, 1, "request-key", "hash", ReviewRunStatus.RUNNING, input, null, null, null,
        null, "runner", LocalDateTime.now(clock), null)
    private val configuration = ReviewModelConfiguration("combination-review-v3", "test-model", "test-prompt")
    private val analysis = ReviewAnalysis(
        "동일한 비용은 중복 지원이 제한됩니다.",
        listOf(ReviewPairJudgments(0, 1, answers = listOf(
            ReviewQuestionAnswer(
                ReviewQuestion.SAME_SUBJECT, ReviewVerdict.NOT_ALLOWED, "같은 비용은 중복 정산할 수 없습니다.",
                listOf(ReviewCondition("다른 비용이면 가능", ReviewConditionResult.ALLOWED, listOf(ReviewCitation("E1", "다른 비용은 허용")))),
                listOf(ReviewConsequence(ReviewConsequenceMoment.SETTLEMENT, "중복 비용 제외", listOf(ReviewCitation("E0", "중복 정산 제외")))),
                "비용 항목을 기관에 확인하세요.", listOf(ReviewCitation("E0", "중복 정산 제외")),
            ),
        ))),
        listOf("최종 확인은 기관에 필요합니다."),
    )

    private fun prepare(result: ReviewAnalysis = analysis, blocksPerProgram: Int = 1) {
        doReturn(run, null).`when`(runs).claim(eq(1L), anyString())
        `when`(runs.findOwnerId(1)).thenReturn(9L)
        input.programs.forEachIndexed { index, program ->
            val bytes = "private-binary-$index".toByteArray()
            `when`(attachments.collect("BIZINFO", program.identity.sourceProgramId)).thenReturn(SupportProgramAttachments(
                "공개 제목", listOf(SupportProgramAttachment("https://example.test/private?signature=secret", "private-file.pdf", "PDF", bytes)),
                emptyList(), "https://example.test/notice"))
            `when`(parser.parseEvidence(bytes, "PDF")).thenReturn((0 until blocksPerProgram).map {
                SupportProgramDocumentBlock("page ${it + 1}", "사업 ${index + 1}의 공개 조건 $it")
            })
        }
        `when`(ai.configuration(ReviewContractVersion.V3)).thenReturn(configuration)
        doReturn(result).`when`(ai).analyze(eq(input) ?: input, any(ReviewEvidenceSnapshot::class.java) ?: ReviewEvidenceSnapshot(emptyList(), emptyList(), emptyList()), eq(configuration) ?: configuration)
    }

    @Test
    fun collectsBothProgramsSituationsEvidenceAndFullVerdictAfterSave() {
        prepare()
        service.executeQueued(1)
        verify(runs).succeed(1, analysis)
        val call = mockingDetails(quality).invocations.single { it.method.name == "recordOperation" }
        assertEquals("combination-review", call.getArgument<String>(0))
        val contexts = call.getArgument<List<ProductionQualityContextRequest>>(2)
        assertEquals(listOf("program-1", "program-2", "review-conditions", "E0", "E1"), contexts.map { it.id })
        assertTrue(contexts[2].text.contains(input.additionalFacts))
        val output = call.getArgument<String>(3)
        assertTrue(output.contains("NOT_ALLOWED"))
        assertTrue(output.contains("다른 비용이면 가능"))
        assertTrue(output.contains("중복 비용 제외"))
        assertTrue(output.contains("근거 [E1]"))
        assertTrue(output.contains(analysis.limitations.single()))
        val collected = contexts.joinToString() + output + call.getArgument<String>(1)
        listOf("private-binary", "private-file", "signature=secret", input.title).forEach { assertFalse(collected.contains(it)) }
        assertEquals("", call.getArgument<String>(6))
        assertTrue(mockingDetails(runs).invocations.first { it.method.name == "succeed" }.sequenceNumber < call.sequenceNumber)
    }

    @Test
    fun repeatedQueueDeliveryDoesNotResampleCompletedRun() {
        prepare()
        repeat(2) { service.executeQueued(1) }
        assertEquals(1, mockingDetails(quality).invocations.count { it.method.name == "recordOperation" })
        assertEquals(1, mockingDetails(ai).invocations.count { it.method.name == "analyze" })
    }

    @Test
    fun samplesV2StagesAndPreservesInsufficientEvidenceStatus() {
        val legacy = ReviewAnalysis("자료 부족", listOf(ReviewPairJudgments(0, 1, stages = listOf(ReviewStageJudgment(
            ReviewStage.APPLICATION, ReviewJudgment.INSUFFICIENT_EVIDENCE, "신청", "적용 근거 없음", listOf("기관 확인 필요"), true, emptyList())))),
            listOf("공고 첨부 범위"))
        prepare(legacy)
        service.executeQueued(1)
        val call = mockingDetails(quality).invocations.single { it.method.name == "recordOperation" }
        assertEquals("INSUFFICIENT_EVIDENCE", call.getArgument<String>(4))
        assertTrue(call.getArgument<String>(3).contains("기관 확인 필요: true"))
    }

    @Test
    fun leavesFullContextListForClientToDeclareTruncationAndAlternatesPrograms() {
        prepare(blocksPerProgram = 30)
        service.executeQueued(1)
        val contexts = mockingDetails(quality).invocations.single { it.method.name == "recordOperation" }
            .getArgument<List<ProductionQualityContextRequest>>(2)
        assertEquals(63, contexts.size)
        assertTrue(contexts[3].label.startsWith("사업 1"))
        assertTrue(contexts[4].label.startsWith("사업 2"))
    }

    @Test
    fun collectorFailureDoesNotMarkSavedReviewUnknownOrFailed() {
        prepare()
        doThrow(IllegalStateException("collector unavailable")).`when`(quality).recordOperation(
            anyString(), anyString(), anyList(), anyString(), anyString(), isNull(), anyString())
        assertDoesNotThrow { service.executeQueued(1) }
        verify(runs).succeed(1, analysis)
        verify(runs, never()).markUnknown(anyLong(), anyString())
        verify(runs, never()).fail(anyLong(), anyString())
    }

    @Test
    fun failedResultSaveDoesNotCreateSample() {
        prepare()
        doThrow(IllegalStateException("db unavailable")).`when`(runs).succeed(1, analysis)
        service.executeQueued(1)
        verifyNoInteractions(quality)
        verify(runs).markUnknown(1, "RUN_OUTCOME_UNKNOWN")
    }
}
