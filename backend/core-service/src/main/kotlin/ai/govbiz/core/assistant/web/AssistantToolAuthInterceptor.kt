package ai.govbiz.core.assistant.web

import ai.govbiz.core.assistant.config.AssistantAgentProperties
import ai.govbiz.core.assistant.service.AssistantToolTokenService
import ai.govbiz.core.assistant.service.exception.AssistantToolUnauthorizedException
import ai.govbiz.core.assistant.service.exception.AssistantToolsDisabledException
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.web.servlet.HandlerInterceptor

/**
 * 도우미 도구 API(`/internal/v1/assistant/tools/` 아래)의 문지기입니다.
 * 공유 비밀 헤더와 계정 묶음 토큰이 둘 다 맞아야 통과하고, 토큰의 계정과 요청의 `accountId`가 같아야 합니다.
 * 세션 쿠키는 보지 않습니다. 이 경로는 브라우저가 아니라 AI Service만 부릅니다.
 */
class AssistantToolAuthInterceptor(
    private val properties: AssistantAgentProperties,
    private val tokenService: AssistantToolTokenService,
) : HandlerInterceptor {

    override fun preHandle(request: HttpServletRequest, response: HttpServletResponse, handler: Any): Boolean {
        if (!properties.toolsEnabled) throw AssistantToolsDisabledException()
        if (!tokenService.matchesSecret(request.getHeader(SECRET_HEADER))) throw AssistantToolUnauthorizedException()
        val accountId = request.getParameter(ACCOUNT_PARAMETER)?.toLongOrNull()?.takeIf { it > 0 }
            ?: throw AssistantToolUnauthorizedException()
        if (!tokenService.verify(request.getHeader(TOKEN_HEADER), accountId)) throw AssistantToolUnauthorizedException()
        return true
    }

    companion object {
        const val SECRET_HEADER = "X-Internal-Token"
        const val TOKEN_HEADER = "X-Assistant-Tool-Token"
        const val ACCOUNT_PARAMETER = "accountId"
        const val PATH_PATTERN = "/internal/v1/assistant/tools/**"
    }
}
