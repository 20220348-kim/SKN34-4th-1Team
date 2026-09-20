package ai.govbiz.catalog.internal

import ai.govbiz.catalog.internal.config.CatalogInternalAuthFilter
import jakarta.servlet.FilterChain
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockHttpServletRequest
import org.springframework.mock.web.MockHttpServletResponse

class CatalogInternalAuthFilterTest {
    private val token = "catalog-test-token-0123456789abcdef"

    @Test
    fun missingShortOrWhitespaceSecretsFailStartup() {
        listOf("", "short", " ".repeat(40), "x".repeat(32) + "\n", "x".repeat(1025)).forEach {
            assertThrows(IllegalArgumentException::class.java) { CatalogInternalAuthFilter(it) }
        }
        assertDoesNotThrow { CatalogInternalAuthFilter("x".repeat(32)) }
        assertDoesNotThrow { CatalogInternalAuthFilter("x".repeat(1024)) }
    }

    @Test
    fun onlyExactGetHealthAndReadinessSkipAuthorization() {
        val filter = CatalogInternalAuthFilter(token)
        for ((method, path, allowed) in listOf(Triple("GET", "/health", true), Triple("GET", "/readiness", true),
            Triple("POST", "/health", false), Triple("GET", "/health/", false),
            Triple("GET", "/internal/v1/catalog/snapshots/BIZINFO", false), Triple("GET", "/unknown", false))) {
            var called = false
            val response = MockHttpServletResponse()
            filter.doFilter(MockHttpServletRequest(method, path), response, FilterChain { _, _ -> called = true })
            assertEquals(allowed, called, "$method $path")
            if (!allowed) assertEquals(401, response.status)
            assertFalse(response.contentAsString.contains(token))
        }
    }

    @Test
    fun onlyOneExactBearerHeaderIsAccepted() {
        for (headers in listOf(listOf("Bearer $token"), listOf("Basic $token"), listOf("Bearer ${token}x"),
            listOf("Bearer $token", "Bearer $token"))) {
            val request = MockHttpServletRequest("GET", "/internal/v1/catalog/snapshots/BIZINFO")
            headers.forEach { request.addHeader("Authorization", it) }
            var called = false
            val response = MockHttpServletResponse()
            CatalogInternalAuthFilter(token).doFilter(request, response, FilterChain { _, _ -> called = true })
            assertEquals(headers == listOf("Bearer $token"), called)
        }
    }
}
