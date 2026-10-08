package ai.govbiz.core.combinationreview.facade

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.combinationreview.client.AiCombinationReviewClient
import ai.govbiz.core.combinationreview.client.dto.AI_COMBINATION_REVIEW_CONTRACT_VERSION
import ai.govbiz.core.combinationreview.client.dto.AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewPayload
import ai.govbiz.core.combinationreview.client.dto.AiCombinationReviewV3Payload
import ai.govbiz.core.combinationreview.client.dto.AiReviewAnswerPayload
import ai.govbiz.core.combinationreview.client.dto.AiReviewCitationPayload
import ai.govbiz.core.combinationreview.client.exception.AiCombinationReviewClientException
import ai.govbiz.core.combinationreview.client.mapper.AiCombinationReviewMapper
import ai.govbiz.core.combinationreview.domain.*
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException
import ai.govbiz.core.combinationreview.facade.exception.AiCombinationReviewFacadeException.Reason
import org.springframework.stereotype.Component

/** AI 요청 생성·통신·응답 검증·내부 모델 변환을 하나의 경계로 감춘다. DB와 상위 Service를 호출하지 않는다. */
@Component
class AiCombinationReviewFacade(private val client: AiCombinationReviewClient) {
    /** 새 실행의 계약 버전으로 모델·프롬프트 설정을 확인한다. v2는 기존처럼 쿼리 없이 묻는다. */
    fun configuration(version: ReviewContractVersion): ReviewModelConfiguration = execute {
        val contractVersion = AiCombinationReviewMapper.toContractVersion(version)
        val payload = client.configuration(contractVersion.takeIf { version != ReviewContractVersion.V2 })
        require(payload.contractVersion == contractVersion)
        require(payload.model.isNotBlank() && payload.model.length <= 200)
        require(Regex("sha256:[0-9a-f]{64}").matches(payload.promptVersion))
        AiCombinationReviewMapper.toConfiguration(payload)
    }

    /** 실행 전에 확인한 설정의 계약 버전으로 요청·검증·변환 경로를 고른다. */
    fun analyze(input: ReviewRunSnapshot, evidence: ReviewEvidenceSnapshot, configuration: ReviewModelConfiguration): ReviewAnalysis = execute {
        when (configuration.contractVersion) {
            AI_COMBINATION_REVIEW_CONTRACT_VERSION -> {
                val payload = client.analyze(AiCombinationReviewMapper.toRequest(input, evidence))
                validate(payload, configuration, input.programs.size, evidence)
                AiCombinationReviewMapper.toAnalysis(payload)
            }
            AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION -> {
                val payload = client.analyzeV3(AiCombinationReviewMapper.toV3Request(input, evidence))
                validateV3(payload, configuration, input.programs.size, evidence)
                AiCombinationReviewMapper.toV3Analysis(payload)
            }
            else -> throw IllegalArgumentException("unsupported combination review contract")
        }
    }

    private fun validate(payload: AiCombinationReviewPayload, configuration: ReviewModelConfiguration, count: Int, evidence: ReviewEvidenceSnapshot) {
        validateEnvelope(payload.contractVersion, payload.model, payload.promptVersion, payload.summary, payload.limitations, configuration)
        validatePairs(payload.pairs.map { it.firstProgramIndex to it.secondProgramIndex }, count)
        val available = evidence.blocks.associateBy { it.id }
        payload.pairs.forEach { pair ->
            require(pair.stages.size == 6 && pair.stages.map { it.stage }.toSet() == ReviewStage.entries.map { it.name }.toSet())
            pair.stages.forEach { stage ->
                val judgment = ReviewJudgment.valueOf(stage.judgment)
                require(stage.scope.isNotBlank() && stage.scope.length <= 500 && stage.explanation.isNotBlank() && stage.explanation.length <= 1000)
                require(stage.questions.size <= 5 && stage.questions.all { it.isNotBlank() && it.length <= 300 })
                if (judgment in setOf(ReviewJudgment.PERMISSION_IN_SCOPE, ReviewJudgment.RESTRICTION_APPLIES)) {
                    require(stage.citations.isNotEmpty() && !stage.requiresInstitutionConfirmation)
                }
                if (judgment == ReviewJudgment.NEEDS_FACTS) require(stage.questions.isNotEmpty())
                validateCitations(stage.citations, available)
            }
        }
    }

