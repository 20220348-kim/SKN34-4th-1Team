package ai.govbiz.core.partner.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.partner.controller.dto.CreatePartnerRecruitmentRequest
import ai.govbiz.core.partner.controller.dto.PartnerRecruitmentListResponse
import ai.govbiz.core.partner.controller.dto.PartnerRecruitmentResponse
import ai.govbiz.core.partner.controller.dto.UpdatePartnerRecruitmentRequest
import ai.govbiz.core.partner.domain.PartnerRecruitmentInput
import ai.govbiz.core.partner.domain.PartnerRecruitmentQuery
import ai.govbiz.core.partner.domain.PartnerRecruitmentSort
import ai.govbiz.core.partner.domain.PartnerRole
import ai.govbiz.core.partner.service.PartnerRecruitmentService
import ai.govbiz.core.partner.service.exception.RecruitmentRegionFilterInvalidException
import jakarta.validation.Valid
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import org.springframework.http.HttpStatus
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.PutMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 파트너 모집글입니다. 읽기는 누구나, 작성은 기업을 등록한 회원만, 수정·마감은 작성자만 할 수 있습니다. [Account]는 세션 쿠키로 채워집니다. */
@RestController
@RequestMapping("/api/v1/partners/recruitments")
class PartnerRecruitmentController(
    private val recruitmentService: PartnerRecruitmentService,
) {

    @PostMapping
    fun create(
        account: Account,
        @RequestBody @Valid request: CreatePartnerRecruitmentRequest,
    ): ResponseEntity<PartnerRecruitmentResponse> {
        val view = recruitmentService.create(account, request.sourceCode.trim(), request.sourceProgramId.trim(), request.toInput())
        return ResponseEntity.status(HttpStatus.CREATED).body(PartnerRecruitmentResponse.from(view, account.id))
    }

    /**
     * 목록은 비로그인도 읽을 수 있습니다. 검색어·찾는 역할·지역·정렬은 화면 조건과 같고 역할·지역은 같은 이름의
     * 파라미터를 여러 번 보내 함께 고를 수 있습니다(`region=서울&region=부산`). `sourceCode`는 묶인 공고의 출처로 좁힙니다.
     * `mine=true`는 세션이 있어야 하며 마감된 내 글도 포함합니다.
     */
    @GetMapping
    fun list(
        account: Account?,
        @RequestParam(defaultValue = "") @Size(max = PartnerRecruitmentQuery.MAX_KEYWORD_LENGTH) keyword: String,
        @RequestParam(required = false) seekingRole: List<PartnerRole>?,
        @RequestParam(required = false) region: List<String>?,
        @RequestParam(defaultValue = "false") mine: Boolean,
        @RequestParam(defaultValue = "DEADLINE") sort: PartnerRecruitmentSort,
        @RequestParam(defaultValue = "1") @Min(1) @Max(100_000) page: Int,
        @RequestParam(defaultValue = "20") @Min(1) @Max(50) pageSize: Int,
        @RequestParam(required = false) @Pattern(regexp = "^$|" + PartnerRecruitmentQuery.SOURCE_CODE_REGEX) sourceCode: String?,
    ): PartnerRecruitmentListResponse {
        // 세션 쿠키 유무는 웹 계층만 알 수 있으므로 내 글 조회의 로그인 요구는 여기서 판단합니다.
        if (mine && account == null) throw AuthenticationRequiredException()
        // 목록 파라미터(List<String>)의 요소 길이는 메서드 검증이 보지 못하므로 여기서 확인합니다.
        val regions = region.orEmpty().map { it.trim() }.filter { it.isNotEmpty() }.toSet()
        if (regions.any { it.length > PartnerRecruitmentInput.MAX_REGION_LENGTH }) throw RecruitmentRegionFilterInvalidException()
        val query = PartnerRecruitmentQuery(
            keyword = keyword.trim(),
            seekingRoles = seekingRole.orEmpty().toSet(),
            regions = regions,
            mineAccountId = if (mine) account?.id else null,
            sort = sort,
            page = page,
            pageSize = pageSize,
            sourceCode = sourceCode?.ifEmpty { null },
        )
        return PartnerRecruitmentListResponse.from(recruitmentService.findPage(query), account?.id)
    }

    /** 작성자만 모집 중인 글을 고칩니다. 묶인 공고는 바꿀 수 없어 요청에 공고 식별자가 없습니다. */
    @PutMapping("/{id}")
    fun update(
        account: Account,
        @PathVariable id: Long,
        @RequestBody @Valid request: UpdatePartnerRecruitmentRequest,
    ): PartnerRecruitmentResponse =
        PartnerRecruitmentResponse.from(recruitmentService.update(account, id, request.toInput()), account.id)

    /** 작성자가 모집을 수동으로 마감합니다. 대기 중인 제안은 만료로 계산됩니다. */
    @PostMapping("/{id}/close")
    fun close(account: Account, @PathVariable id: Long): PartnerRecruitmentResponse =
        PartnerRecruitmentResponse.from(recruitmentService.close(account, id), account.id)

    /** 비로그인도 읽을 수 있으므로 [Account]는 선택입니다. 쿠키가 있으면 내 글 여부와 내 제안을 함께 돌려줍니다. */
    @GetMapping("/{id}")
    fun detail(account: Account?, @PathVariable id: Long): PartnerRecruitmentResponse =
        PartnerRecruitmentResponse.from(recruitmentService.findView(id, account?.id), account?.id)
}
