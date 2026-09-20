package ai.govbiz.core.applicationpreparation.domain

data class ApplicationFormDiscoveryBlock(
    val blockId: String,
    val locator: String,
    val text: String,
)

data class ApplicationFormDiscoveryDocument(
    val documentIndex: Int,
    val sourceUrl: String,
    val fileName: String,
    val format: String,
    val bytes: Long,
    val sha256: String,
    val blocks: List<ApplicationFormDiscoveryBlock>,
    val sourceBytes: ByteArray? = null,
)

data class ApplicationFormDiscoveryInput(
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val programSourceUrl: String,
    val documents: List<ApplicationFormDiscoveryDocument>,
)

data class ExtractedApplicationFormField(
    val key: String,
    val label: String,
    val guidance: String,
    val required: Boolean,
    val evidenceBlockId: String,
    val evidenceQuote: String,
    val options: List<String> = emptyList(),
)

data class ExtractedApplicationFormSection(
    val key: String,
    val title: String,
    val description: String,
    val fields: List<ExtractedApplicationFormField>,
)

data class ExtractedApplicationForm(
    val documentIndex: Int,
    val sections: List<ExtractedApplicationFormSection>,
)

data class ApplicationFormDiscoveryConfiguration(
    val contractVersion: String,
    val model: String,
    val promptVersion: String,
)

data class ApplicationFormDiscoveryResult(
    val forms: List<ApplicationFormManifest>,
    val warnings: List<String>,
    val cached: Boolean,
)
