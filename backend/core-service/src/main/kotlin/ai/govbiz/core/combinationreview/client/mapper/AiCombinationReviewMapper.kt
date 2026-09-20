package ai.govbiz.core.combinationreview.client.mapper

import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.domain.*

/** 내부 스냅샷과 AI 전송 타입 사이의 필드·enum 변환만 담당한다. 계약 검증은 Facade의 책임이다. */
internal object AiCombinationReviewMapper {
    fun toRequest(input: ReviewRunSnapshot, evidence: ReviewEvidenceSnapshot): AiCombinationReviewRequest =
        AiCombinationReviewRequest(
            AI_COMBINATION_REVIEW_CONTRACT_VERSION,
            input.programs.map { program ->
                val facts = program.participation
                AiReviewProgramRequest(
                    program.identity.sourceCode, program.identity.sourceProgramId, program.identity.subProgramId,
                    AiReviewParticipationRequest(
                        facts.applicationSubmitted.name, facts.selected.name, facts.commitmentSubmitted.name,
                        facts.agreementSigned.name, facts.executionStatus.name, facts.fundingReceived.name,
                    ),
                )
            },
            input.asOfDate.toString(), input.additionalFacts,
            evidence.blocks.map { AiReviewEvidenceRequest(it.id, it.programIndex, it.documentHash, it.locator, it.text) },
            evidence.coverageWarnings,
        )

    fun toConfiguration(payload: AiReviewConfigurationPayload): ReviewModelConfiguration =
        ReviewModelConfiguration(payload.contractVersion, payload.model, payload.promptVersion)

    fun toAnalysis(payload: AiCombinationReviewPayload): ReviewAnalysis = ReviewAnalysis(
        payload.summary,
        payload.pairs.map { pair ->
            ReviewPairJudgments(pair.firstProgramIndex, pair.secondProgramIndex, pair.stages.map { stage ->
                ReviewStageJudgment(
                    ReviewStage.valueOf(stage.stage), ReviewJudgment.valueOf(stage.judgment), stage.scope,
                    stage.explanation, stage.questions, stage.requiresInstitutionConfirmation,
                    stage.citations.map { ReviewCitation(it.evidenceId, it.quote) },
                )
            })
        },
        payload.limitations,
    )
}
