package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormResponse
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.*
import java.security.MessageDigest

class ApplicationDocumentMappingServiceTest {
    private val client = mock(ApplicationDocumentMcpClient::class.java)
    private val snapshots = mock(ApplicationFormSnapshotRepository::class.java)
    private val editor = mock(ApplicationDocumentEditor::class.java)
    private val service = ApplicationDocumentMappingService(client, editor, snapshots)
    private val bytes = "official test fixture".toByteArray()
    private val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun form(required: Boolean) = ApplicationFormManifest(1,"atomic-form-v1","BIZINFO","PBLN_1","공고","양식",
        "https://www.bizinfo.go.kr/form","form.hwpx",bytes.size.toLong(),hash,"SOURCE_DOCUMENT_EXTRACTED",false,
        listOf(ApplicationServiceField.GENERAL),listOf(ApplicationFormSectionDefinition("company","기업","table 1","기업 입력",
            listOf(ApplicationFormFieldDefinition("name","기업명","기업명 입력",true),ApplicationFormFieldDefinition("consent","동의","원문 확인",required)))))

    private fun stub() {
        `when`(client.configuration()).thenReturn(AiDocumentConfigurationPayload("application-document-mcp-v1","b".repeat(64)))
        val fallback=AiDocumentMappingRequest(sourceBase64="",sourceSha256="",format="hwpx",scope="",fields=emptyList())
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: fallback)).thenReturn(AiDocumentMappingPayload(
            "application-document-mcp-v1","b".repeat(64),hash,"test-map","test-engine",
            listOf(ApplicationDocumentPlacement("company:name","name-cell")),listOf("name-cell"),
            mapOf("targets" to listOf(mapOf("targetId" to "name-cell")),"unmappedFieldIds" to listOf("company:consent"))))
    }

    @Test fun optionalManualFieldIsExplicitInThePublicContract() {
        stub()
        val form=form(false)
        val mapped=service.ensure(form,bytes,"hwpx")
        val response=ApplicationFormResponse.from(form.copy(documentMapSnapshot=mapped))
        assertTrue(response.sections.single().fields[0].documentWritable)
        assertFalse(response.sections.single().fields[1].documentWritable)
        assertEquals(listOf("company:name"),mapped.bindings.map { it.factId })
        verifyNoInteractions(editor)
    }

    @Test fun requiredUnmappedFieldCannotBePublished() {
        stub()
        val error=assertThrows(ApplicationDocumentException::class.java) { service.ensure(form(true),bytes,"hwpx") }
        assertEquals("APPLICATION_DOCUMENT_MAPPING_FAILED",error.code)
    }
}
