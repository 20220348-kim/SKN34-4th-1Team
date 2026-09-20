package ai.govbiz.catalog.internal.config

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest
import org.springframework.beans.factory.annotation.Value
import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.stereotype.Component
import org.springframework.web.filter.OncePerRequestFilter

/** 내부 카탈로그 계약 전체에 같은 서비스 토큰을 적용합니다. 값은 로그나 응답에 넣지 않습니다. */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class CatalogInternalAuthFilter(@Value("\${app.catalog.internal-token}") token: String) : OncePerRequestFilter() {
    private val expected: ByteArray

    init {
        require(token.length in 32..1024 && token.all { it in '!'..'~' }) {
            "CATALOG_INTERNAL_TOKEN must contain 32 to 1024 visible ASCII characters"
        }
        expected = digest(token)
    }

    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.method == "GET" && request.requestURI in setOf("/health", "/readiness")

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        val values = request.getHeaders("Authorization").toList()
        val authorization = values.singleOrNull().orEmpty()
        val supplied = authorization.takeIf { it.startsWith("Bearer ") }?.removePrefix("Bearer ").orEmpty()
        // 서로 길이가 다른 토큰도 고정 길이 해시끼리 비교합니다.
        val matches = MessageDigest.isEqual(expected, digest(supplied))
        if (!matches || supplied.isEmpty()) {
            response.status = 401
            response.setHeader("WWW-Authenticate", "Bearer")
            response.setHeader("Cache-Control", "no-store")
            response.contentType = "application/json"
            response.writer.write("{\"code\":\"UNAUTHORIZED\"}")
            return
        }
        response.setHeader("Cache-Control", "no-store")
        chain.doFilter(request, response)
    }

    private fun digest(value: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(UTF_8))
}
