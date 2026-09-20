package ai.govbiz.core.supportprogram.client.bizinfo.config

import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class BizInfoSourceDocumentPropertiesTest {

    @ParameterizedTest
    @ValueSource(
        strings = [
            "https://bizinfo.go.kr",
            "https://www.bizinfo.go.kr/",
            "https://notice.bizinfo.go.kr",
            "https://www.bizinfo.go.kr:443",
        ],
    )
    fun acceptsOfficialBizInfoHttpsBaseUrls(baseUrl: String) {
        val properties = BizInfoSourceDocumentProperties(
            URI.create(baseUrl),
            CONNECT_TIMEOUT,
            READ_TIMEOUT,
        )

        assertEquals(URI.create(baseUrl), properties.baseUrl)
        assertEquals(CONNECT_TIMEOUT, properties.connectTimeout)
        assertEquals(READ_TIMEOUT, properties.readTimeout)
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "http://www.bizinfo.go.kr",
            "https://example.com",
            "https://www.bizinfo.go.kr.example.com",
            "https://user:password@www.bizinfo.go.kr",
            "https://www.bizinfo.go.kr:444",
            "https://www.bizinfo.go.kr/detail",
            "https://www.bizinfo.go.kr?debug=true",
            "https://www.bizinfo.go.kr:0",
            "https://www.bizinfo.go.kr:65536",
        ],
    )
    fun rejectsUnsafeOrNonOfficialBaseUrls(baseUrl: String) {
        assertThrows(IllegalArgumentException::class.java) {
            BizInfoSourceDocumentProperties(
                URI.create(baseUrl),
                CONNECT_TIMEOUT,
                READ_TIMEOUT,
            )
        }
    }

    @ParameterizedTest
    @ValueSource(longs = [0, -1])
    fun rejectsNonPositiveTimeouts(seconds: Long) {
        assertThrows(IllegalArgumentException::class.java) {
            BizInfoSourceDocumentProperties(
                URI.create("https://www.bizinfo.go.kr"),
                Duration.ofSeconds(seconds),
                READ_TIMEOUT,
            )
        }
        assertThrows(IllegalArgumentException::class.java) {
            BizInfoSourceDocumentProperties(
                URI.create("https://www.bizinfo.go.kr"),
                CONNECT_TIMEOUT,
                Duration.ofSeconds(seconds),
            )
        }
    }

    private companion object {
        val CONNECT_TIMEOUT: Duration = Duration.ofSeconds(1)
        val READ_TIMEOUT: Duration = Duration.ofSeconds(2)
    }
}
