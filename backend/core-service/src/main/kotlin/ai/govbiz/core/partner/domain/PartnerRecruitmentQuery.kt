package ai.govbiz.core.partner.domain

/** 목록 정렬입니다. 마감 임박순은 모집 마감일 오름차순, 최근 등록순은 등록 시각 내림차순입니다. */
enum class PartnerRecruitmentSort {
    DEADLINE,
    RECENT,
}

/**
 * 목록을 좁히는 조건입니다. 역할·지역은 여러 개를 함께 고를 수 있고 비어 있으면 전체입니다.
 * 지역을 고르면 그 지역들의 모집글과 전국 모집글이 함께 보이고, 전국만 고르면 전국 모집글만 보입니다.
 * 내 글 조회는 마감된 글도 포함하고, 그 외에는 모집 중인 글만 돌려줍니다.
 */
data class PartnerRecruitmentQuery(
    val keyword: String,
    val seekingRoles: Set<PartnerRole>,
    val regions: Set<String>,
    val mineAccountId: Long?,
    val sort: PartnerRecruitmentSort,
    val page: Int,
    val pageSize: Int,
    /** 묶인 공고의 출처(`BIZINFO` 등)입니다. null이면 모든 출처입니다. */
    val sourceCode: String? = null,
) {
    init {
        require(sourceCode == null || SOURCE_CODE_PATTERN.matches(sourceCode)) {
            "sourceCode must be an uppercase source code of at most 40 characters"
        }
        require(keyword == keyword.trim() && keyword.length <= MAX_KEYWORD_LENGTH) {
            "keyword must be a trimmed text of at most $MAX_KEYWORD_LENGTH characters"
        }
        require(regions.all { it.isNotEmpty() && it == it.trim() && it.length <= PartnerRecruitmentInput.MAX_REGION_LENGTH }) {
            "regions must be trimmed, non-empty texts of at most ${PartnerRecruitmentInput.MAX_REGION_LENGTH} characters"
        }
        require(page >= 1) { "page must be positive" }
        require(pageSize in 1..MAX_PAGE_SIZE) { "pageSize must be 1~$MAX_PAGE_SIZE" }
    }

    val offset: Int
        get() = (page - 1) * pageSize

    companion object {
        const val MAX_KEYWORD_LENGTH = 100
        const val MAX_PAGE_SIZE = 50
        const val NATIONWIDE_REGION = "전국"
        const val SOURCE_CODE_REGEX = "^[A-Z][A-Z0-9_]{0,39}$"
        private val SOURCE_CODE_PATTERN = Regex(SOURCE_CODE_REGEX)
    }
}

/** Repository가 읽은 한 페이지 원본입니다. 제안 수는 Service가 붙입니다. */
data class PartnerRecruitmentSlice(
    val recruitments: List<PartnerRecruitment>,
    val total: Long,
)

/** 조회한 회원 기준으로 상태·제안 수·내 제안을 붙인 모집글입니다. Service가 서울 기준 시각으로 만들고 응답은 이 값을 그대로 씁니다. */
data class PartnerRecruitmentView(
    val recruitment: PartnerRecruitment,
    val status: PartnerRecruitmentStatus,
    /** 철회하지 않은 제안 수입니다. */
    val proposalCount: Int,
    /** 조회한 회원이 이 모집글에 보낸 제안입니다. 없거나 비로그인이면 null입니다. */
    val myProposal: MyPartnerProposal?,
)

/** 모집글 상세에 붙는 내 제안 요약입니다. */
data class MyPartnerProposal(
    val id: Long,
    val status: PartnerProposalStatus,
)

/** 한 페이지 결과입니다. 총 건수는 같은 조건의 전체 건수입니다. */
data class PartnerRecruitmentPage(
    val recruitments: List<PartnerRecruitmentView>,
    val total: Long,
    val page: Int,
    val pageSize: Int,
) {
    val totalPages: Int
        get() = if (total == 0L) 0 else ((total - 1) / pageSize + 1).toInt()
}
