package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat

/** 키워드·카탈로그 지문의 기존 본문과 의미 검색의 지원 내용 중심 본문을 구성합니다. */
object SupportProgramIndexTextHelper {
    const val MAX_DOCUMENTS = 20_000
    private const val MAX_TEXT_CODE_POINTS = 12_000
    private val UNSUPPORTED_CONTROL_TEXT = Regex("[\\p{C}&&[^\\n\\r\\t]]")

    fun buildText(candidate: CatalogSupportProgram): String {
        val program = candidate.program
        val sourceLines = listOf(
            "제목: ${program.title}", "기관: ${program.organization}", "지원대상: ${program.targetDescription}",
            "분야: ${program.categories.joinToString(", ")}", "지역: ${program.regions.joinToString(", ")}",
            "신청기간: ${program.applicationPeriod}", "내용: ${program.summary}",
        )
        return normalizeAndTruncate(sourceLines + buildStartupLines(candidate))
    }

    /** 기관·신청기간 대신 실제 지원 내용과 대상을 의미 검색 앞부분에 둡니다. */
    fun buildSemanticText(candidate: CatalogSupportProgram): String {
        val program = candidate.program
        val sourceLines = listOf(
            "제목: ${program.title}", "지원대상: ${program.targetDescription}", "내용: ${program.summary}",
            "분야: ${program.categories.joinToString(", ")}", "지역: ${program.regions.joinToString(", ")}",
        )
        return normalizeAndTruncate(sourceLines + buildStartupLines(candidate))
    }

    private fun buildStartupLines(candidate: CatalogSupportProgram): List<String> =
        candidate.startupDetails?.takeIf { candidate.program.sourceCode == "KSTARTUP" }?.let { details ->
            buildList {
                if (details.startupStages.isNotEmpty()) add("창업 업력 분류: ${details.startupStages.joinToString(", ")}")
                if (details.applicantTypes.isNotEmpty()) add("대상 분류: ${details.applicantTypes.joinToString(", ")}")
                if (details.founderAges.isNotEmpty()) add("대표자 연령 분류: ${details.founderAges.joinToString(", ")}")
            }.takeIf { it.isNotEmpty() }?.let { listOf("검색용 분류 메타데이터 (신청 자격 근거 아님)") + it }
        }.orEmpty()

    private fun normalizeAndTruncate(lines: List<String>): String {
        val text = lines.joinToString("\n").replace(UNSUPPORTED_CONTROL_TEXT, " ")
        return if (text.codePointCount(0, text.length) > MAX_TEXT_CODE_POINTS) {
            text.substring(0, text.offsetByCodePoints(0, MAX_TEXT_CODE_POINTS))
        } else text
    }

    fun calculateContentHash(text: String): String = HexFormat.of().formatHex(
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(StandardCharsets.UTF_8)),
    )
}
