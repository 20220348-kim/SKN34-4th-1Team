package ai.govbiz.catalog.internal.controller

import ai.govbiz.catalog.internal.service.CatalogSnapshotUnavailableException
import ai.govbiz.catalog.internal.service.CatalogSourceNotSupportedException
import org.springframework.dao.DataAccessException
import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.ExceptionHandler
import org.springframework.web.bind.annotation.RestControllerAdvice

@RestControllerAdvice
class CatalogExceptionHandler {
    @ExceptionHandler(CatalogSourceNotSupportedException::class)
    fun invalidSource() = ResponseEntity.badRequest().body(mapOf("code" to "INVALID_SOURCE"))

    @ExceptionHandler(CatalogSnapshotUnavailableException::class, DataAccessException::class)
    fun unavailable() = ResponseEntity.status(503).body(mapOf("code" to "CATALOG_UNAVAILABLE"))
}
