package ai.govbiz.core.partner.domain

import ai.govbiz.core._common.domain.RegionDictionary
import java.time.LocalDate

/** 모집글을 고를 공고입니다. 공고는 제공처마다 ID가 겹칠 수 있어 출처와 함께 다룹니다. */
data class PartnerMatchProgram(val sourceCode: String, val sourceProgramId: String)

/**
 * 맞춤 추천 조건입니다. 찾는 역할·지역·공고는 모집글을 거르고, 분야 말은 거르지 않고 순서만 올립니다.
 * 지역을 고르면 전국 모집글도 함께 남깁니다(목록 조회와 같은 규칙). 모두 비어 있으면 내 정보만으로 고릅니다.
 */
data class PartnerMatchConditions(
    val seekingRoles: Set<PartnerRole> = emptySet(),
    val regions: Set<String> = emptySet(),
    val keywords: List<String> = emptyList(),
    val program: PartnerMatchProgram? = null,
) {
    init {
        require(regions.all { it in RegionDictionary.PROVINCES }) { "regions must be short province names" }
        require(keywords.size <= MAX_KEYWORDS) { "keywords must have at most $MAX_KEYWORDS items" }
        require(keywords.all { it.isNotBlank() && it == it.trim() && it.length <= MAX_KEYWORD_LENGTH }) {
            "each keyword must be a trimmed 1~$MAX_KEYWORD_LENGTH character text"
        }
    }

    companion object {
        const val MAX_KEYWORDS = 3
        const val MAX_KEYWORD_LENGTH = 30
    }
}

/** 내 이력에서 온 공고입니다. 관심 공고는 접수가 끝나지 않았을 때만 모집글 쓰기를 권합니다. */
enum class PartnerMatchProgramSource { SAVED, PREPARATION }

data class PartnerMatchMyProgram(
    val program: PartnerMatchProgram,
    val title: String,
    val source: PartnerMatchProgramSource,
    val isOpen: Boolean,
)

/**
 * 추천을 받는 쪽의 정보입니다. 회사가 없으면 지역·설립연도가 null이고, 협업·파트너 설정을 저장하지 않았으면 역할·역량이 비어 있습니다.
 * 역할이 비어 있으면 찾는 역할로 거르지 않습니다.
 */
data class PartnerMatchApplicant(
    val accountId: Long,
    val region: String?,
    val foundedYear: Int?,
    val roles: Set<PartnerRole>,
    val capabilities: List<String>,
    val programs: List<PartnerMatchMyProgram>,
    /** 이미 제안을 보낸(철회하지 않은) 모집글입니다. 다시 권하지 않습니다. */
    val proposedRecruitmentIds: Set<Long>,
)

enum class PartnerMatchReasonType { MY_PROGRAM, KEYWORD, CAPABILITY, SAME_REGION, ROLE }

/** 카드에 보여 줄 이유입니다. [values]는 공고 이름·겹친 역량·분야 말·지역·역할처럼 화면이 문장으로 바꿀 값입니다. */
data class PartnerMatchReason(
    val type: PartnerMatchReasonType,
    val values: List<String>,
    val programSource: PartnerMatchProgramSource? = null,
)

enum class PartnerMatchCautionType { OTHER_REGION, COMPANY_AGE }

/** 거르지는 않았지만 확인할 점입니다. 다른 희망 지역, 업력을 몰라 확인하지 못한 최소 업력입니다. */
data class PartnerMatchCaution(val type: PartnerMatchCautionType, val value: String)

data class PartnerRecruitmentMatch(
    val recruitment: PartnerRecruitment,
    val score: Int,
    val reasons: List<PartnerMatchReason>,
    val cautions: List<PartnerMatchCaution>,
)

/** 거르는 조건 하나를 뺐을 때 남는 모집글 수입니다. 결과가 적을 때 화면이 "빼고 보기"로 씁니다. */
enum class PartnerMatchRelaxType { ROLE, REGION, PROGRAM }

data class PartnerMatchRelax(val type: PartnerMatchRelaxType, val count: Int)

