package ai.govbiz.core.supportprogram.client.ops.config

import java.net.URI
import java.time.Duration
import org.springframework.boot.context.properties.ConfigurationProperties

/** 표본 수집만 제어한다. 운영 본문은 Langfuse에 보내지 않으며 이 별도 경계를 명시적으로 켠다. */
@ConfigurationProperties("app.llmops.production-sample")
class ProductionQualityProperties(
    val rateBps: Int = 0,
    val baseUrl: String = "",
    val token: String = "",
    val release: String = "",
    val requestTimeout: Duration = Duration.ofSeconds(15),
) {
    val endpoint: URI?

    init {
        require(rateBps in 0..10_000) { "production sample rate must be between 0 and 10000" }
        require(requestTimeout >= Duration.ofSeconds(1) && requestTimeout <= Duration.ofSeconds(30)) {
            "production sample request timeout must be between 1 and 30 seconds"
        }
        endpoint = if (rateBps == 0) null else {
            require(token.length >= 32 && token.all { it.code in 33..126 }) {
                "production sample token must have at least 32 printable characters"
            }
            val origin = try { URI(baseUrl) } catch (_: Exception) {
                throw IllegalArgumentException("production sample URL must be an HTTP origin")
            }
            require(
                origin.scheme in setOf("http", "https") && !origin.host.isNullOrBlank() &&
                    origin.rawUserInfo == null && origin.rawQuery == null && origin.rawFragment == null &&
                    origin.rawPath in setOf("", "/"),
            ) { "production sample URL must be an HTTP origin" }
            origin.resolve("/internal/llmops/production-samples")
        }
    }
}
