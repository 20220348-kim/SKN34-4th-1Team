package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core._common.helper.executeHttpCall
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupSourceDocumentClientException
import ai.govbiz.core.supportprogram.client.kstartup.helper.KStartupDetailPageHelper
import java.net.URI
import java.net.URISyntaxException
import java.nio.charset.StandardCharsets
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient

/** 검증된 K-Startup 공식 상세 URL에서 HTML 원문만 제한적으로 읽습니다. */
@Component
class KStartupSourceDocumentClient(
    @param:Qualifier("kStartupSourceDocumentRestClient") private val restClient: RestClient,
) {
    fun fetchHtml(sourceUrl: String, sourceProgramId: String): String = executeHttpCall(
        onTimeout = { exception -> KStartupSourceDocumentClientException.timeout(exception) },
        onUnavailable = { exception -> KStartupSourceDocumentClientException.unavailable(exception) },
        onUpstreamError = { exception ->
            KStartupSourceDocumentClientException.upstreamError(
                "K-Startup source document returned HTTP ${exception.statusCode.value()}",
                exception,
            )
        },
        onInvalidResponse = { exception ->
            KStartupSourceDocumentClientException.invalidResponse(
                "K-Startup source document response could not be decoded",
                exception,
            )
        },
    ) {
        fetchDetailHtml(sourceUrl, sourceProgramId)
    }

    /**
     * 마감된 공고의 진행 중 상세 페이지는 본문 없이 스크립트 변수 `fullUrl`로 마감 페이지만 알려 줍니다.
     * 같은 공고 번호의 공식 마감 페이지일 때만 한 번 따라가고, HTTP 리다이렉트는 따르지 않습니다.
     */
    private fun fetchDetailHtml(sourceUrl: String, sourceProgramId: String): String {
        val requested = requireDetailUri(sourceUrl, sourceProgramId)
        val html = fetchPage(requested)
        val fullUrl = KStartupDetailPageHelper.fullUrl(html) ?: return html
        val deadline = requireDetailUri(fullUrl, sourceProgramId, baseUri = requested)
        if (requested.path != KStartupDetailPageHelper.ONGOING_PATH || deadline.path != KStartupDetailPageHelper.DEADLINE_PATH) {
            throw KStartupSourceDocumentClientException.invalidResponse(
                "K-Startup source document pointed to an unexpected status page",
                null,
            )
        }
        val deadlineHtml = fetchPage(deadline)
        if (KStartupDetailPageHelper.fullUrl(deadlineHtml) != null) {
            throw KStartupSourceDocumentClientException.invalidResponse(
                "K-Startup source document contained a status page loop",
                null,
            )
        }
        return deadlineHtml
    }

    private fun requireDetailUri(value: String, sourceProgramId: String, baseUri: URI? = null): URI {
        val uri = try {
            URI(value).let { baseUri?.resolve(it) ?: it }
                .takeIf { KStartupDetailPageHelper.isDetailUri(it, sourceProgramId) }
        } catch (_: URISyntaxException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
        return uri ?: throw KStartupSourceDocumentClientException.invalidResponse(
            "K-Startup source document URL was not the official detail page of the requested program",
            null,
        )
    }

    private fun fetchPage(uri: URI): String = restClient.get()
        .uri(uri)
        .accept(MediaType.TEXT_HTML)
        .exchange { _, response ->
            if (response.statusCode.value() != HttpStatus.OK.value()) {
                throw KStartupSourceDocumentClientException.upstreamError(
                    "K-Startup source document returned HTTP ${response.statusCode.value()}",
                    null,
                )
            }
            val contentType = response.headers.contentType
            if (contentType == null || !contentType.isCompatibleWith(MediaType.TEXT_HTML)) {
                throw KStartupSourceDocumentClientException.invalidResponse(
                    "K-Startup source document was not HTML",
                    null,
                )
            }
            if (response.headers.contentLength > MAX_HTML_BYTES) throw oversized()
            val bytes = response.body.readNBytes(MAX_HTML_BYTES + 1)
            if (bytes.size > MAX_HTML_BYTES) throw oversized()
            if (bytes.isEmpty()) {
                throw KStartupSourceDocumentClientException.invalidResponse(
                    "K-Startup source document was empty",
                    null,
                )
            }
            String(bytes, contentType.charset ?: StandardCharsets.UTF_8)
        }

    private fun oversized() = KStartupSourceDocumentClientException.invalidResponse(
        "K-Startup source document exceeded the safe size limit",
        null,
    )

    private companion object {
        // 실제 상세 페이지는 140KB 안팎입니다. 첨부 수집과 같은 상한으로 비정상 응답만 막습니다.
        const val MAX_HTML_BYTES = 1_000_000
    }
}