data class PartnerRecruitmentMatchResult(
    val matches: List<PartnerRecruitmentMatch>,
    /** 조건에 맞는 전체 건수입니다. [matches]는 그중 앞의 일부입니다. */
    val total: Int,
    val relax: List<PartnerMatchRelax>,
    /** 아직 아무도 모집글을 쓰지 않은 내 관심 공고 하나입니다. 모집글 쓰기를 권할 때 씁니다. */
    val suggestedProgram: PartnerMatchMyProgram?,
)

/**
 * 모집글 맞춤 추천 규칙입니다. AI 없이 저장된 정보만으로 계산합니다.
 *
 * 거르는 조건은 상대 모집글이 정한 조건과 사용자가 말한 조건입니다. 마감된 글, 내 글, 이미 제안한 글, 찾는 역할이 내 역할에 없는 글,
 * 내 업력이 최소 업력보다 짧은 글, 말한 역할·지역·공고와 다른 글은 뺍니다.
 * 남은 글은 내 관심 공고·신청 준비와 같은 공고(+3), 말한 분야 말(+2씩), 겹친 역량(+1씩, 최대 3), 같은 희망 지역(+1)으로 점수를 매기고
 * 점수가 같으면 모집 마감이 가까운 순입니다. 희망 지역이 달라도 거르지 않고 확인할 점으로만 알립니다.
 */
object PartnerRecruitmentMatcher {
    private const val MY_PROGRAM_SCORE = 3
    private const val KEYWORD_SCORE = 2
    private const val MAX_CAPABILITY_SCORE = 3

    fun match(
        candidates: List<PartnerRecruitment>,
        applicant: PartnerMatchApplicant,
        conditions: PartnerMatchConditions,
        today: LocalDate,
        limit: Int,
    ): PartnerRecruitmentMatchResult {
        require(limit >= 1) { "limit must be positive" }
        val open = candidates.filter { it.status(today) == PartnerRecruitmentStatus.OPEN }
        val eligible = open.filter { isEligible(it, applicant, today) }
        val matches = eligible.filter { meets(it, conditions, skip = null) }
            .map { score(it, applicant, conditions) }
            .sortedWith(
                compareByDescending<PartnerRecruitmentMatch> { it.score }
                    .thenBy { it.recruitment.content.recruitmentDeadline }
                    .thenByDescending { it.recruitment.id },
            )
        val relax = buildList {
            if (conditions.seekingRoles.isNotEmpty()) add(PartnerMatchRelax(PartnerMatchRelaxType.ROLE, eligible.count { meets(it, conditions, PartnerMatchRelaxType.ROLE) }))
            if (conditions.regions.isNotEmpty()) add(PartnerMatchRelax(PartnerMatchRelaxType.REGION, eligible.count { meets(it, conditions, PartnerMatchRelaxType.REGION) }))
            if (conditions.program != null) add(PartnerMatchRelax(PartnerMatchRelaxType.PROGRAM, eligible.count { meets(it, conditions, PartnerMatchRelaxType.PROGRAM) }))
        }
        val programsWithRecruitment = open.map { PartnerMatchProgram(it.program.sourceCode, it.program.sourceProgramId) }.toSet()
        val suggested = applicant.programs.firstOrNull {
            it.source == PartnerMatchProgramSource.SAVED && it.isOpen && it.program !in programsWithRecruitment
        }
        return PartnerRecruitmentMatchResult(matches.take(limit), matches.size, relax, suggested)
    }

    private fun isEligible(recruitment: PartnerRecruitment, applicant: PartnerMatchApplicant, today: LocalDate): Boolean {
        if (recruitment.isOwnedBy(applicant.accountId) || recruitment.id in applicant.proposedRecruitmentIds) return false
        if (applicant.roles.isNotEmpty() && recruitment.content.seekingRole !in applicant.roles) return false
        val minimumAge = recruitment.content.minimumCompanyAgeYears
        val foundedYear = applicant.foundedYear
        return minimumAge == null || foundedYear == null || today.year - foundedYear >= minimumAge
    }

