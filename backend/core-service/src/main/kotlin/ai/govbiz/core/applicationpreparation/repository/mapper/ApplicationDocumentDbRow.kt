package ai.govbiz.core.applicationpreparation.repository.mapper

data class ApplicationDocumentDbRow(
    var id: Long = 0,
    var preparationId: Long = 0,
    var inputRevision: Long = 0,
    var fileName: String = "",
    var mediaType: String = "",
    var fileBytes: ByteArray = byteArrayOf(),
    var sourceSha256: String = "",
    var placementsJson: String = "[]",
    var generatorVersion: Int = 5,
    var generationFingerprint: String = "",
)
