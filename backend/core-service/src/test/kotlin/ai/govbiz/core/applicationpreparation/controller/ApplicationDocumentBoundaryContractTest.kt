package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.applicationpreparation.controller.dto.ConfirmApplicationDocumentMigrationRequest
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentService
import ai.govbiz.core.applicationpreparation.service.dto.*
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import java.time.LocalDateTime
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.Mockito.*
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class ApplicationDocumentBoundaryContractTest {
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()

    @Test fun migrationNoticeRetainsExactPublicFieldsAndDefaults() {
        val notice = ApplicationDocumentMigrationNoticeResult("token", 7, changes = listOf(
            ApplicationDocumentMappingChangeResult("label", "TARGET_CHANGED", null, "new location")))
        val response = ApplicationDocumentExceptionHandler().handle(ApplicationDocumentException(
            "APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", "safe detail", mappingMigration = notice))
        assertEquals(422, response.statusCode.value())
        assertEquals("no-store", response.headers.cacheControl)
        val problem = requireNotNull(response.body)
        assertEquals("safe detail", problem.detail)
        assertEquals("APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", problem.properties!!["code"])
        val tree = json.readTree(json.writeValueAsString(problem.properties!!["mappingMigration"]))
        assertEquals(json.readTree("""{"status":"MAPPING_CHANGED","approvalToken":"token","expectedRevision":7,
            "expiresInSeconds":900,"changes":[{"fieldLabel":"label","changeType":"TARGET_CHANGED",
            "oldLocation":null,"newLocation":"new location"}]}"""), tree)
    }

    @Test fun confirmMapsInternalResultToExactPublicResponse() {
        val service = mock(ApplicationDocumentService::class.java)
        val account = Account(1, "test@example.com", AccountRole.USER, null, null, LocalDateTime.now())
        `when`(service.confirmMigration(account, 2, 7, "token"))
            .thenReturn(ApplicationDocumentMigrationConfirmedResult(2, 7, "approved-version"))
        val response = ApplicationDocumentController(service).confirmMigration(account, 2,
            ConfirmApplicationDocumentMigrationRequest(7, "token"))
        assertEquals(200, response.statusCode.value())
        assertEquals("no-store", response.headers.cacheControl)
        assertEquals(json.readTree("""{"status":"REGENERATION_REQUIRED","preparationId":2,
            "inputRevision":7,"formVersionId":"approved-version"}"""), json.readTree(json.writeValueAsString(response.body)))
    }
}