    /** 세 질문이 정해진 순서로 한 번씩 오고, 판정마다 필요한 조건·인용·기관 확인 문장이 있는지 확인한다. */
    private fun validateV3(payload: AiCombinationReviewV3Payload, configuration: ReviewModelConfiguration, count: Int, evidence: ReviewEvidenceSnapshot) {
        validateEnvelope(payload.contractVersion, payload.model, payload.promptVersion, payload.summary, payload.limitations, configuration)
        validatePairs(payload.pairs.map { it.firstProgramIndex to it.secondProgramIndex }, count)
        val available = evidence.blocks.associateBy { it.id }
        payload.pairs.forEach { pair ->
            require(pair.answers.map { it.question } == ReviewQuestion.entries.map { it.name })
            pair.answers.forEach { validateAnswer(it, available) }
        }
    }

    private fun validateAnswer(answer: AiReviewAnswerPayload, available: Map<String, ReviewEvidenceBlock>) {
        val verdict = ReviewVerdict.valueOf(answer.verdict)
        require(answer.explanation.fits(600) && answer.institutionQuestion.codePointLength() <= 300)
        require(answer.conditions.size <= 4 && answer.consequences.size <= 4)
        answer.conditions.forEach {
            ReviewConditionResult.valueOf(it.result)
            require(it.condition.fits(200))
            validateCitations(it.citations, available)
        }
        answer.consequences.forEach {
            ReviewConsequenceMoment.valueOf(it.moment)
            require(it.action.fits(200))
            validateCitations(it.citations, available)
        }
        validateCitations(answer.citations, available)
        // 조건부·기관 확인은 답 자체 또는 조건에 붙은 인용 중 하나 이상이면 된다.
        val cited = answer.citations.isNotEmpty() || answer.conditions.any { it.citations.isNotEmpty() }
        when (verdict) {
            ReviewVerdict.ALLOWED, ReviewVerdict.NOT_ALLOWED -> require(answer.citations.isNotEmpty() && answer.conditions.isEmpty())
            ReviewVerdict.CONDITIONAL -> require(answer.conditions.isNotEmpty() && cited)
            ReviewVerdict.NO_RULE -> require(answer.conditions.isEmpty())
            ReviewVerdict.ASK_INSTITUTION -> require(answer.institutionQuestion.isNotBlank() && cited)
        }
    }

    private fun validateEnvelope(
        contractVersion: String, model: String, promptVersion: String, summary: String, limitations: List<String>,
        configuration: ReviewModelConfiguration,
    ) {
        require(contractVersion == configuration.contractVersion && model == configuration.model && promptVersion == configuration.promptVersion)
        require(summary.isNotBlank() && summary.length <= 1200)
        require(limitations.size in 1..12 && limitations.all { it.isNotBlank() && it.length <= 500 })
    }

    private fun validatePairs(pairs: List<Pair<Int, Int>>, count: Int) {
        val expected = (0 until count).flatMap { first -> (first + 1 until count).map { first to it } }.toSet()
        require(pairs.size == expected.size && pairs.toSet() == expected)
    }

    /** 인용은 항목마다 최대 8개이며, 실행 근거에 있는 ID와 그 원문에 실제로 들어 있는 4~800자 조각이어야 한다. */
    private fun validateCitations(citations: List<AiReviewCitationPayload>, available: Map<String, ReviewEvidenceBlock>) {
        require(citations.size <= 8)
        citations.forEach { citation ->
            val block = requireNotNull(available[citation.evidenceId])
            require(citation.quote.length in 4..800 && block.text.contains(citation.quote))
        }
    }

    private fun String.codePointLength(): Int = codePointCount(0, length)
    private fun String.fits(max: Int): Boolean = isNotBlank() && codePointLength() <= max

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
