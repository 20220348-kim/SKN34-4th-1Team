package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.planusage.domain.PlanUsageFeature
import ai.govbiz.core.planusage.service.PlanUsageService
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramEvidenceAnswerResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramEvidenceQuestionRequest
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramDetailResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramSearchReadinessResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramSearchRequest
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramSearchResponse
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramSearchRestoreRequest
import ai.govbiz.core.supportprogram.controller.dto.SupportProgramSearchRestoreResponse
import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import ai.govbiz.core.supportprogram.service.admission.SupportProgramRequestAdmissionService
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import ai.govbiz.core.supportprogram.service.evidence.SupportProgramEvidenceService
import ai.govbiz.core.supportprogram.service.readiness.SupportProgramSearchReadinessService
import ai.govbiz.core.supportprogram.service.search.SupportProgramSearchPreviewService
import jakarta.servlet.http.HttpServletRequest
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import org.springframework.http.CacheControl
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/api/v1/support-programs")
class SupportProgramController(
    private val searchService: SupportProgramSearchPreviewService,
    private val readinessService: SupportProgramSearchReadinessService,
    private val detailService: SupportProgramDetailService,
    private val evidenceService: SupportProgramEvidenceService,
    private val requestAdmissionService: SupportProgramRequestAdmissionService,
    private val planUsageService: PlanUsageService,
) {

    @GetMapping("/search")
    fun search(
        account: Account?,
        @RequestParam
        @Size(max = 500)
        @Pattern(regexp = "(?s)^(?!.*[\\p{C}&&[^\\n\\r\\t]]).*$")
        query: String,
        @RequestParam(defaultValue = "true") acceptingOnly: Boolean,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<SupportProgramSearchResponse> = requestAdmissionService.execute(httpRequest.remoteAddr) {
        countingAiSearch(account, query, httpRequest) {
            ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
                SupportProgramSearchResponse.from(searchService.search(query, acceptingOnly, null, account?.id)),
            )
        }
    }

    @PostMapping("/search")
    fun searchWithCompanyConditions(
        account: Account?,
        @RequestBody @jakarta.validation.Valid request: SupportProgramSearchRequest,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<SupportProgramSearchResponse> = requestAdmissionService.execute(httpRequest.remoteAddr) {
        countingAiSearch(account, request.query, httpRequest) {
            ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
                SupportProgramSearchResponse.from(
                    searchService.search(request.query, request.acceptingOnly, request.companyConditions?.toDomain(), account?.id),
                ),
            )
        }
    }

    @PostMapping("/search/results")
    fun restoreSearchResults(
        account: Account,
        @RequestBody @jakarta.validation.Valid request: SupportProgramSearchRestoreRequest,
    ): ResponseEntity<SupportProgramSearchRestoreResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(
            SupportProgramSearchRestoreResponse.from(searchService.restore(request.resultToken, account.id)),
        )

    @GetMapping("/readiness")
    fun readiness(): SupportProgramSearchReadinessResponse =
        SupportProgramSearchReadinessResponse.from(readinessService.get())

    @GetMapping("/detail")
    fun detail(
        @RequestParam
        @NotBlank
        @Size(max = 64)
        @Pattern(regexp = "[A-Z][A-Z0-9_]{0,63}")
        sourceCode: String,
        @RequestParam
        @NotBlank
        @CodePointMax(max = 255)
        @Pattern(regexp = "(?Us)^(?!\\s)(?!.*\\s$)(?!.*\\p{C}).+$")
        sourceProgramId: String,
    ): SupportProgramDetailResponse =
        SupportProgramDetailResponse.from(detailService.get(sourceCode, sourceProgramId))

    /** 공고 원문 질문은 로그인한 회원만 씁니다. 요금제의 하루 질문 횟수에서 먼저 빼고 답하지 못하면 돌려줍니다. */
    @PostMapping("/detail/answers")
    fun answerFromOfficialSource(
        account: Account,
        @RequestBody @jakarta.validation.Valid request: SupportProgramEvidenceQuestionRequest,
        httpRequest: HttpServletRequest,
    ): SupportProgramEvidenceAnswerResponse = requestAdmissionService.execute(httpRequest.remoteAddr) {
        planUsageService.consume(account, httpRequest.remoteAddr, PlanUsageFeature.EVIDENCE_QUESTION) {
            SupportProgramEvidenceAnswerResponse.from(
                evidenceService.answer(
                    sourceCode = request.sourceCode,
                    sourceProgramId = request.sourceProgramId,
                    question = request.question,
                ),
            )
        }
    }

    /** 검색어가 있는 검색만 AI(의미 검색·순위)를 부르므로 그때만 AI 대화 검색 횟수로 셉니다. */
    private fun <T> countingAiSearch(account: Account?, query: String, httpRequest: HttpServletRequest, action: () -> T): T =
        if (query.isBlank()) action() else planUsageService.consume(account, httpRequest.remoteAddr, PlanUsageFeature.AI_SEARCH, action)
}
