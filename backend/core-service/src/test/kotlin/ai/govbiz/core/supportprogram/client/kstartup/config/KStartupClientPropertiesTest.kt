package ai.govbiz.core.supportprogram.client.kstartup.config

import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.web.client.RestClient

class KStartupClientPropertiesTest {
    @Test
    fun decodesOnlyPercentEncodedKeysAndPreservesLiteralPlusSigns() {
        assertEquals("a+b/=", properties("a+b/=").decodedApiKey())
        assertEquals("a+b/=", properties("a%2Bb%2F%3D").decodedApiKey())
        assertEquals("a%broken", properties("a%broken").decodedApiKey())
        assertEquals("", properties(null).decodedApiKey())
    }

    @Test
    fun hasSafeDefaultsWithoutConfiguringAnyApiKey() {
        val properties = KStartupClientProperties(null, null, null, null)
        assertEquals(URI("https://apis.data.go.kr"), properties.baseUrl)
        assertEquals("", properties.apiKey)
        assertEquals(KStartupCollectionScope.RECENT_YEAR, properties.scope)
        assertEquals(Duration.ofSeconds(10), properties.readTimeout)
    }

    @Test
    fun bindsRecentThreeMonthsScopeFromConfiguration() {
        ApplicationContextRunner()
            .withBean(RestClient.Builder::class.java, { RestClient.builder() })
            .withUserConfiguration(KStartupClientConfig::class.java)
            .withPropertyValues("app.kstartup.scope=RECENT_THREE_MONTHS")
            .run {
                assertEquals(KStartupCollectionScope.RECENT_THREE_MONTHS,
                    it.getBean(KStartupClientProperties::class.java).scope)
            }
    }

    @Test
    fun rejectsUnsafeBaseUrlsAndInvalidTimeouts() {
        for (url in listOf("file:///tmp", "https://api.test/path", "https://user@api.test", "https://api.test?key=secret")) {
            assertThrows(IllegalArgumentException::class.java) { KStartupClientProperties(URI(url), "", null, null) }
        }
        assertThrows(IllegalArgumentException::class.java) { KStartupClientProperties(null, "", Duration.ZERO, null) }
        assertThrows(IllegalArgumentException::class.java) { KStartupClientProperties(null, "", null, Duration.ofSeconds(-1)) }
    }

    private fun properties(key: String?) = KStartupClientProperties(null, key, null, null)
}
