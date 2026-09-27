package ai.govbiz.core.applicationpreparation.domain

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource

class ApplicationFieldMappingTest {
    @Test
    fun mappedRequiredFieldIsWritableWithItsOfficialIdentity() {
        val mapping = form().fieldMappings(snapshot(listOf(binding()))).single()
        assertEquals("company:name", mapping.fieldId)
        assertEquals("기업명", mapping.label)
        assertTrue(mapping.required)
        assertTrue(mapping.writable)
        assertEquals(ApplicationFieldMappingStatus.MAPPED, mapping.status)
        assertEquals(listOf(ApplicationFieldBinding("target", null)), mapping.bindings)
    }

    @Test
    fun optionalUnmappedFieldIsNotWritable() {
        val mapping = form(required = false).fieldMappings(snapshot(emptyList())).single()
        assertFalse(mapping.required)
        assertFalse(mapping.writable)
        assertEquals(ApplicationFieldMappingStatus.UNMAPPED, mapping.status)
        assertTrue(mapping.bindings.isEmpty())
    }

    @Test
    fun missingRequiredBindingNeverLooksLikeSuccess() {
        val mapping = form().fieldMappings(snapshot(emptyList())).single()
        assertFalse(mapping.writable)
        assertEquals(ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING, mapping.status)
    }

    @Test
    fun oneOfficialFieldPreservesMultipleNativeBindings() {
        val mapping = form().fieldMappings(snapshot(listOf(binding("first"), binding("second")))).single()
        assertTrue(mapping.writable)
        assertEquals(listOf("first", "second"), mapping.bindings.map { it.targetId })
    }

    @Test
    fun pdfBoxIsOnlyAReferenceAndDoesNotReplaceNativeAuthority() {
        val box = ApplicationDocumentBox(0.1f, 0.2f, 0.3f, 0.1f)
        val original = snapshot(listOf(ApplicationDocumentPlacement("company:name", "page-1", box)))
        val mapping = form().fieldMappings(original).single()
        assertEquals(box, mapping.bindings.single().box)
        val changed = original.copy(scopeTargetIds = listOf("page-1", "another-target"))
        assertEquals(listOf(mapping), form().fieldMappings(changed))
        assertEquals("SCOPE_CHANGED", mappingChanges(original, changed).single().type)
        assertEquals(setOf("fieldId", "label", "required", "status", "bindings"),
            ApplicationFieldMapping::class.java.declaredFields.filterNot { it.isSynthetic }.map { it.name }.toSet())
    }

    @ParameterizedTest
    @ValueSource(strings = ["s0.p1", "t1.r1.c2.p1", "pdf-field:company", "docx:t:1:r:1:c:2:p:1", "xlsx:s:Sheet1:c:B4"])
    fun nativeTargetSyntaxDoesNotChangeBusinessMeaning(targetId: String) {
        val mapping = form().fieldMappings(snapshot(listOf(binding(targetId)))).single()
        assertEquals("company:name", mapping.fieldId)
        assertTrue(mapping.required)
        assertTrue(mapping.writable)
        assertEquals(ApplicationFieldMappingStatus.MAPPED, mapping.status)
        assertEquals(targetId, mapping.bindings.single().targetId)
    }

    @Test
    fun projectionFollowsOfficialFieldOrderAndIgnoresNonOfficialFacts() {
        val form = form().copy(sections = form().sections.map { it.copy(fields = it.fields +
            ApplicationFormFieldDefinition("consent", "동의", "원문 확인", false)) })
        val mappings = form.fieldMappings(snapshot(listOf(binding(), ApplicationDocumentPlacement("unknown:field", "other"))))
        assertEquals(listOf("company:name", "company:consent"), mappings.map { it.fieldId })
        assertFalse(mappings.last().writable)
    }

    private fun binding(targetId: String = "target") = ApplicationDocumentPlacement("company:name", targetId)
    private fun snapshot(bindings: List<ApplicationDocumentPlacement>) = ApplicationDocumentMapSnapshot(
        "application-document-mcp-v1", "pipeline", "a".repeat(64), "map", "engine", bindings,
        bindings.map { it.targetId }, mapOf("unmappedFieldIds" to if (bindings.isEmpty()) listOf("company:name") else emptyList<String>(),
            "targets" to listOf(mapOf("nativeLocator" to mapOf("private" to "native address")))),
    )
    private fun form(required: Boolean = true) = ApplicationFormManifest(
        1, "mapping-form-v1", "BIZINFO", "PBLN_1", "공고", "신청서", "https://www.bizinfo.go.kr/form",
        "form.pdf", 10, "a".repeat(64), "SOURCE_DOCUMENT_EXTRACTED", false,
        listOf(ApplicationServiceField.GENERAL), listOf(ApplicationFormSectionDefinition(
            "company", "기업", "table 1", "기업 입력", listOf(ApplicationFormFieldDefinition("name", "기업명", "기업명 입력", required)),
        )),
    )
}
