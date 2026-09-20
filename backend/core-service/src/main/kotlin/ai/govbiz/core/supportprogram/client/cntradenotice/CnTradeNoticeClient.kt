package ai.govbiz.core.supportprogram.client.cntradenotice

import ai.govbiz.core.supportprogram.client.cntradenotice.config.CnTradeNoticeClientProperties
import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticePage
import ai.govbiz.core.supportprogram.client.cntradenotice.dto.CnTradeNoticeProgramPayload
import ai.govbiz.core.supportprogram.client.cntradenotice.exception.CnTradeNoticeClientException
import ai.govbiz.core.supportprogram.client.cntradenotice.helper.CnTradeNoticePageDecoderHelper
import ai.govbiz.core.supportprogram.client.cntradenotice.helper.executeCnTradeNoticeHttpCall
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode

@Component
class CnTradeNoticeClient(
    @param:Qualifier("cnTradeNoticeRestClient") private val restClient: RestClient,
    private val properties: CnTradeNoticeClientProperties,
) {
    /** 필터 없는 전체 공지를 수집하고 완전성이 확인된 스냅샷만 반환합니다. */
    fun fetchAll(): List<CnTradeNoticeProgramPayload> {
        val key = properties.decodedApiKey()
        if (key.isBlank()) throw CnTradeNoticeClientException.notConfigured()
        val first = fetchPage(key, 1)
        if (first.numOfRows !in 1..PAGE_SIZE || first.totalCount > MAX_ITEMS) {
            invalid("CNTRADE_NOTICE API returned unsupported pagination metadata")
        }
        val pageCount = maxOf(1, ((first.totalCount.toLong() + first.numOfRows - 1) / first.numOfRows).toInt())
        if (pageCount > MAX_PAGES) invalid("CNTRADE_NOTICE API exceeded the safe pagination limit")
        val notices = ArrayList<CnTradeNoticeProgramPayload>(first.totalCount)
        val identities = HashSet<String>()
        for (pageNumber in 1..pageCount) {
            val page = if (pageNumber == 1) first else fetchPage(key, pageNumber)
            validatePage(page, pageNumber, first)
            for (notice in page.items) {
                val id = notice.id
                if (id == null || !NOTICE_ID.matches(id)) invalid("CNTRADE_NOTICE API returned an invalid lbbNo")
                if (!identities.add(id)) invalid("CNTRADE_NOTICE API returned duplicate lbbNo values")
                notices.add(notice)
            }
        }
        if (notices.size != first.totalCount) invalid("CNTRADE_NOTICE API returned an incomplete snapshot")
        return java.util.List.copyOf(notices)
    }

    private fun validatePage(page: CnTradeNoticePage, expected: Int, first: CnTradeNoticePage) {
        val remaining = first.totalCount.toLong() - (expected - 1L) * first.numOfRows
        val expectedCount = minOf(first.numOfRows.toLong(), remaining.coerceAtLeast(0)).toInt()
        if (page.pageNo != expected || page.numOfRows != first.numOfRows || page.totalCount != first.totalCount ||
            page.items.size != expectedCount) {
            invalid("CNTRADE_NOTICE API returned an incomplete page or inconsistent pagination metadata")
        }
    }

    private fun fetchPage(key: String, page: Int): CnTradeNoticePage = executeCnTradeNoticeHttpCall {
        val body = restClient.get()
            .uri("$NOTICES_PATH?serviceKey={key}&numOfRows={rows}&pageNo={page}", key, PAGE_SIZE, page)
            .retrieve()
            .onStatus({ it.value() != HttpStatus.OK.value() }, { _, response ->
                throw CnTradeNoticeClientException.upstreamError(response.statusCode.value())
            })
            .body(JsonNode::class.java)
            ?: invalid("CNTRADE_NOTICE API returned an empty response")
        CnTradeNoticePageDecoderHelper.decode(body)
    }

    private fun invalid(message: String): Nothing = throw CnTradeNoticeClientException.invalidResponse(message)

    companion object {
        const val NOTICES_PATH = "/6440000/CnTradeNotice/getNotiList"
        const val PAGE_SIZE = 1_000
        private const val MAX_ITEMS = 20_000
        private const val MAX_PAGES = 200
        private val NOTICE_ID = Regex("[1-9][0-9]{0,254}")
    }
}
