package ai.govbiz.core.supportprogram.client.msit

import ai.govbiz.core.supportprogram.client.msit.config.MsitClientProperties
import ai.govbiz.core.supportprogram.client.msit.dto.MsitPage
import ai.govbiz.core.supportprogram.client.msit.dto.MsitProgramPayload
import ai.govbiz.core.supportprogram.client.msit.exception.MsitClientException
import ai.govbiz.core.supportprogram.client.msit.helper.MsitDetailUrlHelper
import ai.govbiz.core.supportprogram.client.msit.helper.MsitPageDecoderHelper
import ai.govbiz.core.supportprogram.client.msit.helper.executeMsitHttpCall
import org.slf4j.LoggerFactory
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode

@Component
class MsitClient(
    @param:Qualifier("msitRestClient") private val restClient: RestClient,
    private val properties: MsitClientProperties,
) {
    fun fetchAll(): List<MsitProgramPayload> {
        val key = properties.decodedApiKey()
        if (key.isBlank()) throw MsitClientException.notConfigured()
        val first = fetchPage(key, 1)
        if (first.perPage !in 1..PAGE_SIZE || first.totalCount > MAX_ITEMS) invalid("MSIT API returned unsupported pagination metadata")
        val pageCount = maxOf(1, ((first.totalCount.toLong() + first.perPage - 1) / first.perPage).toInt())
        if (pageCount > MAX_PAGES) invalid("MSIT API exceeded the safe pagination limit")
        val programs = ArrayList<MsitProgramPayload>(first.totalCount)
        val identities = HashSet<String>()
        for (pageNumber in 1..pageCount) {
            val page = if (pageNumber == 1) first else fetchPage(key, pageNumber)
            validatePage(page, pageNumber, first)
            for (program in page.items) {
                val id = MsitDetailUrlHelper.extractProgramId(program.sourceUrl)
                if (!identities.add(id)) invalid("MSIT API returned duplicate announcement identities")
                programs.add(program)
            }
            if (pageNumber == 1 || pageNumber % 10 == 0 || pageNumber == pageCount) {
                logger.info("MSIT 공고 수집 진행: {}/{} 페이지, {}/{}건", pageNumber, pageCount, programs.size, first.totalCount)
            }
        }
        if (programs.size != first.totalCount) invalid("MSIT API returned an incomplete snapshot")
        return java.util.List.copyOf(programs)
    }

    private fun validatePage(page: MsitPage, expected: Int, first: MsitPage) {
        val remaining = first.totalCount.toLong() - (expected - 1L) * first.perPage
        val expectedCount = minOf(first.perPage.toLong(), remaining.coerceAtLeast(0)).toInt()
        if (page.page != expected || page.perPage != first.perPage || page.totalCount != first.totalCount || page.items.size != expectedCount) {
            invalid("MSIT API returned an incomplete page or inconsistent pagination metadata")
        }
    }

    private fun fetchPage(key: String, page: Int): MsitPage = executeMsitHttpCall {
        val body = restClient.get()
            .uri("$PROGRAMS_PATH?serviceKey={key}&pageNo={page}&numOfRows={perPage}&returnType=json", key, page, PAGE_SIZE)
            .retrieve()
            .onStatus({ it.value() != HttpStatus.OK.value() }, { _, response ->
                throw MsitClientException.upstreamError(response.statusCode.value())
            })
            .body(JsonNode::class.java) ?: invalid("MSIT API returned an empty response")
        MsitPageDecoderHelper.decode(body)
    }

    private fun invalid(message: String): Nothing = throw MsitClientException.invalidResponse(message)

    companion object {
        const val PROGRAMS_PATH = "/1721000/msitannouncementinfo/businessAnnouncMentList"
        // 운영 API가 요청 크기와 관계없이 10건을 반환하므로 해당 계약을 명시합니다.
        const val PAGE_SIZE = 10
        private const val MAX_ITEMS = 20_000
        private const val MAX_PAGES = 2_000
        private val logger = LoggerFactory.getLogger(MsitClient::class.java)
    }
}
