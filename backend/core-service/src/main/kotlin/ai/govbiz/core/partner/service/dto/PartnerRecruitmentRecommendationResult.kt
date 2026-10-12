package ai.govbiz.core.partner.service.dto

import ai.govbiz.core.partner.domain.PartnerMatchCaution
import ai.govbiz.core.partner.domain.PartnerMatchMyProgram
import ai.govbiz.core.partner.domain.PartnerMatchReason
import ai.govbiz.core.partner.domain.PartnerMatchRelax
import ai.govbiz.core.partner.domain.PartnerRecruitmentView
import ai.govbiz.core.partner.domain.PartnerRole

/** 맞춤 추천 한 건입니다. 모집글은 목록과 같은 보기에 이유·확인할 점을 붙입니다. */
data class PartnerRecruitmentRecommendation(
    val view: PartnerRecruitmentView,
    val reasons: List<PartnerMatchReason>,
    val cautions: List<PartnerMatchCaution>,
)

/** 무엇을 기준으로 골랐는지 화면이 한 줄로 알려 주는 값입니다. */
data class PartnerRecommendationBasis(
    val hasCompany: Boolean,
    val profileSet: Boolean,
    val roles: List<PartnerRole>,
    val capabilityCount: Int,
    val myProgramCount: Int,
    val region: String?,
)

data class PartnerRecruitmentRecommendationResult(
    val recommendations: List<PartnerRecruitmentRecommendation>,
    val total: Int,
    val basis: PartnerRecommendationBasis,
    val relax: List<PartnerMatchRelax>,
    val suggestedProgram: PartnerMatchMyProgram?,
)
