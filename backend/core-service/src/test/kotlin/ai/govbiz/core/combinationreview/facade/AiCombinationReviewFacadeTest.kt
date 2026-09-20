package ai.govbiz.core.combinationreview.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.client.exception.AiCombinationReviewClientException
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException.Reason
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class AiCombinationReviewFacadeTest {
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val client = mock(AiCombinationReviewClient::class.java)
    private val facade = AiCombinationReviewFacade(client)
    private val request = json.readValue(resource("contract-request.json"), AiCombinationReviewRequest::class.java)
    private val payload = json.readValue(resource("contract-response.json"), AiCombinationReviewPayload::class.java)
    private val configuration = ReviewModelConfiguration(payload.contractVersion, payload.model, payload.promptVersion)
    private val input = ReviewRunSnapshot(
        "검토", request.programs.map { p ->
            val facts = p.participation
            SelectedReviewProgram(ReviewProgramIdentity(p.sourceCode, p.sourceProgramId, p.subProgramId), ProgramParticipation(
                ParticipationAnswer.valueOf(facts.applicationSubmitted), ParticipationAnswer.valueOf(facts.selected),
                ParticipationAnswer.valueOf(facts.commitmentSubmitted), ParticipationAnswer.valueOf(facts.agreementSigned),
                ProgramExecutionStatus.valueOf(facts.executionStatus), ParticipationAnswer.valueOf(facts.fundingReceived),
            ))
        }, request.additionalFacts, LocalDate.parse(request.asOfDate),
    )
    private val evidence = ReviewEvidenceSnapshot(
        emptyList(), request.evidence.map { ReviewEvidenceBlock(it.id, it.programIndex, it.documentHash, it.locator, it.text) },
        request.coverageWarnings,
    )

    @Test
    fun mapsTheSharedHttpContractAndReturnsOnlyInternalModels() {
        `when`(client.configuration()).thenReturn(AiReviewConfigurationPayload(payload.contractVersion, payload.model, payload.promptVersion))
        `when`(client.analyze(request)).thenReturn(payload)
        assertEquals(configuration, facade.configuration())
        val result = facade.analyze(input, evidence, configuration)
        assertEquals(payload.summary, result.summary)
        assertEquals(ReviewJudgment.PERMISSION_IN_SCOPE, result.pairs.first().stages.first().judgment)
        assertEquals("E0", result.pairs.first().stages.first().citations.first().evidenceId)
        assertEquals(payload.limitations, result.limitations)
        verify(client).analyze(request)
    }

    @Test
    fun rejectsInvalidConfigurationAtTheAiBoundary() {
        for (invalid in listOf(
            AiReviewConfigurationPayload("wrong-contract", payload.model, payload.promptVersion),
            AiReviewConfigurationPayload(payload.contractVersion, "", payload.promptVersion),
            AiReviewConfigurationPayload(payload.contractVersion, payload.model, "unversioned"),
        )) {
            `when`(client.configuration()).thenReturn(invalid)
            assertEquals(Reason.INVALID_RESPONSE, assertThrows(AiCombinationReviewFacadeException::class.java) { facade.configuration() }.reason)
        }
        verify(client, never()).analyze(request)
    }

    @Test
    fun rejectsMissingPairsStagesInventedQuotesAndUnconfirmedDefinitiveJudgments() {
        val pair = payload.pairs.single()
        val first = pair.stages.first()
        val invalidResponses = listOf(
            payload.copy(model = "different-model"),
            payload.copy(pairs = emptyList()),
            payload.copy(pairs = listOf(pair, pair)),
            payload.copy(pairs = listOf(pair.copy(stages = pair.stages.drop(1)))),
            payload.copy(pairs = listOf(pair.copy(stages = listOf(first.copy(citations = listOf(AiReviewCitationPayload("E999", "없는 인용")))) + pair.stages.drop(1)))),
            payload.copy(pairs = listOf(pair.copy(stages = listOf(first.copy(citations = listOf(AiReviewCitationPayload("E0", "원문에 존재하지 않는 구절")))) + pair.stages.drop(1)))),
            payload.copy(pairs = listOf(pair.copy(stages = listOf(first.copy(requiresInstitutionConfirmation = true)) + pair.stages.drop(1)))),
        )
        for (invalid in invalidResponses) {
            `when`(client.analyze(request)).thenReturn(invalid)
            assertEquals(Reason.INVALID_RESPONSE, assertThrows(AiCombinationReviewFacadeException::class.java) {
                facade.analyze(input, evidence, configuration)
            }.reason)
        }
    }

    @Test
    fun hidesClientErrorTypesBehindTheFacadeFailureContract() {
        for ((failure, expected) in listOf(
            AiCombinationReviewClientException(AiCombinationReviewClientException.Reason.CONTEXT_TOO_LARGE) to Reason.CONTEXT_TOO_LARGE,
            AiCombinationReviewClientException(AiCombinationReviewClientException.Reason.INVALID_RESPONSE) to Reason.INVALID_RESPONSE,
            AiServiceCallException.unavailable(null) to Reason.UNAVAILABLE,
            AiServiceCallException.invalidResponse("private upstream detail", null) to Reason.INVALID_RESPONSE,
        )) {
            // doThrow replaces the previous throwing stub without invoking it during setup.
            doThrow(failure).`when`(client).analyze(request)
            val error = assertThrows(AiCombinationReviewFacadeException::class.java) { facade.analyze(input, evidence, configuration) }
            assertEquals(expected, error.reason)
            assertNull(error.message)
        }
    }

    @Test
    fun doesNotLabelAnUnrelatedProgrammingFailureAsAnAiContractViolation() {
        doThrow(IllegalStateException("internal fault")).`when`(client).analyze(request)
        assertThrows(IllegalStateException::class.java) { facade.analyze(input, evidence, configuration) }
    }

    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }
}
