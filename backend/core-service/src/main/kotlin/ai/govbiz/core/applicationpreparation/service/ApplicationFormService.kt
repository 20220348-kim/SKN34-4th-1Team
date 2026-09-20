package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.domain.ApplicationFormManifest
import ai.govbiz.core.applicationpreparation.domain.ApplicationServiceField
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationFormNotSupportedException
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import org.springframework.core.io.ClassPathResource
import org.springframework.stereotype.Service
import tools.jackson.databind.ObjectMapper

/** 새 작성에는 활성 snapshot만 사용하며 기존 작성의 고정 manifest와 과거 버전은 읽기용으로 보존한다. */
@Service
class ApplicationFormService(objectMapper: ObjectMapper, private val snapshots: ApplicationFormSnapshotRepository,
    private val availability: ai.govbiz.core.applicationpreparation.repository.ApplicationFormAvailabilityRepository) {
    private val form: ApplicationFormManifest = ClassPathResource(MANIFEST_PATH).inputStream.use {
        objectMapper.readValue(it, ApplicationFormManifest::class.java)
    }

    fun listSupported(): List<ApplicationFormManifest> = availability.listActiveForms()

    fun requireSupported(
        sourceCode: String,
        sourceProgramId: String,
        formVersionId: String,
        serviceField: ApplicationServiceField,
    ): ApplicationFormManifest {
        val selected = availability.requireActive(sourceCode, sourceProgramId, formVersionId)
        if (selected.sourceCode != sourceCode || selected.sourceProgramId != sourceProgramId || !selected.supports(serviceField)) {
            throw ApplicationFormNotSupportedException()
        }
        return selected
    }

    fun requireVersion(formVersionId: String): ApplicationFormManifest =
        form.takeIf { it.formVersionId == formVersionId } ?: snapshots.findByVersion(formVersionId)
        ?: throw ApplicationFormNotSupportedException()

    private companion object {
        const val MANIFEST_PATH = "application-preparation/innovation-voucher-2026-v1.json"
    }
}
