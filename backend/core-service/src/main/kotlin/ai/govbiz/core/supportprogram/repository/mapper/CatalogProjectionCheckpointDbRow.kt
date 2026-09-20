package ai.govbiz.core.supportprogram.repository.mapper

/** 제공처별 마지막으로 반영한 Catalog 인스턴스·revision·전체 payload 지문입니다. */
data class CatalogProjectionCheckpointDbRow(
    var sourceCode: String = "",
    var catalogId: String = "",
    var revision: Long = 0,
    var publishedGeneration: Long = 0,
    var payloadHash: String = "",
    var programsHash: String = "",
)
