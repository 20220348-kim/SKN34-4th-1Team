package ai.govbiz.core.partner.controller.dto

import ai.govbiz.core.partner.domain.PartnerMatchCautionType
import ai.govbiz.core.partner.domain.PartnerMatchProgramSource
import ai.govbiz.core.partner.domain.PartnerMatchReasonType
import ai.govbiz.core.partner.domain.PartnerMatchRelaxType
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.service.dto.PartnerRecruitmentRecommendationResult

/** 맞춤 추천 응답입니다. 이유·확인할 점은 종류와 값만 보내고 문장은 화면이 만듭니다. */
data class PartnerRecruitmentRecommendationResponse(
    val items: List<PartnerRecruitmentRecommendationItemResponse>,
    val total: Int,
    val basis: PartnerRecommendationBasisResponse,
    val relax: List<PartnerRecommendationRelaxResponse>,
    val suggestedProgram: PartnerRecommendationProgramResponse?,
) {
    companion object {
        fun from(result: PartnerRecruitmentRecommendationResult, viewerAccountId: Long): PartnerRecruitmentRecommendationResponse =
            PartnerRecruitmentRecommendationResponse(
                items = result.recommendations.map { recommendation ->
                    PartnerRecruitmentRecommendationItemResponse(
                        recruitment = PartnerRecruitmentResponse.from(recommendation.view, viewerAccountId),
                        reasons = recommendation.reasons.map { PartnerRecommendationReasonResponse(it.type, it.values, it.programSource) },
                        cautions = recommendation.cautions.map { PartnerRecommendationCautionResponse(it.type, it.value) },
                    )
                },
                total = result.total,
                basis = result.basis.let {
                    PartnerRecommendationBasisResponse(it.hasCompany, it.profileSet, it.roles, it.capabilityCount, it.myProgramCount, it.region)
                },
                relax = result.relax.map { PartnerRecommendationRelaxResponse(it.type, it.count) },
                suggestedProgram = result.suggestedProgram?.let {
                    PartnerRecommendationProgramResponse(it.program.sourceCode, it.program.sourceProgramId, it.title)
                },
            )
    }
}

data class PartnerRecruitmentRecommendationItemResponse(
    val recruitment: PartnerRecruitmentResponse,
    val reasons: List<PartnerRecommendationReasonResponse>,
    val cautions: List<PartnerRecommendationCautionResponse>,
)

data class PartnerRecommendationReasonResponse(
    val type: PartnerMatchReasonType,
    val values: List<String>,
    /** MY_PROGRAM일 때 관심 공고(SAVED)인지 신청 준비(PREPARATION)인지입니다. */
    val programSource: PartnerMatchProgramSource?,
)

data class PartnerRecommendationCautionResponse(val type: PartnerMatchCautionType, val value: String)

data class PartnerRecommendationBasisResponse(
    val hasCompany: Boolean,
    val profileSet: Boolean,
    val roles: List<PartnerRole>,
    val capabilityCount: Int,
    val myProgramCount: Int,
    /** 짧은 시·도 이름입니다. 회사가 없거나 알 수 없는 지역이면 null입니다. */
    val region: String?,
)

data class PartnerRecommendationRelaxResponse(val type: PartnerMatchRelaxType, val count: Int)

data class PartnerRecommendationProgramResponse(val sourceCode: String, val sourceProgramId: String, val title: String)
