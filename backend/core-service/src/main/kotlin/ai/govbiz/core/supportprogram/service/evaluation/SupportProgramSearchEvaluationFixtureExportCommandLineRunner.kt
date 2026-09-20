package ai.govbiz.core.supportprogram.service.evaluation

import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexDocumentRequest
import ai.govbiz.core.supportprogram.client.ai.mapper.SupportProgramIndexDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStatusResolver
import ai.govbiz.core.supportprogram.helper.SupportProgramCatalogFingerprintHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.evaluation.config.SupportProgramSearchEvaluationFixtureExportProperties
import ai.govbiz.core.supportprogram.service.evaluation.helper.SupportProgramSearchEvaluationFileHelper
import org.slf4j.LoggerFactory
import org.springframework.boot.CommandLineRunner
import tools.jackson.databind.ObjectMapper

/** 검색과 같은 준비된 제공처의 MySQL 적격 공고를 검색 평가 fixture 초안으로 기록합니다. */
class SupportProgramSearchEvaluationFixtureExportCommandLineRunner(
    private val properties: SupportProgramSearchEvaluationFixtureExportProperties,
    private val supportProgramRepository: SupportProgramRepository,
    private val objectMapper: ObjectMapper,
) : CommandLineRunner {

    override fun run(vararg args: String) {
        val presentPrograms = supportProgramRepository.findSearchablePresent()
        val eligiblePrograms = presentPrograms.filter { it.isOpenAt(properties.referenceDate) }
        require(eligiblePrograms.isNotEmpty()) { "cannot export an empty eligible support program catalog" }

        val documents = eligiblePrograms
            .map { catalogProgram ->
                require(catalogProgram.sortTimestamp.isNotBlank()) {
                    "cannot export a program without sortTimestamp: ${catalogProgram.program.id}"
                }
                FixtureDocument(
                    catalogProgram = catalogProgram,
                    indexDocument = SupportProgramIndexDocumentMapper.fromCatalog(catalogProgram),
                )
            }
            .sortedBy { it.indexDocument.id }
        check(documents.map { it.indexDocument.id }.distinct().size == documents.size) {
            "eligible support program catalog contains duplicate search document IDs"
        }

        val fixture = linkedMapOf<String, Any>(
            "name" to properties.name,
            "dataType" to DATA_TYPE,
            "referenceDate" to properties.referenceDate.toString(),
            "catalog" to linkedMapOf(
                "presentProgramCount" to presentPrograms.size,
                "eligibleProgramCount" to eligiblePrograms.size,
                "eligibleCatalogFingerprint" to SupportProgramCatalogFingerprintHelper.calculate(eligiblePrograms),
            ),
            "docs" to documents.map { document ->
                linkedMapOf(
                    "id" to document.indexDocument.id,
                    "contentHash" to document.indexDocument.contentHash,
                    "text" to document.indexDocument.text,
                    "sortTimestamp" to document.catalogProgram.sortTimestamp,
                )
            },
            "cases" to emptyList<Any>(),
        )
        SupportProgramSearchEvaluationFileHelper.writeAtomically(
            properties.outputPath,
            objectMapper.writeValueAsBytes(fixture),
        )
        logger.info("지원사업 검색 평가 fixture 공고 {}건을 {}에 기록했습니다.", documents.size, properties.outputPath)
    }

    private fun CatalogSupportProgram.isOpenAt(referenceDate: java.time.LocalDate): Boolean =
        SupportProgramStatusResolver.resolve(
            applicationPeriod = program.applicationPeriod,
            applicationStartDate = program.applicationStartDate,
            applicationEndDate = program.applicationEndDate,
            today = referenceDate,
        ) == SupportProgramStatus.OPEN

    private data class FixtureDocument(
        val catalogProgram: CatalogSupportProgram,
        val indexDocument: AiSupportProgramIndexDocumentRequest,
    )

    private companion object {
        const val DATA_TYPE = "real_catalog_snapshot_unlabeled"
        val logger = LoggerFactory.getLogger(SupportProgramSearchEvaluationFixtureExportCommandLineRunner::class.java)
    }
}
