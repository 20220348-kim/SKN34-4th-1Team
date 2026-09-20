package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core.supportprogram.domain.SupportProgramSourceDocument
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper

/** 공식 원문을 결정적이고 인용 가능한 짧은 검색 청크로 나눕니다. */
object SupportProgramEvidenceChunker {
    private const val MAX_CHUNKS = 50
    private const val MAX_CHUNK_LENGTH = 1_500

    fun chunk(document: SupportProgramSourceDocument): List<SupportProgramEvidenceChunk> {
        val sections = document.content
            .lineSequence()
            .map(String::trim)
            .filter(String::isNotBlank)
            .flatMap(::splitLongSection)
        val texts = packSections(sections)
        check(texts.isNotEmpty() && texts.size <= MAX_CHUNKS) {
            "source document exceeded the supported evidence chunk limit"
        }

        return java.util.List.copyOf(
            texts.mapIndexed { order, text ->
                val contentHash = SupportProgramContentHashHelper.sha256(text)
                SupportProgramEvidenceChunk(
                    id = SupportProgramContentHashHelper.sha256(
                        "${document.sourceQualifiedId}\u0000${document.contentHash}\u0000$order",
                    ),
                    contentHash = contentHash,
                    documentId = document.sourceQualifiedId,
                    order = order,
                    text = text,
                )
            },
        )
    }

    private fun packSections(sections: Sequence<String>): List<String> {
        val chunks = ArrayList<String>()
        val current = StringBuilder(MAX_CHUNK_LENGTH)
        for (section in sections) {
            val separatorLength = if (current.isEmpty()) 0 else 2
            if (current.length + separatorLength + section.length > MAX_CHUNK_LENGTH) {
                if (current.isNotEmpty()) chunks += current.toString()
                current.setLength(0)
            }
            if (current.isNotEmpty()) current.append("\n\n")
            current.append(section)
        }
        if (current.isNotEmpty()) chunks += current.toString()
        return chunks
    }

    private fun splitLongSection(section: String): Sequence<String> = sequence {
        var start = 0
        while (start < section.length) {
            var end = minOf(start + MAX_CHUNK_LENGTH, section.length)
            if (end < section.length) {
                val preferredBoundary = section.lastIndexOfAny(
                    charArrayOf(' ', '\n', '\t'),
                    startIndex = end - 1,
                )
                if (preferredBoundary >= start + MAX_CHUNK_LENGTH / 2) end = preferredBoundary + 1
                // UTF-16의 상위·하위 surrogate 사이를 자르면 유효한 원문도 AI에서 거부됩니다.
                if (Character.isHighSurrogate(section[end - 1]) && Character.isLowSurrogate(section[end])) end--
            }
            val piece = section.substring(start, end).trim()
            if (piece.isNotEmpty()) yield(piece)
            start = end
        }
    }
}
