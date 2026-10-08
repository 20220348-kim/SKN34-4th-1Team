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
        assertEquals(configuration, facade.configuration(ReviewContractVersion.V2))
        val result = facade.analyze(input, evidence, configuration)
        assertEquals(payload.summary, result.summary)
        assertEquals(ReviewJudgment.PERMISSION_IN_SCOPE, result.pairs.first().stages.first().judgment)
        assertEquals("E0", result.pairs.first().stages.first().citations.first().evidenceId)
        assertEquals(payload.limitations, result.limitations)
        assertTrue(result.pairs.single().answers.isEmpty())
        verify(client).analyze(request)
        verify(client, never()).analyzeV3(any(AiCombinationReviewV3Request::class.java) ?: v3Request)
    }

    @Test
    fun rejectsInvalidConfigurationAtTheAiBoundary() {
        for (invalid in listOf(
            AiReviewConfigurationPayload("wrong-contract", payload.model, payload.promptVersion),
            AiReviewConfigurationPayload(payload.contractVersion, "", payload.promptVersion),
            AiReviewConfigurationPayload(payload.contractVersion, payload.model, "unversioned"),
        )) {
            `when`(client.configuration()).thenReturn(invalid)
            assertEquals(Reason.INVALID_RESPONSE, assertThrows(AiCombinationReviewFacadeException::class.java) { facade.configuration(ReviewContractVersion.V2) }.reason)
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

    private val v3Request = json.readValue(resource("contract-v3-request.json"), AiCombinationReviewV3Request::class.java)
    private val v3Payload = json.readValue(resource("contract-v3-response.json"), AiCombinationReviewV3Payload::class.java)
    private val v3Configuration = ReviewModelConfiguration(v3Payload.contractVersion, v3Payload.model, v3Payload.promptVersion)
    private val v3Evidence = ReviewEvidenceSnapshot(
        emptyList(), v3Request.evidence.map { ReviewEvidenceBlock(it.id, it.programIndex, it.documentHash, it.locator, it.text) },
        v3Request.coverageWarnings,
    )
    /** 공유 고정 요청의 UNKNOWN·ACTIVE 상태와 관계를 만드는 내부 스냅샷이다. 참여 사실은 상태 4값으로만 전송된다. */
    private val v3Input = ReviewRunSnapshot(
        "검토",
        listOf(
            SelectedReviewProgram(
                ReviewProgramIdentity(v3Request.programs[0].sourceCode, v3Request.programs[0].sourceProgramId),
                ProgramParticipation(agreementSigned = ParticipationAnswer.YES),
            ),
            SelectedReviewProgram(
                ReviewProgramIdentity(v3Request.programs[1].sourceCode, v3Request.programs[1].sourceProgramId),
                ProgramParticipation(executionStatus = ProgramExecutionStatus.IN_PROGRESS, fundingReceived = ParticipationAnswer.YES),
            ),
        ),
        v3Request.additionalFacts, LocalDate.parse(v3Request.asOfDate), ReviewRelation(sameCost = ParticipationAnswer.NO),
    )
    /** 공유 고정 응답의 첫 인용(E0 원문 조각). 잘못된 응답 사례는 이 파일을 바꿔 테스트 안에서 만든다. */
    private val citation = v3Payload.pairs.single().answers[0].citations.single()

    @Test
    fun v3UsesTheContractQueryAndMapsStatusesRelationAndAnswers() {
        `when`(client.configuration(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION))
            .thenReturn(AiReviewConfigurationPayload(v3Payload.contractVersion, v3Payload.model, v3Payload.promptVersion))
        `when`(client.analyzeV3(v3Request)).thenReturn(v3Payload)
        assertEquals(v3Configuration, facade.configuration(ReviewContractVersion.V3))

        val result = facade.analyze(v3Input, v3Evidence, v3Configuration)

        val pair = result.pairs.single()
        assertTrue(pair.stages.isEmpty())
        assertEquals(ReviewQuestion.entries, pair.answers.map { it.question })
        assertEquals(listOf(ReviewVerdict.ALLOWED, ReviewVerdict.ASK_INSTITUTION, ReviewVerdict.CONDITIONAL), pair.answers.map { it.verdict })
        assertTrue(pair.answers[1].institutionQuestion.isNotBlank())
        assertEquals(listOf(ReviewConditionResult.NOT_ALLOWED, ReviewConditionResult.ALLOWED), pair.answers[2].conditions.map { it.result })
        assertEquals(listOf(ReviewConsequenceMoment.SELECTION, ReviewConsequenceMoment.AFTER), pair.answers[2].consequences.map { it.moment })
        verify(client).analyzeV3(v3Request)
        verify(client, never()).analyze(any(AiCombinationReviewRequest::class.java) ?: request)
    }

    @Test
    fun v3ConfigurationMustReportTheRequestedContract() {
        `when`(client.configuration(AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION))
            .thenReturn(AiReviewConfigurationPayload(payload.contractVersion, payload.model, payload.promptVersion))
        assertEquals(Reason.INVALID_RESPONSE, assertThrows(AiCombinationReviewFacadeException::class.java) {
            facade.configuration(ReviewContractVersion.V3)
        }.reason)
        `when`(client.configuration()).thenReturn(AiReviewConfigurationPayload(v3Payload.contractVersion, v3Payload.model, v3Payload.promptVersion))
        assertEquals(Reason.INVALID_RESPONSE, assertThrows(AiCombinationReviewFacadeException::class.java) {
            facade.configuration(ReviewContractVersion.V2)
        }.reason)
    }

    @Test
    fun v3AcceptsTheContractRangeIncludingNoRuleWithoutCitationsAndCitationsOnlyInsideConditions() {
        val accepted = listOf(
            v3Answer(1) { it.copy(verdict = "NO_RULE", institutionQuestion = "", citations = emptyList()) },
            v3Answer(0) { it.copy(verdict = "NOT_ALLOWED") },
            // AI Service는 다른 판정에도 기관 확인 문장을 채울 수 있다.
            v3Answer(0) { it.copy(institutionQuestion = "신청 전에 담당 기관에 확인해 주세요.") },
            v3Answer(1) { it.copy(citations = emptyList(), conditions = listOf(AiReviewConditionPayload("같은 과제인 경우", "NOT_ALLOWED", listOf(citation)))) },
            v3Answer(2) { a -> a.copy(consequences = List(4) { _ -> AiReviewConsequencePayload("SETTLEMENT", "환수", emptyList()) }) },
        )
        for (valid in accepted) {
            `when`(client.analyzeV3(v3Request)).thenReturn(valid)
            assertEquals(3, facade.analyze(v3Input, v3Evidence, v3Configuration).pairs.single().answers.size)
        }
    }

    @Test
    fun v3RejectsEveryVerdictRuleAndCitationViolation() {
        val pair = v3Payload.pairs.single()
        val condition = AiReviewConditionPayload("조건", "ALLOWED", listOf(citation))
        val invalidResponses = mapOf(
            "model mismatch" to v3Payload.copy(model = "different-model"),
            "no pair" to v3Payload.copy(pairs = emptyList()),
            "duplicate pair" to v3Payload.copy(pairs = listOf(pair, pair)),
            "missing question" to v3Payload.copy(pairs = listOf(pair.copy(answers = pair.answers.drop(1)))),
            "wrong order" to v3Payload.copy(pairs = listOf(pair.copy(answers = pair.answers.reversed()))),
            "duplicate question" to v3Payload.copy(pairs = listOf(pair.copy(answers = listOf(pair.answers[0], pair.answers[0], pair.answers[2])))),
            "unknown verdict" to v3Answer(0) { it.copy(verdict = "INSUFFICIENT_EVIDENCE") },
            "allowed without citation" to v3Answer(0) { it.copy(citations = emptyList()) },
            "allowed with condition" to v3Answer(0) { it.copy(conditions = listOf(condition)) },
            "not allowed without citation" to v3Answer(0) { it.copy(verdict = "NOT_ALLOWED", citations = emptyList()) },
            "not allowed with condition" to v3Answer(0) { it.copy(verdict = "NOT_ALLOWED", conditions = listOf(condition)) },
            "conditional without condition" to v3Answer(2) { it.copy(conditions = emptyList(), citations = listOf(citation)) },
            "conditional without any citation" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(citations = emptyList()) }, citations = emptyList()) },
            "conditional with five conditions" to v3Answer(2) { it.copy(conditions = List(5) { _ -> condition }) },
            "no rule with condition" to v3Answer(1) { it.copy(verdict = "NO_RULE", conditions = listOf(condition)) },
            "institution without question" to v3Answer(1) { it.copy(institutionQuestion = " ") },
            "institution without citation" to v3Answer(1) { it.copy(citations = emptyList()) },
            "unknown condition result" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(result = "CONDITIONAL") }) },
            "blank condition" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(condition = "") }) },
            "long condition" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(condition = "가".repeat(201)) }) },
            "five consequences" to v3Answer(2) { a -> a.copy(consequences = List(5) { _ -> a.consequences.first() }) },
            "unknown moment" to v3Answer(2) { a -> a.copy(consequences = a.consequences.map { it.copy(moment = "APPLICATION") }) },
            "blank action" to v3Answer(2) { a -> a.copy(consequences = a.consequences.map { it.copy(action = " ") }) },
            "long action" to v3Answer(2) { a -> a.copy(consequences = a.consequences.map { it.copy(action = "가".repeat(201)) }) },
            "long explanation" to v3Answer(0) { it.copy(explanation = "가".repeat(601)) },
            "blank explanation" to v3Answer(0) { it.copy(explanation = "") },
            "long institution question" to v3Answer(1) { it.copy(institutionQuestion = "가".repeat(301)) },
            "nine citations" to v3Answer(0) { it.copy(citations = List(9) { _ -> citation }) },
            "nine condition citations" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(citations = List(9) { _ -> citation }) }) },
            "nine consequence citations" to v3Answer(2) { a -> a.copy(consequences = a.consequences.map { it.copy(citations = List(9) { _ -> citation }) }) },
            "unknown evidence" to v3Answer(0) { it.copy(citations = listOf(AiReviewCitationPayload("E999", citation.quote))) },
            "invented quote" to v3Answer(0) { it.copy(citations = listOf(AiReviewCitationPayload("E0", "원문에 존재하지 않는 구절"))) },
            "quote from another block" to v3Answer(0) { it.copy(citations = listOf(AiReviewCitationPayload("E1", citation.quote))) },
            "invented condition quote" to v3Answer(2) { a -> a.copy(conditions = a.conditions.map { it.copy(citations = listOf(AiReviewCitationPayload("E1", "없는 조건 근거"))) }) },
            "invented consequence quote" to v3Answer(2) { a -> a.copy(consequences = a.consequences.map { it.copy(citations = listOf(AiReviewCitationPayload("E0", "없는 조치 근거"))) }) },
            "short quote" to v3Answer(0) { it.copy(citations = listOf(AiReviewCitationPayload("E0", "3개"))) },
        )
        for ((name, invalid) in invalidResponses) {
            `when`(client.analyzeV3(v3Request)).thenReturn(invalid)
            val error = assertThrows(AiCombinationReviewFacadeException::class.java, { facade.analyze(v3Input, v3Evidence, v3Configuration) }, name)
            assertEquals(Reason.INVALID_RESPONSE, error.reason, name)
        }
    }

    private fun v3Answer(index: Int, change: (AiReviewAnswerPayload) -> AiReviewAnswerPayload): AiCombinationReviewV3Payload {
        val pair = v3Payload.pairs.single()
        return v3Payload.copy(pairs = listOf(pair.copy(answers = pair.answers.mapIndexed { i, answer -> if (i == index) change(answer) else answer })))
    }

    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }
}
