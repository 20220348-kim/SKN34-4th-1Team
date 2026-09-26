package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.client.ai.ApplicationDocumentMcpClient
import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.controller.dto.ApplicationFormResponse
import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.repository.ApplicationFormSnapshotRepository
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentMappingChangedException
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

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = ["hwp", "hwpx", "pdf"])
    fun existingThreeFormatMapsRemainCachedWhenPipelineAndSourceAreUnchanged(format: String) {
        val saved = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "b".repeat(64), hash,
            "native-map-v15-pdf-field-scope-options", "existing-$format-engine",
            listOf(ApplicationDocumentPlacement("company:name", "existing-target")), listOf("existing-target"),
            mapOf("targets" to listOf(mapOf("targetId" to "existing-target"))))
        val form = form(false).copy(documentMapSnapshot = saved)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)
        `when`(client.configuration()).thenReturn(AiDocumentConfigurationPayload("application-document-mcp-v1", "b".repeat(64)))

        assertSame(saved, service.ensure(form, bytes, format))
        verify(client, never()).map(any(AiDocumentMappingRequest::class.java) ?:
            AiDocumentMappingRequest(sourceBase64 = "", sourceSha256 = "", format = format, scope = "", fields = emptyList()))
        verifyNoInteractions(editor)
    }

    @Test fun changedDocxEngineRemapsWithoutInvalidatingTheThreeFormatPipeline() {
        val previous = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "b".repeat(64), hash,
            "native-map-v15-pdf-field-scope-options", "govbiz/ooxml-native@1",
            listOf(ApplicationDocumentPlacement("company:name", "docx:t:1:r:1:c:2:p:1")),
            listOf("docx:t:1:r:1:c:2:p:1"), mapOf("targets" to listOf(mapOf("targetId" to "docx:t:1:r:1:c:2:p:1")),
                "unmappedFieldIds" to listOf("company:consent")))
        val form = form(false).copy(documentMapSnapshot = previous)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)
        `when`(client.configuration()).thenReturn(AiDocumentConfigurationPayload("application-document-mcp-v1", "b".repeat(64),
            mapOf("docx" to "govbiz/ooxml-native@2")))
        val fallback = AiDocumentMappingRequest(sourceBase64 = "", sourceSha256 = "", format = "docx", scope = "", fields = emptyList())
        `when`(client.map(any(AiDocumentMappingRequest::class.java) ?: fallback)).thenReturn(AiDocumentMappingPayload(
            "application-document-mcp-v1", "b".repeat(64), hash, previous.mapVersion, "govbiz/ooxml-native@2",
            previous.bindings, previous.scopeTargetIds, previous.documentMap))
        `when`(snapshots.attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: previous)).thenAnswer { it.getArgument(1) }

        val mapped = service.ensure(form, bytes, "docx")

        assertEquals("govbiz/ooxml-native@2", mapped.engineVersion)
        verify(client).map(any(AiDocumentMappingRequest::class.java) ?: fallback)
        verify(snapshots).attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: previous)
    }

    @Test fun requiredUnmappedFieldCannotBePublished() {
        stub()
        val error=assertThrows(ApplicationDocumentException::class.java) { service.ensure(form(true),bytes,"hwpx") }
        assertEquals("APPLICATION_DOCUMENT_MAPPING_FAILED",error.code)
    }

    @Test fun changedPipelineRemapsAndReplacesSavedBindingsForTheSameSource() {
        stub()
        val stale = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "a".repeat(64), hash,
            "old-map", "test-engine", listOf(ApplicationDocumentPlacement("company:name", "name-cell")),
            listOf("name-cell"), mapOf("targets" to listOf(mapOf("targetId" to "name-cell"))))
        val form = form(false).copy(documentMapSnapshot = stale)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)
        `when`(snapshots.attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: stale))
            .thenAnswer { it.getArgument(1) }

        val mapped = service.ensure(form, bytes, "hwpx")

        assertEquals("b".repeat(64), mapped.pipelineVersion)
        assertEquals(listOf("name-cell"), mapped.bindings.map { it.targetId })
        verify(client).map(any(AiDocumentMappingRequest::class.java) ?:
            AiDocumentMappingRequest(sourceBase64="", sourceSha256="", format="hwpx", scope="", fields=emptyList()))
        verify(snapshots).attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: stale)
    }

    @Test fun changedBindingIsRejectedWithoutReplacingTheSavedMap() {
        stub()
        val stale = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "a".repeat(64), hash,
            "old-map", "test-engine", listOf(ApplicationDocumentPlacement("company:name", "old-cell")),
            listOf("old-cell"), mapOf("targets" to listOf(mapOf("targetId" to "old-cell"))))
        val form = form(false).copy(documentMapSnapshot = stale)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)

        val error = assertThrows(ApplicationDocumentException::class.java) {
            service.ensure(form, bytes, "hwpx")
        }

        assertEquals("APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", error.code)
        verify(client).map(any(AiDocumentMappingRequest::class.java) ?:
            AiDocumentMappingRequest(sourceBase64="", sourceSha256="", format="hwpx", scope="", fields=emptyList()))
        verify(snapshots, never()).attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: stale)
    }

    @Test fun changedScopeIsRejectedEvenWhenTheBindingIsUnchanged() {
        stub()
        val stale = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "a".repeat(64), hash,
            "old-map", "test-engine", listOf(ApplicationDocumentPlacement("company:name", "name-cell")),
            listOf("name-cell", "old-extra-cell"), mapOf("targets" to listOf(mapOf("targetId" to "name-cell"))))
        val form = form(false).copy(documentMapSnapshot = stale)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)

        val error = assertThrows(ApplicationDocumentException::class.java) {
            service.ensure(form, bytes, "hwpx")
        }

        assertEquals("APPLICATION_DOCUMENT_FORM_REANALYSIS_REQUIRED", error.code)
        verify(snapshots, never()).attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: stale)
    }

    @Test fun ownerScopedGenerationReceivesTheValidatedProposalWithoutPersistingIt() {
        stub()
        val stale = ApplicationDocumentMapSnapshot("application-document-mcp-v1", "a".repeat(64), hash,
            "old-map", "test-engine", listOf(ApplicationDocumentPlacement("company:name", "old-cell")),
            listOf("old-cell"), mapOf("targets" to listOf(mapOf("targetId" to "old-cell", "kind" to "paragraph"))))
        val form = form(false).copy(documentMapSnapshot = stale)
        `when`(snapshots.findByVersion(form.formVersionId)).thenReturn(form)

        val changed = assertThrows(ApplicationDocumentMappingChangedException::class.java) {
            service.ensure(form, bytes, "hwpx", captureChange = true)
        }

        assertEquals("old-cell", changed.previous.bindings.single().targetId)
        assertEquals("name-cell", changed.proposed.bindings.single().targetId)
        assertEquals("TARGET_CHANGED", changed.changes.first().type)
        verify(snapshots, never()).attachDocumentMap(eq(form.formVersionId) ?: form.formVersionId,
            any(ApplicationDocumentMapSnapshot::class.java) ?: stale)
    }
}
