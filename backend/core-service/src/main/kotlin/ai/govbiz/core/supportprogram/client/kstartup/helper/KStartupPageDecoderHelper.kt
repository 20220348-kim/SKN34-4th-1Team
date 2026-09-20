package ai.govbiz.core.supportprogram.client.kstartup.helper

import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupPage
import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupProgramPayload
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import tools.jackson.databind.JsonNode

internal object KStartupPageDecoderHelper {
    fun decode(body: JsonNode): KStartupPage {
        if (!body.isObject) invalid("K-Startup API response was not an object")
        val data = body.path("data")
        if (!data.isArray) invalid("K-Startup API response has no data array")
        return KStartupPage(
            currentCount = integer(body, "currentCount"), matchCount = integer(body, "matchCount"),
            totalCount = integer(body, "totalCount"), page = integer(body, "page"), perPage = integer(body, "perPage"),
            items = data.toList().map { item ->
                if (!item.isObject) invalid("K-Startup API returned a non-object program")
                KStartupProgramPayload(
                    id = text(item, "pbanc_sn", allowInteger = true), title = text(item, "biz_pbanc_nm"),
                    organization = text(item, "pbanc_ntrp_nm"), summaryHtml = text(item, "pbanc_ctnt"),
                    target = text(item, "aply_trgt_ctnt"), excludedTarget = text(item, "aply_excl_trgt_ctnt"),
                    applicantTypes = text(item, "aply_trgt"), startupStages = text(item, "biz_enyy"),
                    founderAges = text(item, "biz_trgt_age"), category = text(item, "supt_biz_clsfc"),
                    region = text(item, "supt_regin"), applicationStartDate = text(item, "pbanc_rcpt_bgng_dt"),
                    applicationEndDate = text(item, "pbanc_rcpt_end_dt"), sourceUrl = text(item, "detl_pg_url"),
                )
            },
        )
    }

    private fun integer(node: JsonNode, name: String): Int {
        val value = node.path(name)
        if (!value.isIntegralNumber || !value.canConvertToInt() || value.asInt() < 0) {
            invalid("K-Startup API returned invalid $name metadata")
        }
        return value.asInt()
    }

    private fun text(node: JsonNode, name: String, allowInteger: Boolean = false): String? {
        val value = node.path(name)
        if (value.isMissingNode || value.isNull) return null
        if (!value.isString && !(allowInteger && value.isIntegralNumber)) invalid("K-Startup API returned invalid $name")
        return value.asString()
    }

    private fun invalid(message: String): Nothing = throw KStartupClientException.invalidResponse(message)
}
