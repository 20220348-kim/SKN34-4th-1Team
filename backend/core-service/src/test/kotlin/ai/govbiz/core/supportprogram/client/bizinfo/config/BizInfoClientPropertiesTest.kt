package ai.govbiz.core.supportprogram.client.bizinfo.config

import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class BizInfoClientPropertiesTest {

    @ParameterizedTest
    @ValueSource(
        strings = [
            "http://bizinfo.internal:0",
            "http://bizinfo.internal:65536",
        ],
    )
    fun rejectsOutOfRangePorts(baseUrl: String) {
        val exception = assertThrows(IllegalArgumentException::class.java) {
            BizInfoClientProperties(
                URI.create(baseUrl),
                "service-key",
                Duration.ofSeconds(1),
                Duration.ofSeconds(2),
            )
        }

        assertEquals(
            "app.bizinfo.base-url port must be between 1 and 65535",
            exception.message,
        )
    }
}
