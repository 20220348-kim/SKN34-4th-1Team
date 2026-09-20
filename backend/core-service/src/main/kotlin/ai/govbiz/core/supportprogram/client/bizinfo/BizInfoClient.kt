package ai.govbiz.core.supportprogram.client.bizinfo

import ai.govbiz.core.supportprogram.client.bizinfo.config.BizInfoClientProperties
import ai.govbiz.core.supportprogram.client.bizinfo.dto.BizInfoPage
import ai.govbiz.core.supportprogram.client.bizinfo.dto.BizInfoProgramPayload
import ai.govbiz.core.supportprogram.client.bizinfo.exception.BizInfoClientException
import ai.govbiz.core.supportprogram.client.bizinfo.helper.BizInfoPageDecoderHelper
import ai.govbiz.core.supportprogram.client.bizinfo.helper.executeBizInfoHttpCall
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode

@Component
class BizInfoClient(
    @param:Qualifier("bizInfoRestClient") private val restClient: RestClient,
    private val properties: BizInfoClientProperties,
) {

    fun fetchAll(): List<BizInfoProgramPayload> {
        val serviceKey = properties.decodedServiceKey()
        if (serviceKey.isBlank()) {
            throw BizInfoClientException.notConfigured()
        }

        val firstPage = fetchPage(serviceKey, 1)
        val pageCount = maxOf(
            1,
            ((firstPage.totalCount.toLong() + firstPage.pageSize - 1L) / firstPage.pageSize).toInt(),
        )
        if (pageCount > MAX_PAGES) {
            throw BizInfoClientException.invalidResponse(
                "BizInfo API result exceeded the safe pagination limit",
                null,
            )
        }
        validatePage(firstPage, 1, firstPage.totalCount, firstPage.pageSize)

        val programs = ArrayList<BizInfoProgramPayload>(firstPage.totalCount)
        addPageItems(programs, firstPage.items)
        for (pageNumber in 2..pageCount) {
            val page = fetchPage(serviceKey, pageNumber)
            validatePage(page, pageNumber, firstPage.totalCount, firstPage.pageSize)
            addPageItems(programs, page.items)
        }
        if (programs.size != firstPage.totalCount) {
            throw BizInfoClientException.invalidResponse(
                "BizInfo API returned an incomplete paginated result",
                null,
            )
        }
        return java.util.List.copyOf(programs)
    }

    private fun validatePage(
        page: BizInfoPage,
        expectedPageNumber: Int,
        expectedTotalCount: Int,
        expectedPageSize: Int,
    ) {
        if (
            page.pageNumber != expectedPageNumber ||
            page.totalCount != expectedTotalCount ||
            page.pageSize != expectedPageSize
        ) {
            throw BizInfoClientException.invalidResponse(
                "BizInfo API returned inconsistent pagination metadata",
                null,
            )
        }

        val firstItemIndex = (expectedPageNumber - 1L) * expectedPageSize
        val remaining = expectedTotalCount - firstItemIndex
        val expectedItemCount = minOf(expectedPageSize.toLong(), remaining.coerceAtLeast(0L)).toInt()
        if (page.items.size != expectedItemCount) {
            throw BizInfoClientException.invalidResponse(
                "BizInfo API returned an incomplete page",
                null,
            )
        }
    }

    private fun addPageItems(
        programs: MutableList<BizInfoProgramPayload>,
        pageItems: List<BizInfoProgramPayload>,
    ) {
        if (programs.size + pageItems.size > MAX_ITEMS) {
            throw BizInfoClientException.invalidResponse(
                "BizInfo API result exceeded the safe item limit",
                null,
            )
        }
        programs.addAll(pageItems)
    }

    private fun fetchPage(serviceKey: String, pageNumber: Int): BizInfoPage =
        executeBizInfoHttpCall {
            val response = restClient.get()
                .uri(
                    PROGRAMS_PATH +
                        "?serviceKey={serviceKey}" +
                        "&pageNo={pageNo}" +
                        "&numOfRows={numOfRows}" +
                        "&dataType=json",
                    serviceKey,
                    pageNumber,
                    PAGE_SIZE,
                )
                .retrieve()
                .onStatus(
                    { statusCode -> statusCode.value() != HttpStatus.OK.value() },
                    { _, clientResponse ->
                        throw BizInfoClientException.upstreamError(
                            "BizInfo API returned unexpected HTTP " +
                                clientResponse.statusCode.value(),
                            null,
                        )
                    },
                )
                .toEntity(JsonNode::class.java)

            val body = response.body
                ?: throw BizInfoClientException.invalidResponse(
                    "BizInfo API returned an empty response",
                    null,
                )
            BizInfoPageDecoderHelper.decode(body, PAGE_SIZE)
        }

    companion object {
        const val PROGRAMS_PATH = "/1421000/bizinfo/pblancBsnsService"
        const val PAGE_SIZE = 1_000
        private const val MAX_PAGES = 20
        private const val MAX_ITEMS = PAGE_SIZE * MAX_PAGES
    }
}
