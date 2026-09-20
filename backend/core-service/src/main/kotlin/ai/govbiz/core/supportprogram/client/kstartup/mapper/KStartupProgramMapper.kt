package ai.govbiz.core.supportprogram.client.kstartup.mapper

import ai.govbiz.core.supportprogram.client.kstartup.dto.KStartupProgramPayload
import ai.govbiz.core.supportprogram.client.kstartup.exception.KStartupClientException
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale
import org.jsoup.Jsoup

/** 원문 신청 조건을 먼저 보존하고 K-Startup 분류 메타데이터를 함께 정규화합니다. */
internal object KStartupProgramMapper {
    fun mapValidated(payloads: List<KStartupProgramPayload>, today: LocalDate): List<CatalogSupportProgram> {
        val identities = HashSet<String>()
        return java.util.List.copyOf(payloads.map { payload ->
            val id = payload.id?.takeIf { PROGRAM_ID.matches(it) }
                ?: invalid("K-Startup API returned an invalid pbanc_sn")
            if (!identities.add(id)) invalid("K-Startup API returned duplicate pbanc_sn values")
            val title = plainText(payload.title).takeIf(String::isNotBlank)
                ?: invalid("K-Startup API returned a program without a title")
            val start = date(payload.applicationStartDate)
            val end = date(payload.applicationEndDate)
            if (start != null && end != null && start.isAfter(end)) invalid("K-Startup API returned a reversed application period")
            val period = if (payload.applicationStartDate.isNullOrBlank() && payload.applicationEndDate.isNullOrBlank()) {
                "정보 없음"
            } else {
                "${start?.toString() ?: plainText(payload.applicationStartDate).ifBlank { "시작일 미정" }} ~ " +
                    (end?.toString() ?: plainText(payload.applicationEndDate).ifBlank { "마감일 미정" })
            }
            val details = SupportProgramStartupDetails(
                startupStages = splitValues(payload.startupStages),
                applicantTypes = splitValues(payload.applicantTypes),
                founderAges = splitValues(payload.founderAges),
            )
            val target = buildList {
                plainText(payload.target).takeIf(String::isNotBlank)?.let { add("지원 대상: $it") }
                plainText(payload.excludedTarget).takeIf(String::isNotBlank)?.let { add("제외 대상: $it") }
            }.joinToString("\n").ifBlank { "정보 없음" }
            val organization = plainText(payload.organization).ifBlank { "정보 없음" }
            val summary = plainText(payload.summaryHtml).ifBlank { "정보 없음" }
            val sourceUrl = officialSourceUrl(payload.sourceUrl, id)
            // 색인하기 전에 MySQL 저장 한도를 검사하여 유료 색인 후의 저장 실패를 방지합니다.
            requireCharacterLimit(title, 500, "title")
            requireCharacterLimit(organization, 255, "organization")
            requireCharacterLimit(sourceUrl, 2048, "source URL")
            requireTextLimit(summary, "summary")
            requireTextLimit(target, "target description")
            requireTextLimit(period, "application period")
            CatalogSupportProgram(
                program = SupportProgram(
                    id = id, sourceCode = "KSTARTUP", title = title,
                    organization = organization,
                    summary = summary,
                    categories = splitValues(payload.category), regions = regions(payload.region),
                    targetDescription = target, applicationPeriod = period,
                    applicationStartDate = start, applicationEndDate = end,
                    status = SupportProgramStatusResolver.resolve(period, start, end, today),
                    sourceName = "K-Startup", sourceUrl = sourceUrl,
                    matchedReasons = emptyList(),
                ),
                // 이 API에는 게시일이 없으므로 실제로 제공된 접수 시작일만 정렬에 사용합니다.
                sortTimestamp = start?.toString().orEmpty(),
                startupDetails = details,
            )
        })
    }

    private fun date(raw: String?): LocalDate? {
        val value = raw?.trim() ?: return null
        if (!Regex("[0-9]{8}").matches(value)) return null
        return try { LocalDate.parse(value, DateTimeFormatter.BASIC_ISO_DATE) } catch (_: DateTimeParseException) { null }
    }

    private fun splitValues(value: String?): List<String> =
        java.util.List.copyOf(value.orEmpty().split(',').map(::plainText).filter(String::isNotBlank).distinct())

    private fun regions(value: String?): List<String> {
        val values = splitValues(value).flatMap {
            if (it == "전남광주") listOf("전남", "광주") else listOf(REGION_ALIASES[it] ?: it)
        }.distinct()
        return if ("전국" in values) listOf("전국") else java.util.List.copyOf(values)
    }

    private fun requireCharacterLimit(value: String, limit: Int, field: String) {
        if (value.codePointCount(0, value.length) > limit) invalid("K-Startup API returned an oversized $field")
    }

    private fun requireTextLimit(value: String, field: String) {
        if (value.toByteArray(StandardCharsets.UTF_8).size > 65_535) invalid("K-Startup API returned an oversized $field")
    }

    private fun plainText(value: String?): String {
        if (value.isNullOrBlank()) return ""
        val document = Jsoup.parseBodyFragment(value)
        document.select("script,style").remove()
        return document.body().text().trim()
    }

    private fun officialSourceUrl(value: String?, id: String): String {
        try {
            val uri = URI(value ?: "")
            val host = uri.host?.lowercase(Locale.ROOT)
            if (!uri.scheme.equals("https", ignoreCase = true) || uri.rawUserInfo != null ||
                uri.port !in listOf(-1, 443) || uri.rawFragment != null ||
                host == null || (host != "k-startup.go.kr" && !host.endsWith(".k-startup.go.kr")) ||
                uri.rawPath.isNullOrBlank() || uri.rawPath == "/") {
                invalid("K-Startup API returned an unsafe official detail URL")
            }
            val ids = uri.rawQuery.orEmpty().split('&').mapNotNull { parameter ->
                val name = URLDecoder.decode(parameter.substringBefore('='), StandardCharsets.UTF_8)
                if (name != "pbancSn") return@mapNotNull null
                URLDecoder.decode(parameter.substringAfter('=', ""), StandardCharsets.UTF_8)
            }
            if (ids != listOf(id)) invalid("K-Startup API detail URL does not identify exactly one matching pbanc_sn")
            return uri.toString()
        } catch (_: java.net.URISyntaxException) {
            invalid("K-Startup API returned an invalid detail URL")
        } catch (_: IllegalArgumentException) {
            invalid("K-Startup API returned an invalid detail URL")
        }
    }

    private fun invalid(message: String): Nothing = throw KStartupClientException.invalidResponse(message)
    private val PROGRAM_ID = Regex("[1-9][0-9]{0,254}")
    private val REGION_ALIASES = mapOf(
        "서울특별시" to "서울", "부산광역시" to "부산", "대구광역시" to "대구", "인천광역시" to "인천",
        "광주광역시" to "광주", "대전광역시" to "대전", "울산광역시" to "울산", "세종특별자치시" to "세종",
        "경기도" to "경기", "강원도" to "강원", "강원특별자치도" to "강원",
        "충청북도" to "충북", "충청남도" to "충남", "전라북도" to "전북", "전북특별자치도" to "전북",
        "전라남도" to "전남", "경상북도" to "경북", "경상남도" to "경남", "제주특별자치도" to "제주", "제주도" to "제주",
    )
}
