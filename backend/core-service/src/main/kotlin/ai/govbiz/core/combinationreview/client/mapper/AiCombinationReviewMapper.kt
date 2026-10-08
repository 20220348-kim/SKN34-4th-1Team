package ai.govbiz.core.combinationreview.client.mapper

import ai.govbiz.core.combinationreview.client.dto.*
import ai.govbiz.core.combinationreview.domain.*

/** 내부 스냅샷과 AI 전송 타입 사이의 필드·enum 변환만 담당한다. 계약 검증은 Facade의 책임이다. */
internal object AiCombinationReviewMapper {
    fun toContractVersion(version: ReviewContractVersion): String = when (version) {
        ReviewContractVersion.V2 -> AI_COMBINATION_REVIEW_CONTRACT_VERSION
        ReviewContractVersion.V3 -> AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION
    }

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
            evidence.blocks.map(::toEvidence),
            evidence.coverageWarnings,
        )

    /** 참여 사실 6칸은 Domain 규칙으로 상태 4값(모름 포함)으로 묶어 보낸다. */
    fun toV3Request(input: ReviewRunSnapshot, evidence: ReviewEvidenceSnapshot): AiCombinationReviewV3Request =
        AiCombinationReviewV3Request(
            AI_COMBINATION_REVIEW_V3_CONTRACT_VERSION,
            input.programs.map { program ->
                AiReviewProgramV3Request(
                    program.identity.sourceCode, program.identity.sourceProgramId, program.identity.subProgramId,
                    program.participation.reviewStatus().name,
                )
            },
            AiReviewRelationRequest(input.relation.sameProject.name, input.relation.sameCost.name),
            input.asOfDate.toString(), input.additionalFacts,
            evidence.blocks.map(::toEvidence),
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
                    toCitations(stage.citations),
                )
            })
        },
        payload.limitations,
    )

    fun toV3Analysis(payload: AiCombinationReviewV3Payload): ReviewAnalysis = ReviewAnalysis(
        payload.summary,
        payload.pairs.map { pair ->
            ReviewPairJudgments(pair.firstProgramIndex, pair.secondProgramIndex, answers = pair.answers.map { answer ->
                ReviewQuestionAnswer(
                    ReviewQuestion.valueOf(answer.question), ReviewVerdict.valueOf(answer.verdict), answer.explanation,
                    answer.conditions.map {
                        ReviewCondition(it.condition, ReviewConditionResult.valueOf(it.result), toCitations(it.citations))
                    },
                    answer.consequences.map {
                        ReviewConsequence(ReviewConsequenceMoment.valueOf(it.moment), it.action, toCitations(it.citations))
                    },
                    answer.institutionQuestion, toCitations(answer.citations),
                )
            })
        },
        payload.limitations,
    )

    private fun toEvidence(block: ReviewEvidenceBlock) =
        AiReviewEvidenceRequest(block.id, block.programIndex, block.documentHash, block.locator, block.text)

    private fun toCitations(citations: List<AiReviewCitationPayload>) = citations.map { ReviewCitation(it.evidenceId, it.quote) }
}
