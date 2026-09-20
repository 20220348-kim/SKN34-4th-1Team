package ai.govbiz.core.supportprogram.client.msit.config

import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class MsitClientPropertiesTest {
    @Test
    fun decodesOnlyPercentEncodedKeysAndPreservesLiteralPlusSigns() {
        assertEquals("a+b/=", properties("a+b/=").decodedApiKey())
        assertEquals("a+b/=", properties("a%2Bb%2F%3D").decodedApiKey())
        assertEquals("a%broken", properties("a%broken").decodedApiKey())
        assertEquals("", properties(null).decodedApiKey())
    }

    @Test
    fun hasSafeDefaultsWithoutConfiguringAnyApiKey() {
        val properties = MsitClientProperties(null, null, null, null)
        assertEquals(URI("https://apis.data.go.kr"), properties.baseUrl)
        assertEquals("", properties.apiKey)
        assertEquals(Duration.ofSeconds(20), properties.readTimeout)
    }

    @Test
    fun rejectsUnsafeBaseUrlsAndInvalidTimeouts() {
        for (url in listOf("file:///tmp", "https://api.test/path", "https://user@api.test", "https://api.test?key=secret")) {
            assertThrows(IllegalArgumentException::class.java) { MsitClientProperties(URI(url), "", null, null) }
        }
        assertThrows(IllegalArgumentException::class.java) { MsitClientProperties(null, "", Duration.ZERO, null) }
        assertThrows(IllegalArgumentException::class.java) { MsitClientProperties(null, "", null, Duration.ofSeconds(-1)) }
    }

    private fun properties(key: String?) = MsitClientProperties(null, key, null, null)
}
