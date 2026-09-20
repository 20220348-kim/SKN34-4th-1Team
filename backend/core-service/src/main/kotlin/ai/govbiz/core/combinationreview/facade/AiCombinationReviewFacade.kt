package ai.govbiz.core.combinationreview.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.dto.AI_COMBINATION_REVIEW_CONTRACT_VERSION
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewPayload
import ai.govbiz.core.combinationreview.client.exception.AiCombinationReviewClientException
import ai.govbiz.core.combinationreview.client.mapper.AiCombinationReviewMapper
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException.Reason
import org.springframework.stereotype.Component

/** AI 요청 생성·통신·응답 검증·내부 모델 변환을 하나의 경계로 감춘다. DB와 상위 Service를 호출하지 않는다. */
@Component
class AiCombinationReviewFacade(private val client: AiCombinationReviewClient) {
    fun configuration(): ReviewModelConfiguration = execute {
        val payload = client.configuration()
        require(payload.contractVersion == AI_COMBINATION_REVIEW_CONTRACT_VERSION)
        require(payload.model.isNotBlank() && payload.model.length <= 200)
        require(Regex("sha256:[0-9a-f]{64}").matches(payload.promptVersion))
        AiCombinationReviewMapper.toConfiguration(payload)
    }

    fun analyze(input: ReviewRunSnapshot, evidence: ReviewEvidenceSnapshot, configuration: ReviewModelConfiguration): ReviewAnalysis = execute {
        val payload = client.analyze(AiCombinationReviewMapper.toRequest(input, evidence))
        validate(payload, configuration, input.programs.size, evidence)
        AiCombinationReviewMapper.toAnalysis(payload)
    }

    private fun validate(payload: AiCombinationReviewPayload, configuration: ReviewModelConfiguration, count: Int, evidence: ReviewEvidenceSnapshot) {
        require(payload.contractVersion == configuration.contractVersion && payload.model == configuration.model && payload.promptVersion == configuration.promptVersion)
        require(payload.summary.isNotBlank() && payload.summary.length <= 1200)
        require(payload.limitations.size in 1..12 && payload.limitations.all { it.isNotBlank() && it.length <= 500 })
        val expected = (0 until count).flatMap { first -> (first + 1 until count).map { first to it } }.toSet()
        require(payload.pairs.size == expected.size && payload.pairs.map { it.firstProgramIndex to it.secondProgramIndex }.toSet() == expected)
        val available = evidence.blocks.associateBy { it.id }
        payload.pairs.forEach { pair ->
            require(pair.stages.size == 6 && pair.stages.map { it.stage }.toSet() == ReviewStage.entries.map { it.name }.toSet())
            pair.stages.forEach { stage ->
                val judgment = ReviewJudgment.valueOf(stage.judgment)
                require(stage.scope.isNotBlank() && stage.scope.length <= 500 && stage.explanation.isNotBlank() && stage.explanation.length <= 1000)
                require(stage.questions.size <= 5 && stage.questions.all { it.isNotBlank() && it.length <= 300 } && stage.citations.size <= 8)
                if (judgment in setOf(ReviewJudgment.PERMISSION_IN_SCOPE, ReviewJudgment.RESTRICTION_APPLIES)) {
                    require(stage.citations.isNotEmpty() && !stage.requiresInstitutionConfirmation)
                }
                if (judgment == ReviewJudgment.NEEDS_FACTS) require(stage.questions.isNotEmpty())
                stage.citations.forEach { citation ->
                    val block = requireNotNull(available[citation.evidenceId])
                    require(citation.quote.length in 4..800 && block.text.contains(citation.quote))
                }
            }
        }
    }

    private fun <T> execute(action: () -> T): T = try {
        action()
    } catch (error: AiCombinationReviewClientException) {
        val reason = when (error.reason) {
            AiCombinationReviewClientException.Reason.INVALID_RESPONSE -> Reason.INVALID_RESPONSE
            AiCombinationReviewClientException.Reason.CONTEXT_TOO_LARGE -> Reason.CONTEXT_TOO_LARGE
        }
        throw AiCombinationReviewFacadeException(reason, error)
    } catch (error: AiServiceCallException) {
        val reason = if (error.failure == AiServiceFailure.INVALID_RESPONSE) Reason.INVALID_RESPONSE else Reason.UNAVAILABLE
        throw AiCombinationReviewFacadeException(reason, error)
    } catch (error: IllegalArgumentException) {
        throw AiCombinationReviewFacadeException(Reason.INVALID_RESPONSE, error)
    }
}
