package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core.supportprogram.controller.dto.SupportProgramAttachmentListResponse
import ai.govbiz.core.supportprogram.controller.validation.CodePointMax
import ai.govbiz.core.supportprogram.service.attachment.SupportProgramAttachmentService
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.constraints.Max
import jakarta.validation.constraints.Min
import jakarta.validation.constraints.NotBlank
import jakarta.validation.constraints.Pattern
import jakarta.validation.constraints.Size
import java.nio.charset.StandardCharsets
import org.springframework.http.CacheControl
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

/** 공고 상세의 공식 첨부 목록과 받기입니다. 공고 상세처럼 로그인 없이 쓰며 원본 주소는 내보내지 않습니다. */
@RestController
@RequestMapping("/api/v1/support-programs/detail/attachments")
class SupportProgramAttachmentController(private val service: SupportProgramAttachmentService) {
    @GetMapping
    fun list(
        @RequestParam @NotBlank @Size(max = 64) @Pattern(regexp = SOURCE_CODE) sourceCode: String,
        @RequestParam @NotBlank @CodePointMax(max = 255) @Pattern(regexp = PROGRAM_ID) sourceProgramId: String,
        httpRequest: HttpServletRequest,
    ): ResponseEntity<SupportProgramAttachmentListResponse> =
        ResponseEntity.ok().cacheControl(CacheControl.noStore())
            .body(SupportProgramAttachmentListResponse.from(service.list(sourceCode, sourceProgramId, httpRequest.remoteAddr)))

    @GetMapping("/download")
    fun download(
        @RequestParam @NotBlank @Size(max = 64) @Pattern(regexp = SOURCE_CODE) sourceCode: String,
        @RequestParam @NotBlank @CodePointMax(max = 255) @Pattern(regexp = PROGRAM_ID) sourceProgramId: String,
        @RequestParam @Min(0) @Max(99) index: Int,
        httpRequest: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        service.download(sourceCode, sourceProgramId, index, httpRequest.remoteAddr) { fileName, contentLength ->
            // 원본의 파일 이름 헤더는 인코딩이 제각각(K-Startup은 EUC-KR)이라 공고 화면에서 읽은 이름을 UTF-8로 다시 붙입니다.
            // 내용은 해석하지 않도록 항상 내려받기 형식으로 보냅니다.
            response.contentType = MediaType.APPLICATION_OCTET_STREAM_VALUE
            response.setHeader(HttpHeaders.CONTENT_DISPOSITION,
                ContentDisposition.attachment().filename(fileName, StandardCharsets.UTF_8).build().toString())
            response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store")
            response.setHeader("X-Content-Type-Options", "nosniff")
            if (contentLength >= 0) response.setContentLengthLong(contentLength)
            response.outputStream
        }
    }

    private companion object {
        const val SOURCE_CODE = "[A-Z][A-Z0-9_]{0,63}"
        const val PROGRAM_ID = "(?Us)^(?!\\s)(?!.*\\s$)(?!.*\\p{C}).+$"
    }
}
