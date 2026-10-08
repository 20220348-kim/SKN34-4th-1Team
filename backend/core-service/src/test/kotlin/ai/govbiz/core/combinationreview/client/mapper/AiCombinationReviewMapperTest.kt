package ai.govbiz.core.combinationreview.client.mapper

import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewV3Payload
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewV3Request
import ai.govbiz.core.combinationreview.domain.*
import java.time.LocalDate
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class AiCombinationReviewMapperTest {
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()

    @Test
    fun contractVersionsUseTheAiWireNames() {
        assertEquals("combination-review-v2", AiCombinationReviewMapper.toContractVersion(ReviewContractVersion.V2))
        assertEquals("combination-review-v3", AiCombinationReviewMapper.toContractVersion(ReviewContractVersion.V3))
    }

    @Test
    fun v3RequestSendsDerivedStatusesAndRelationInsteadOfParticipationFacts() {
        val fixture = json.readValue(resource("contract-v3-request.json"), AiCombinationReviewV3Request::class.java)
        val input = ReviewRunSnapshot(
            "검토",
            listOf(
                SelectedReviewProgram(
                    ReviewProgramIdentity(fixture.programs[0].sourceCode, fixture.programs[0].sourceProgramId),
                    ProgramParticipation(agreementSigned = ParticipationAnswer.YES),
                ),
                SelectedReviewProgram(
                    ReviewProgramIdentity(fixture.programs[1].sourceCode, fixture.programs[1].sourceProgramId),
                    ProgramParticipation(selected = ParticipationAnswer.YES, commitmentSubmitted = ParticipationAnswer.NO),
                ),
            ),
            fixture.additionalFacts, LocalDate.parse(fixture.asOfDate), ReviewRelation(sameCost = ParticipationAnswer.NO),
        )
        val evidence = ReviewEvidenceSnapshot(
            emptyList(), fixture.evidence.map { ReviewEvidenceBlock(it.id, it.programIndex, it.documentHash, it.locator, it.text) },
            fixture.coverageWarnings,
        )

        val request = AiCombinationReviewMapper.toV3Request(input, evidence)

        // 수행 사실 없는 협약은 순서를 정할 수 없어 UNKNOWN, 선정됨·확약 전은 ACTIVE다. 나머지도 공유 고정 요청과 같은 JSON이다.
        assertEquals(json.readTree(resource("contract-v3-request.json")), json.valueToTree<JsonNode>(request))
    }

    @Test
    fun v3AnalysisKeepsEveryAnswerFieldAndLeavesStagesEmpty() {
        val payload = json.readValue(resource("contract-v3-response.json"), AiCombinationReviewV3Payload::class.java)

        val analysis = AiCombinationReviewMapper.toV3Analysis(payload)

        val pair = analysis.pairs.single()
        assertTrue(pair.stages.isEmpty())
        val conditional = pair.answers[2]
        val source = payload.pairs.single().answers[2]
        assertEquals(ReviewQuestion.SAME_SUBJECT, conditional.question)
        assertEquals(ReviewVerdict.CONDITIONAL, conditional.verdict)
        assertEquals(source.explanation, conditional.explanation)
        assertEquals(source.conditions.map { it.condition }, conditional.conditions.map { it.condition })
        assertEquals(listOf(ReviewConditionResult.NOT_ALLOWED, ReviewConditionResult.ALLOWED), conditional.conditions.map { it.result })
        assertEquals(source.conditions[0].citations.single().quote, conditional.conditions[0].citations.single().quote)
        assertTrue(conditional.conditions[1].citations.isEmpty())
        assertEquals(listOf(ReviewConsequenceMoment.SELECTION, ReviewConsequenceMoment.AFTER), conditional.consequences.map { it.moment })
        assertEquals(source.consequences.map { it.action }, conditional.consequences.map { it.action })
        assertEquals(ReviewVerdict.ASK_INSTITUTION, pair.answers[1].verdict)
        assertEquals(payload.pairs.single().answers[1].institutionQuestion, pair.answers[1].institutionQuestion)
        assertEquals(payload.limitations, analysis.limitations)
    }

    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }
}
