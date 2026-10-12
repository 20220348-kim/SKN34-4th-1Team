package ai.govbiz.core.supportprogram.controller.dto

import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReview
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityReviewStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityAssessment
import ai.govbiz.core.supportprogram.domain.SupportProgramEligibilityEvidenceField
import ai.govbiz.core.supportprogram.domain.SupportProgramPosting
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService

data class SupportProgramResponse(
    val id: String,
    val sourceCode: String,
    val title: String,
    val organization: String,
    val summary: String,
    val categories: List<String>,
    val regions: List<String>,
    val targetDescription: String,
    val applicationPeriod: String,
    val applicationStartDate: String?,
    val applicationEndDate: String?,
    val status: SupportProgramStatus,
    val sourceName: String,
    val sourceUrl: String,
    val matchedReasons: List<String>,
    val recommendationScore: Int?,
    val eligibilityReview: SupportProgramEligibilityReviewResponse? = null,
    /** 검색 결과 전용: 공고 지역 태그가 회사 소재지와 겹치지 않아 다른 지역 한정일 수 있습니다. 자격 판정이 아닙니다. */
    val regionTagMismatch: Boolean = false,
    /** 이 공고에 원문 근거 질문을 할 수 있는지 서버가 정합니다. 상세 응답과 같은 기준입니다. */
    val evidenceQuestionSupported: Boolean = false,
    /** 검색 결과 전용: 같은 공고를 다른 제공처도 올려 이 칸에 함께 묶은 게시물입니다. 없으면 빈 목록입니다. */
    val alsoPostedBy: List<SupportProgramPostingResponse> = emptyList(),
) {
    companion object {
        fun from(program: SupportProgram): SupportProgramResponse =
            SupportProgramResponse(
                id = program.id,
                sourceCode = program.sourceCode,
                title = program.title,
                organization = program.organization,
                summary = program.summary,
                categories = program.categories,
                regions = program.regions,
                targetDescription = program.targetDescription,
                applicationPeriod = program.applicationPeriod,
                applicationStartDate = program.applicationStartDate?.toString(),
                applicationEndDate = program.applicationEndDate?.toString(),
                status = program.status,
                sourceName = program.sourceName,
                sourceUrl = program.sourceUrl,
                matchedReasons = program.matchedReasons,
                recommendationScore = program.recommendationScore,
                eligibilityReview = program.eligibilityReview?.let(SupportProgramEligibilityReviewResponse::from),
                regionTagMismatch = program.regionTagMismatch,
                evidenceQuestionSupported = SupportProgramEvidenceService.supportsQuestions(program.sourceCode),
                alsoPostedBy = java.util.List.copyOf(program.alsoPostedBy.map(SupportProgramPostingResponse::from)),
            )
    }
}

/** 같은 공고의 다른 제공처 게시물입니다. 원문 링크와 그 게시물의 원문 질문 지원 여부를 담습니다. */
data class SupportProgramPostingResponse(
    val sourceCode: String,
    val id: String,
    val sourceName: String,
    val sourceUrl: String,
    val evidenceQuestionSupported: Boolean,
) {
    companion object {
        fun from(posting: SupportProgramPosting) = SupportProgramPostingResponse(
            posting.sourceCode, posting.id, posting.sourceName, posting.sourceUrl,
            SupportProgramEvidenceService.supportsQuestions(posting.sourceCode),
        )
    }
}

data class SupportProgramEligibilityReviewResponse(
    val status: SupportProgramEligibilityReviewStatus,
    val basis: String,
    val target: SupportProgramEligibilityAssessmentResponse,
    val region: SupportProgramEligibilityAssessmentResponse,
) {
    companion object {
        fun from(review: SupportProgramEligibilityReview): SupportProgramEligibilityReviewResponse =
            SupportProgramEligibilityReviewResponse(
                review.status,
                "OFFICIAL_API_TEXT",
                SupportProgramEligibilityAssessmentResponse.from(review.target),
                SupportProgramEligibilityAssessmentResponse.from(review.region),
            )
    }
}

data class SupportProgramEligibilityAssessmentResponse(
    val status: SupportProgramEligibilityStatus,
    val explanation: String,
    val evidence: List<SupportProgramEligibilityEvidenceResponse>,
) {
    companion object {
        fun from(assessment: SupportProgramEligibilityAssessment): SupportProgramEligibilityAssessmentResponse =
            SupportProgramEligibilityAssessmentResponse(
                assessment.status,
                assessment.explanation,
                java.util.List.copyOf(assessment.evidence.map { SupportProgramEligibilityEvidenceResponse(it.field, it.quote) }),
            )
    }
}

data class SupportProgramEligibilityEvidenceResponse(
    val field: SupportProgramEligibilityEvidenceField,
    val quote: String,
)
