package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.supportprogram.controller.dto.SaveSupportProgramRequest
import ai.govbiz.core.supportprogram.controller.dto.SavedSupportProgramListResponse
import ai.govbiz.core.supportprogram.controller.dto.SavedSupportProgramResponse
import ai.govbiz.core.supportprogram.controller.dto.SavedSupportProgramStatusResponse
import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import ai.govbiz.core.supportprogram.service.saved.SavedSupportProgramService
import jakarta.validation.Valid
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

/**
 * 로그인한 회원의 관심 공고함입니다. 세션이 없으면 401이고, 담기·빼기는 세션 쿠키가 붙은 상태 변경이라 Origin 검사도 거칩니다.
 * 원본 ID에는 `/`가 올 수 있어 경로 대신 본문·쿼리로 받습니다.
 */
@RestController
@RequestMapping("/api/v1/me/saved-programs")
class SavedSupportProgramController(
    private val savedSupportProgramService: SavedSupportProgramService,
) {

    /** 최근에 담은 순서입니다. 더 이상 노출되지 않는 공고는 빠집니다. */
    @GetMapping
    fun list(account: Account): SavedSupportProgramListResponse =
        SavedSupportProgramListResponse(
            savedSupportProgramService.list(account.id).map(SavedSupportProgramResponse::from),
        )

    /** 공고 하나가 담겨 있는지입니다. 상세 화면이 담기 버튼 상태를 그릴 때 부릅니다. */
    @GetMapping("/status")
    fun status(
        account: Account,
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
    ): SavedSupportProgramStatusResponse =
        SavedSupportProgramStatusResponse(savedSupportProgramService.isSaved(account.id, sourceCode, sourceProgramId))

    /** 담습니다. 이미 담긴 공고는 그대로 두고 같은 응답을 줍니다. 없거나 숨겨진 공고는 404 `SUPPORT_PROGRAM_NOT_FOUND`입니다. */
    @PostMapping
    fun save(
        account: Account,
        @RequestBody @Valid request: SaveSupportProgramRequest,
    ): SavedSupportProgramResponse =
        SavedSupportProgramResponse.from(savedSupportProgramService.save(account.id, request.sourceCode, request.sourceProgramId))

    /** 뺍니다. 담기지 않은 공고를 빼도 204입니다. */
    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun remove(
        account: Account,
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
    ) {
        savedSupportProgramService.remove(account.id, sourceCode, sourceProgramId)
    }
}
