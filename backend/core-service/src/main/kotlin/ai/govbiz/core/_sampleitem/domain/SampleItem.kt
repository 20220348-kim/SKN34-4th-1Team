package ai.govbiz.core._sampleitem.domain

/** 프런트엔드부터 Core API까지 흐르는 최소 예제 도메인입니다. */
@ConsistentCopyVisibility
data class SampleItem private constructor(
    val name: String,
    val category: SampleCategory?,
    val note: String?,
) {
    companion object {
        fun create(
            name: String?,
            category: SampleCategory?,
            note: String?,
        ): SampleItem =
            SampleItem(
                name = normalizeName(name),
                category = category,
                note = normalizeOptional(note),
            )

        private fun normalizeName(value: String?): String {
            val normalized = (value ?: throw NullPointerException("name must not be null"))
                .trim { Character.isWhitespace(it) }
            if (normalized.isEmpty()) {
                throw IllegalArgumentException("name must not be blank")
            }
            return normalized
        }

        private fun normalizeOptional(value: String?): String? {
            val normalized = value?.trim { Character.isWhitespace(it) } ?: return null
            return normalized.ifEmpty { null }
        }
    }
}
