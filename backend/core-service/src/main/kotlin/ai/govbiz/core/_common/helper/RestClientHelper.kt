package ai.govbiz.core._common.helper

import java.net.URI
import java.net.http.HttpClient
import java.time.Duration
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder
import org.springframework.boot.http.client.HttpClientSettings
import org.springframework.boot.http.client.HttpRedirects
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.web.client.RestClient

/** [baseUrl]이 null이면 호출마다 절대 주소를 씁니다. 여러 호스트를 부르는 Client(소셜 로그인 공급자)가 그렇습니다. */
internal fun buildRestClient(
    builder: RestClient.Builder,
    baseUrl: URI?,
    connectTimeout: Duration,
    readTimeout: Duration,
): RestClient {
    val settings = HttpClientSettings.defaults()
        .withConnectTimeout(connectTimeout)
        .withReadTimeout(readTimeout)
        .withRedirects(HttpRedirects.DONT_FOLLOW)
    val requestFactory = ClientHttpRequestFactoryBuilder.jdk()
        .withHttpClientCustomizer { httpClientBuilder ->
            httpClientBuilder.version(HttpClient.Version.HTTP_1_1)
        }
        .build(settings)

    if (baseUrl != null) builder.baseUrl(baseUrl.toString())

    return builder
        .requestFactory(requestFactory)
        .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
        .build()
}

internal fun validateHttpBaseUrl(baseUrl: URI, propertyName: String) {
    val scheme = baseUrl.scheme
    val supportedScheme =
        "http".equals(scheme, ignoreCase = true) ||
            "https".equals(scheme, ignoreCase = true)
    if (!baseUrl.isAbsolute || !supportedScheme || baseUrl.host == null) {
        throw IllegalArgumentException(
            "$propertyName must be an absolute HTTP(S) URI with a host",
        )
    }

    val port = baseUrl.port
    if (port != -1 && port !in 1..65_535) {
        throw IllegalArgumentException(
            "$propertyName port must be between 1 and 65535",
        )
    }

    val path = baseUrl.path
    if (
        (path != null && path.isNotEmpty() && path != "/") ||
        baseUrl.query != null ||
        baseUrl.fragment != null ||
        baseUrl.userInfo != null
    ) {
        throw IllegalArgumentException(
            "$propertyName must contain only scheme, host, and optional port",
        )
    }
}

internal fun validatePositiveDuration(duration: Duration, propertyName: String) {
    if (duration.isZero || duration.isNegative) {
        throw IllegalArgumentException("$propertyName must be greater than zero")
    }
}
