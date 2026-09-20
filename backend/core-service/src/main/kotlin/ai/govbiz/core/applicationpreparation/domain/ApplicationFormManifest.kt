package ai.govbiz.core.applicationpreparation.domain

import java.net.URI

/** 공식 첨부의 고정 hash와 확인한 문항 위치를 담는 첫 지원 양식입니다. */
data class ApplicationFormManifest(
    val schemaVersion: Int,
    val formVersionId: String,
    val sourceCode: String,
    val sourceProgramId: String,
    val programTitle: String,
    val formTitle: String,
    val sourceUrl: String,
    val attachmentFileName: String,
    val attachmentBytes: Long,
    val attachmentSha256: String,
    val verificationStatus: String,
    val institutionReviewed: Boolean,
    val supportedServiceFields: List<ApplicationServiceField>,
    val sections: List<ApplicationFormSectionDefinition>,
    val documentMapSnapshot: ApplicationDocumentMapSnapshot? = null,
) {
    init {
        require(documentMapSnapshot == null || documentMapSnapshot.sourceSha256 == attachmentSha256) { "document map source mismatch" }
        require(schemaVersion == 1) { "unsupported application form manifest schema" }
        require(FORM_VERSION_PATTERN.matches(formVersionId)) { "invalid formVersionId" }
        require(SOURCE_CODE_PATTERN.matches(sourceCode)) { "invalid sourceCode" }
        require(sourceProgramId.isSafeText(255)) { "invalid sourceProgramId" }
        require(programTitle.isSafeText(300) && formTitle.isSafeText(300)) { "invalid application form titles" }
        val uri = URI(sourceUrl)
        val officialHosts = when (sourceCode) {
            "BIZINFO" -> setOf("bizinfo.go.kr", "www.bizinfo.go.kr")
            "MSIT" -> setOf("msit.go.kr", "www.msit.go.kr")
            "KSTARTUP" -> setOf("k-startup.go.kr", "www.k-startup.go.kr")
            "CNTRADE_NOTICE" -> setOf("cntrade.chungnam.go.kr")
            else -> emptySet()
        }
        require(uri.scheme == "https" && uri.host in officialHosts) {
            "application form source must match its supported official HTTPS provider"
        }
        require(attachmentFileName.isSafeText(500) && attachmentBytes > 0) { "invalid attachment identity" }
        require(SHA256_PATTERN.matches(attachmentSha256)) { "invalid attachment hash" }
        require(verificationStatus in setOf("SOURCE_HASH_AND_LOCATORS_VERIFIED", "SOURCE_DOCUMENT_EXTRACTED")) {
            "unsupported verification status"
        }
        require(!institutionReviewed) { "institution review must not be claimed by this manifest" }
        require(supportedServiceFields.isNotEmpty() && supportedServiceFields.distinct().size == supportedServiceFields.size) {
            "supported service fields must be unique"
        }
        require(sections.isNotEmpty() && sections.map { it.key }.distinct().size == sections.size) {
            "application form sections must be unique"
        }
    }

    fun supports(field: ApplicationServiceField): Boolean = field in supportedServiceFields

    private companion object {
        val FORM_VERSION_PATTERN = Regex("[a-z0-9][a-z0-9-]{0,159}")
        val SOURCE_CODE_PATTERN = Regex("[A-Z][A-Z0-9_]{0,63}")
        val SHA256_PATTERN = Regex("[0-9a-f]{64}")
    }
}

data class ApplicationFormSectionDefinition(
    val key: String,
    val title: String,
    val locator: String,
    val description: String,
    val fields: List<ApplicationFormFieldDefinition>,
) {
    init {
        require(SECTION_KEY_PATTERN.matches(key)) { "invalid application form section key" }
        require(title.isSafeText(100) && locator.isSafeText(200) && description.isSafeText(1000)) {
            "invalid application form section text"
        }
        require(fields.isNotEmpty() && fields.size <= 20 && fields.map { it.key }.distinct().size == fields.size) {
            "application form fields must be present and unique"
        }
    }

    private companion object {
        val SECTION_KEY_PATTERN = Regex("[a-z][a-z0-9-]{0,63}")
    }
}

data class ApplicationFormFieldDefinition(
    val key: String,
    val label: String,
    val guidance: String,
    val required: Boolean,
    val options: List<String> = emptyList(),
) {
    init {
        require(options.size != 1 && options.size <= 30 && options.distinct().size == options.size && options.all { it.isSafeText(100) }) { "invalid application form choices" }
        require(FIELD_KEY_PATTERN.matches(key)) { "invalid application form field key" }
        require(label.isSafeText(100) && guidance.isSafeText(500)) { "invalid application form field text" }
    }

    private companion object {
        val FIELD_KEY_PATTERN = Regex("[a-z][a-z0-9-]{0,63}")
    }
}

private fun String.isSafeText(maxCodePoints: Int): Boolean =
    isNotBlank() && this == trim() && codePointCount(0, length) <= maxCodePoints && !Regex("\\p{C}").containsMatchIn(this)
