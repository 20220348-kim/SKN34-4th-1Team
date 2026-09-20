package ai.govbiz.catalog.internal.service

import ai.govbiz.catalog.supportprogram.domain.CatalogSnapshot
import ai.govbiz.catalog.supportprogram.domain.CatalogSource
import ai.govbiz.catalog.supportprogram.repository.SupportProgramRepository
import org.springframework.dao.DataAccessException
import org.springframework.stereotype.Service

@Service
class CatalogSnapshotService(private val repository: SupportProgramRepository) {
    fun get(sourceCode: String): CatalogSnapshot {
        if (sourceCode !in CatalogSource.CODES) throw CatalogSourceNotSupportedException()
        return repository.findSnapshot(sourceCode) ?: throw CatalogSnapshotUnavailableException()
    }

    /** DB와 자기 스키마만 확인하며 공공 API·AI·검색 색인을 호출하지 않습니다. */
    fun isReady(): Boolean = try {
        repository.isReady()
    } catch (_: DataAccessException) {
        false
    }
}

class CatalogSourceNotSupportedException : RuntimeException()
class CatalogSnapshotUnavailableException : RuntimeException()
