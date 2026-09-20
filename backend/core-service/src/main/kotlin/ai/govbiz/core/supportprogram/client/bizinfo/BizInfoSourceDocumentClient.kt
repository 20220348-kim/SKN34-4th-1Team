package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoSourceDocumentClientException
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.nio.charset.Charset
import java.nio.charset.StandardCharsets
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 검증된 기업마당 상세 URL에서 HTML 원문만 제한적으로 읽습니다. */
@Component
class BizInfoSourceDocumentClient(
    @param:Qualifier("bizInfoSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun fetchHtml(sourceUrl: String, sourceProgramId: String): String = executeHttpCall(
        onTimeout = { exception -> BizInfoSourceDocumentClientException.timeout(exception) },
        onUnavailable = { exception -> BizInfoSourceDocumentClientException.unavailable(exception) },
        onUpstreamError = { exception ->
            BizInfoSourceDocumentClientException.upstreamError(
                "BizInfo source document returned HTTP ${exception.statusCode.value()}",
                exception,
            )
        },
        onInvalidResponse = { exception ->
            BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document response could not be decoded",
                exception,
            )
        },
    ) {
        fetchWithValidatedRedirects(requireOfficialSourceUri(sourceUrl, sourceProgramId), sourceProgramId)
    }

    private fun fetchWithValidatedRedirects(initialUri: URI, sourceProgramId: String): String {
        var sourceUri = initialUri
        val visitedUris = mutableSetOf(initialUri)
        var redirectCount = 0
        while (true) {
            // exchange는 콜백이 끝나면 응답을 닫으므로, 리다이렉트 응답 본문도 읽을 필요가 없습니다.
            val html: String? = restClient.get()
                .uri(sourceUri)
                .accept(MediaType.TEXT_HTML)
                .exchange { _, response ->
                    if (response.statusCode.value() in REDIRECT_STATUSES) {
                        if (redirectCount >= MAX_REDIRECTS) {
                            throw BizInfoSourceDocumentClientException.invalidResponse(
                                "BizInfo source document exceeded the redirect limit",
                                null,
                            )
                        }
                        val location = response.headers.getFirst("Location")
                            ?: throw BizInfoSourceDocumentClientException.invalidResponse(
                                "BizInfo source document redirect did not contain a Location",
                                null,
                            )
                        val nextUri = requireOfficialSourceUri(location, sourceProgramId, sourceUri)
                        if (!visitedUris.add(nextUri)) {
                            throw BizInfoSourceDocumentClientException.invalidResponse(
                                "BizInfo source document contained a redirect cycle",
                                null,
                            )
                        }
                        sourceUri = nextUri
                        redirectCount++
                        return@exchange null
                    }
                    if (response.statusCode.value() != HttpStatus.OK.value()) {
                        throw BizInfoSourceDocumentClientException.upstreamError(
                            "BizInfo source document returned HTTP ${response.statusCode.value()}",
                            null,
                        )
                    }
                    val contentType = response.headers.contentType
                    if (contentType == null || !contentType.isCompatibleWith(MediaType.TEXT_HTML)) {
                        throw BizInfoSourceDocumentClientException.invalidResponse(
                            "BizInfo source document was not HTML",
                            null,
                        )
                    }
                    if (response.headers.contentLength > MAX_HTML_BYTES) {
                        throw BizInfoSourceDocumentClientException.invalidResponse(
                            "BizInfo source document exceeded the safe size limit",
                            null,
                        )
                    }
                    readBoundedHtml(
                        input = response.body,
                        charset = contentType.charset ?: StandardCharsets.UTF_8,
                    )
                }
            if (html != null) return html
        }
    }

    private fun requireOfficialSourceUri(value: String, sourceProgramId: String, baseUri: URI? = null): URI {
        val uri = try {
            URI(value).let { baseUri?.resolve(it) ?: it }.normalize()
        } catch (exception: URISyntaxException) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document URL was invalid",
                exception,
            )
        } catch (exception: IllegalArgumentException) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document URL was invalid",
                exception,
            )
        }
        val host = uri.host
        val officialHost = host != null && (
            host.equals("bizinfo.go.kr", ignoreCase = true) ||
                host.lowercase().endsWith(".bizinfo.go.kr")
            )
        if (
            !uri.isAbsolute ||
            !uri.scheme.equals("https", ignoreCase = true) ||
            !officialHost ||
            uri.userInfo != null ||
            (uri.port != -1 && uri.port != 443)
        ) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document URL was not an official HTTPS URL",
                null,
            )
        }
        val publicationIds = queryParameterValues(uri, "pblancId")
        if (publicationIds.size != 1 || publicationIds.single() != sourceProgramId) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document URL did not identify the requested program",
                null,
            )
        }
        return uri
    }

    private fun queryParameterValues(uri: URI, name: String): List<String> =
        uri.rawQuery
            ?.split('&')
            ?.mapNotNull { part ->
                val separator = part.indexOf('=')
                if (separator < 0) return@mapNotNull null
                val key = decodeQueryComponent(part.substring(0, separator))
                if (key == name) decodeQueryComponent(part.substring(separator + 1)) else null
            }
            ?: emptyList()

    private fun decodeQueryComponent(value: String): String =
        try {
            URLDecoder.decode(value, StandardCharsets.UTF_8)
        } catch (exception: IllegalArgumentException) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document URL query was invalid",
                exception,
            )
        }

    private fun readBoundedHtml(input: InputStream, charset: Charset): String {
        val bytes = ByteArrayOutputStream()
        val buffer = ByteArray(BUFFER_SIZE)
        var remaining = MAX_HTML_BYTES
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read > remaining) {
                throw BizInfoSourceDocumentClientException.invalidResponse(
                    "BizInfo source document exceeded the safe size limit",
                    null,
                )
            }
            bytes.write(buffer, 0, read)
            remaining -= read
        }
        if (bytes.size() == 0) {
            throw BizInfoSourceDocumentClientException.invalidResponse(
                "BizInfo source document was empty",
                null,
            )
        }
        return String(bytes.toByteArray(), charset)
    }

    private companion object {
        const val MAX_HTML_BYTES = 500_000
        const val BUFFER_SIZE = 8_192
        const val MAX_REDIRECTS = 3
        val REDIRECT_STATUSES = setOf(301, 302, 303, 307, 308)
    }
}