    private fun meets(recruitment: PartnerRecruitment, conditions: PartnerMatchConditions, skip: PartnerMatchRelaxType?): Boolean {
        val content = recruitment.content
        if (skip != PartnerMatchRelaxType.ROLE && conditions.seekingRoles.isNotEmpty() && content.seekingRole !in conditions.seekingRoles) return false
        if (skip != PartnerMatchRelaxType.REGION && conditions.regions.isNotEmpty() &&
            content.region != PartnerRecruitmentQuery.NATIONWIDE_REGION && content.region !in conditions.regions
        ) return false
        val program = conditions.program
        if (skip != PartnerMatchRelaxType.PROGRAM && program != null &&
            (recruitment.program.sourceCode != program.sourceCode || recruitment.program.sourceProgramId != program.sourceProgramId)
        ) return false
        return true
    }

    private fun score(recruitment: PartnerRecruitment, applicant: PartnerMatchApplicant, conditions: PartnerMatchConditions): PartnerRecruitmentMatch {
        val content = recruitment.content
        val reasons = mutableListOf<PartnerMatchReason>()
        val cautions = mutableListOf<PartnerMatchCaution>()
        var score = 0

        val identity = PartnerMatchProgram(recruitment.program.sourceCode, recruitment.program.sourceProgramId)
        applicant.programs.firstOrNull { it.program == identity }?.let { mine ->
            score += MY_PROGRAM_SCORE
            reasons += PartnerMatchReason(PartnerMatchReasonType.MY_PROGRAM, listOf(recruitment.program.title), mine.source)
        }

        val searchable = normalize(listOf(content.title, content.body, recruitment.program.title).plus(content.capabilities).joinToString(" "))
        val keywordHits = conditions.keywords.filter { normalize(it).let { keyword -> keyword.isNotEmpty() && searchable.contains(keyword) } }
        if (keywordHits.isNotEmpty()) {
            score += KEYWORD_SCORE * keywordHits.size
            reasons += PartnerMatchReason(PartnerMatchReasonType.KEYWORD, keywordHits)
        }

        val capabilityHits = content.capabilities.filter { needed -> applicant.capabilities.any { capabilityMatches(needed, it) } }
        if (capabilityHits.isNotEmpty()) {
            score += minOf(capabilityHits.size, MAX_CAPABILITY_SCORE)
            reasons += PartnerMatchReason(PartnerMatchReasonType.CAPABILITY, capabilityHits)
        }

        val region = content.region
        if (applicant.region != null && region == applicant.region) {
            score += 1
            reasons += PartnerMatchReason(PartnerMatchReasonType.SAME_REGION, listOf(region))
        } else if (applicant.region != null && region != PartnerRecruitmentQuery.NATIONWIDE_REGION) {
            cautions += PartnerMatchCaution(PartnerMatchCautionType.OTHER_REGION, region)
        }
        val minimumAge = content.minimumCompanyAgeYears
        if (minimumAge != null && applicant.foundedYear == null) {
            cautions += PartnerMatchCaution(PartnerMatchCautionType.COMPANY_AGE, minimumAge.toString())
        }
        // 다른 이유가 없어도 찾는 역할이 내 역할과 맞아서 남은 글입니다. 역할을 정하지 않았으면 이 이유를 붙이지 않습니다.
        if (reasons.isEmpty() && applicant.roles.isNotEmpty()) {
            reasons += PartnerMatchReason(PartnerMatchReasonType.ROLE, listOf(content.seekingRole.name))
        }
        return PartnerRecruitmentMatch(recruitment, score, reasons, cautions)
    }

    /** 자유 입력 역량은 띄어쓰기·대소문자를 무시하고, 두 글자 이상이면 한쪽이 다른 쪽을 품을 때도 같은 역량으로 봅니다. */
    private fun capabilityMatches(needed: String, mine: String): Boolean {
        val a = normalize(needed)
        val b = normalize(mine)
        if (a.isEmpty() || b.isEmpty()) return false
        return a == b || (minOf(a.length, b.length) >= 2 && (a.contains(b) || b.contains(a)))
    }

    private fun normalize(text: String): String = text.lowercase().filterNot { it.isWhitespace() }
}
