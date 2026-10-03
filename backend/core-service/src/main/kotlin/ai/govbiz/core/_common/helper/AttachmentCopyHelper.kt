package ai.govbiz.core._common.helper

/**
 * 제공처가 한 문서를 여러 형식(HWPX·HWP·DOCX·XLSX·PDF)으로 함께 올린 첨부에서 형식별 사본을 걸러 하나만 남깁니다.
 * 기업마당 첨부 수집과 신청 양식 분석이 함께 씁니다.
 */
object AttachmentCopyHelper {
    private val formatRank = listOf("hwpx", "hwp", "docx", "xlsx", "pdf")
    private val sizeSuffix = Regex("\\s*\\[\\s*[0-9][0-9.,]*\\s*[KMG]?B\\s*]\\s*$", RegexOption.IGNORE_CASE)
    private val extension = Regex("\\.(hwpx|hwp|docx|xlsx|pdf)$", RegexOption.IGNORE_CASE)

    /** 게시판이 파일명 뒤에 붙인 크기 표기("[141.87 KB]")를 뗍니다. */
    fun withoutSizeSuffix(fileName: String): String = fileName.replace(sizeSuffix, "").trim()

    /** 확장자·크기 표기·기호를 뺀 이름입니다. 남는 글자가 없으면 같은 문서인지 알 수 없어 null입니다. */
    fun titleKey(fileName: String): String? = withoutSizeSuffix(fileName).replace(extension, "")
        .replace(Regex("[^\\p{L}\\p{N}]"), "").lowercase().ifBlank { null }

    /**
     * 이름이 같은 첨부를 한 문서의 사본 묶음으로 모읍니다. 묶음 안은 표 구조가 남는 한글 원본(HWPX·HWP)이 PDF보다 앞이고
     * 같은 형식이면 앞선 항목이 먼저입니다. 묶음은 맨 앞 사본의 원래 순서를 따릅니다.
     */
    fun <T> copyGroups(items: List<T>, fileName: (T) -> String): List<List<T>> {
        fun rank(item: T): Int {
            val format = withoutSizeSuffix(fileName(item)).substringAfterLast('.', "").lowercase()
            return formatRank.indexOf(format).takeIf { it >= 0 } ?: formatRank.size
        }
        return items.withIndex()
            .groupBy { titleKey(fileName(it.value)) ?: "#${it.index}" }
            .values
            .map { copies -> copies.sortedWith(compareBy({ rank(it.value) }, { it.index })) }
            .sortedBy { it.first().index }
            .map { copies -> copies.map { it.value } }
    }

    /** 사본 묶음마다 맨 앞 사본 하나만 원래 순서로 남깁니다. */
    fun <T> withoutFormatCopies(items: List<T>, fileName: (T) -> String): List<T> = copyGroups(items, fileName).map { it.first() }
}
