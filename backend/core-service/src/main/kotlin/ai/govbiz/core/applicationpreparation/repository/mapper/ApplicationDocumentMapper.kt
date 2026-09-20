package ai.govbiz.core.applicationpreparation.repository.mapper

import org.apache.ibatis.annotations.Mapper
import org.apache.ibatis.annotations.Param

@Mapper
interface ApplicationDocumentMapper {
    fun listOwned(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long, @Param("limit") limit: Int): List<ApplicationDocumentDbRow>
    fun findRevision(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long, @Param("revision") revision: Long, @Param("generatorVersion") generatorVersion: Int): ApplicationDocumentDbRow?
    fun findOwned(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long, @Param("fileId") fileId: Long): ApplicationDocumentDbRow?
    fun insert(row: ApplicationDocumentDbRow): Int
    fun findFingerprint(@Param("ownerId") ownerId: Long, @Param("preparationId") preparationId: Long, @Param("revision") revision: Long, @Param("fingerprint") fingerprint: String): ApplicationDocumentDbRow?
}
