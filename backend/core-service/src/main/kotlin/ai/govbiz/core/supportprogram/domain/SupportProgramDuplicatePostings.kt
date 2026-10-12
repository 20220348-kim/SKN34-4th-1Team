package ai.govbiz.core.supportprogram.domain

import ai.govbiz.core._common.domain.RegionDictionary
import java.text.Normalizer
import java.time.LocalDate
import java.util.Locale

/** 같은 공고를 다른 제공처도 올렸을 때 그 게시물입니다. 검색 결과 한 칸에 함께 보여 주는 용도입니다. */
data class SupportProgramPosting(
    val sourceCode: String,
    val id: String,
    val sourceName: String,
    val sourceUrl: String,
) {
    companion object {
        fun of(program: SupportProgram) =
            SupportProgramPosting(program.sourceCode, program.id, program.sourceName, program.sourceUrl)
    }
}

/**
 * 기업마당과 K-Startup처럼 서로 다른 제공처가 따로 올린 같은 공고를 검색 결과 한 칸으로 묶습니다.
 *
 * 정규화한 제목(앞머리 "[서울]" 같은 괄호 머리말·공백·문장부호 제외), 기관, 마감일이 모두 같을 때만 같은 공고로 봅니다.
 * 기관을 모르거나 제목이 비면 묶지 않습니다. 제목 머리말의 지역이 둘 다 있는데 겹치지 않으면("[서울]"과 "[부산]")
 * 지역별로 따로 낸 다른 공고로 보고 묶지 않습니다. 머리말은 기업마당에만 붙는 경우가 많아 한쪽에만 있으면 비교하지 않습니다.
 * 비슷한 제목을 점수로 묶지 않는 것은 다른 공고가 다섯 칸에서 숨는 것보다 같은 공고가 두 칸을 차지하는 편이 덜 해롭기 때문입니다.
 */
object SupportProgramDuplicatePostings {
    private val LEADING_BRACKETS = Regex("^(?:\\s*[\\[(【〔<〈「『][^\\])】〕>〉」』]{0,30}[\\])】〕>〉」』])+")
    private val NON_WORD = Regex("[^\\p{L}\\p{N}]")
    private val BRACKET_MARKS = Regex("[\\[\\]()【】〔〕<>〈〉「」『』]")
    private val UNKNOWN_ORGANIZATIONS = setOf("정보없음", "직접수행")

    /**
     * 순위대로 놓인 [ranked]에서 앞선 공고에 같은 공고의 다른 제공처 게시물을 `alsoPostedBy`로 붙이고 그 게시물이
     * 차지하던 뒤쪽 칸은 뺍니다. [pool]은 결과에 오르지 못한 같은 공고를 찾을 검색 대상이며 순위는 바꾸지 않습니다.
     */
    fun group(ranked: List<SupportProgram>, pool: List<SupportProgram>): List<SupportProgram> {
        val keys = HashMap<String, Key?>()
        fun keyOf(program: SupportProgram): Key? = program.sourceQualifiedId.let { id ->
            if (id in keys) keys[id] else key(program).also { keys[id] = it }
        }
        val consumed = HashSet<String>()
        val grouped = ArrayList<SupportProgram>(ranked.size)
        for (program in ranked) {
            if (!consumed.add(program.sourceQualifiedId)) continue
            val key = keyOf(program)
            if (key == null) {
                grouped += program
                continue
            }
            val others = LinkedHashMap<String, SupportProgram>()
            for (other in ranked.asSequence() + pool.asSequence()) {
                if (other.sourceCode == program.sourceCode || other.sourceCode in others) continue
                // 마감일을 먼저 비교해 대부분의 검색 대상은 제목을 정규화하지 않고 지나갑니다.
                if (other.applicationEndDate != program.applicationEndDate || other.sourceQualifiedId in consumed) continue
                if (keyOf(other)?.let(key::isSameProgram) == true) others[other.sourceCode] = other
            }
            others.values.forEach { consumed += it.sourceQualifiedId }
            grouped += if (others.isEmpty()) {
                program
            } else {
                program.copy(alsoPostedBy = java.util.List.copyOf(others.values.map(SupportProgramPosting::of)))
            }
        }
        return java.util.List.copyOf(grouped)
    }

    private fun key(program: SupportProgram): Key? {
        val normalized = Normalizer.normalize(program.title, Normalizer.Form.NFKC)
        val title = words(LEADING_BRACKETS.replace(normalized, ""))
        val organization = words(program.organization)
        if (title.isEmpty() || organization.isEmpty() || organization in UNKNOWN_ORGANIZATIONS) return null
        val prefix = LEADING_BRACKETS.find(normalized)?.value.orEmpty()
        val titleRegions = RegionDictionary.provincesOf(BRACKET_MARKS.replace(prefix, " "))
        return Key(title, organization, program.applicationEndDate, titleRegions)
    }

    private fun words(value: String): String =
        NON_WORD.replace(Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT), "")

    private data class Key(
        val title: String,
        val organization: String,
        val applicationEndDate: LocalDate?,
        /** 제목 머리말("[서울]")에서 읽은 시·도입니다. 머리말이 없거나 지역이 아니면 비어 있습니다. */
        val titleRegions: Set<String>,
    ) {
        fun isSameProgram(other: Key): Boolean =
            title == other.title && organization == other.organization && applicationEndDate == other.applicationEndDate &&
                (titleRegions.isEmpty() || other.titleRegions.isEmpty() || titleRegions.any(other.titleRegions::contains))
    }
}
