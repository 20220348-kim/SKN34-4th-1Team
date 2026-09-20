package ai.govbiz.core.applicationpreparation.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface ApplicationFormSnapshotMapper {
    fun upsert(row: ApplicationFormSnapshotDbRow): Int
    fun attachDocumentMap(@Param("formVersionId") formVersionId: String, @Param("sourceSha256") sourceSha256: String, @Param("pipelineVersion") pipelineVersion: String, @Param("documentMapJson") documentMapJson: String): Int

    fun findByVersion(@Param("formVersionId") formVersionId: String): ApplicationFormSnapshotDbRow?

    fun findByProgram(
        @Param("sourceCode") sourceCode: String,
        @Param("sourceProgramId") sourceProgramId: String,
        @Param("sourceFingerprint") sourceFingerprint: String,
        @Param("parserVersion") parserVersion: String,
        @Param("extractionModel") extractionModel: String,
        @Param("extractionPromptVersion") extractionPromptVersion: String,
    ): List<ApplicationFormSnapshotDbRow>
}
