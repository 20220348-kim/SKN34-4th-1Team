package ai.govbiz.core.supportprogram.client.kstartup

import ai.govbiz.core.supportprogram.client.kstartup.config.KStartupClientProperties
import ai.govbiz.core.supportprogram.client.kstartup.config.KStartupCollectionScope
import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupPage
import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupProgramPayload
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import ai.govbiz.core.supportprogram.client.kstartup.helper.KStartupPageDecoderHelper
import ai.govbiz.core.supportprogram.client.kstartup.helper.executeKStartupHttpCall
import java.time.Clock
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode

@Component
class KStartupClient(
    @param:Qualifier("kStartupRestClient") private val restClient: RestClient,
    private val properties: KStartupClientProperties,
    @param:Qualifier("seoulClock") private val clock: Clock,
) {
    /** 날짜 경계는 전체 요청 동안 고정하며 matchCount 기준의 모든 페이지를 검증합니다. */
    fun fetchAll(): List<KStartupProgramPayload> {
        val key = properties.decodedApiKey()
        if (key.isBlank()) throw KStartupClientException.notConfigured()
        val (condition, value) = when (properties.scope) {
            KStartupCollectionScope.RECENT_YEAR -> "cond[pbanc_rcpt_bgng_dt::GTE]" to
                LocalDate.now(clock).minusYears(1).format(DateTimeFormatter.BASIC_ISO_DATE)
            KStartupCollectionScope.RECENT_THREE_MONTHS -> "cond[pbanc_rcpt_bgng_dt::GTE]" to
                LocalDate.now(clock).minusMonths(3).format(DateTimeFormatter.BASIC_ISO_DATE)
            KStartupCollectionScope.OPEN -> "cond[rcrt_prgs_yn::EQ]" to "Y"
        }
        val first = fetchPage(key, condition, value, 1)
        if (first.perPage !in 1..PAGE_SIZE || first.matchCount > MAX_ITEMS || first.matchCount > first.totalCount) {
            invalid("K-Startup API returned unsupported pagination metadata")
        }
        val pageCount = maxOf(1, ((first.matchCount.toLong() + first.perPage - 1) / first.perPage).toInt())
        if (pageCount > MAX_PAGES) invalid("K-Startup API exceeded the safe pagination limit")
        val programs = ArrayList<KStartupProgramPayload>(first.matchCount)
        val identities = HashSet<String>()
        for (pageNumber in 1..pageCount) {
            val page = if (pageNumber == 1) first else fetchPage(key, condition, value, pageNumber)
            validatePage(page, pageNumber, first)
            for (program in page.items) {
                val id = program.id
                if (id == null || !PROGRAM_ID.matches(id)) invalid("K-Startup API returned an invalid pbanc_sn")
                if (!identities.add(id)) invalid("K-Startup API returned duplicate pbanc_sn values")
                programs.add(program)
            }
        }
        if (programs.size != first.matchCount) invalid("K-Startup API returned an incomplete snapshot")
        return java.util.List.copyOf(programs)
    }

    private fun validatePage(page: KStartupPage, expected: Int, first: KStartupPage) {
        val remaining = first.matchCount.toLong() - (expected - 1L) * first.perPage
        val expectedCount = minOf(first.perPage.toLong(), remaining.coerceAtLeast(0)).toInt()
        if (page.page != expected || page.perPage != first.perPage || page.matchCount != first.matchCount ||
            page.totalCount != first.totalCount || page.currentCount != expectedCount || page.items.size != expectedCount) {
            invalid("K-Startup API returned an incomplete page or inconsistent pagination metadata")
        }
    }

    private fun fetchPage(key: String, condition: String, value: String, page: Int): KStartupPage =
        executeKStartupHttpCall {
            val body = restClient.get()
                .uri("$PROGRAMS_PATH?serviceKey={key}&page={page}&perPage={perPage}&returnType=JSON&$condition={value}",
                    key, page, PAGE_SIZE, value)
                .retrieve()
                .onStatus({ it.value() != HttpStatus.OK.value() }, { _, response ->
                    throw KStartupClientException.upstreamError(response.statusCode.value())
                })
                .body(JsonNode::class.java)
                ?: invalid("K-Startup API returned an empty response")
            KStartupPageDecoderHelper.decode(body)
        }

    private fun invalid(message: String): Nothing = throw KStartupClientException.invalidResponse(message)

    companion object {
        const val PROGRAMS_PATH = "/B552735/kisedKstartupService01/getAnnouncementInformation01"
        const val PAGE_SIZE = 1_000
        private const val MAX_ITEMS = 20_000
        private const val MAX_PAGES = 200
        private val PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
    }
}
