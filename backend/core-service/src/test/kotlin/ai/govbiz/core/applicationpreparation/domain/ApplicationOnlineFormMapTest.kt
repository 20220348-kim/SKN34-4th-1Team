package ai.govbiz.core.applicationpreparation.domain

import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import tools.jackson.databind.ObjectMapper

class ApplicationOnlineFormMapTest {
    @Test
    fun syntheticFixtureMapsOfficialFieldsInManifestOrderWithoutWriter() {
        val node = ObjectMapper().readTree(Files.readString(Path.of("../../evaluation/application-map/fixtures/synthetic-online-form-v1.json")))
        val map = ApplicationOnlineFormMap(node["schemaVersion"].asInt(), node["formId"].asText(),
            node["controls"].toList().map { ApplicationOnlineFormControl(
                it["fieldId"].asText(), it["controlId"].asText(), it["label"].asText(), it["required"].asBoolean(),
            ) })
        val mappings = form().fieldMappings(map.copy(controls = map.controls.reversed()))
        assertEquals(listOf("company:name", "company:representative", "company:registration", "project:purpose"), mappings.map { it.fieldId })
        assertEquals(listOf("기업명", "대표자명", "사업자등록번호", "지원금 사용 목적"), mappings.map { it.label })
        mappings.forEach {
            assertEquals(ApplicationFieldMappingStatus.MAPPED, it.status)
            assertTrue(it.mapped)
            assertFalse(it.autoFillSupported)
            assertFalse(it.writable)
            assertEquals(ApplicationFieldBindingSourceType.ONLINE_FORM, it.bindings.single().sourceType)
            assertNull(it.bindings.single().box)
        }
        assertEquals("company-name", mappings.first().bindings.single().referenceId)
    }

    @Test
    fun optionalMissingControlIsUnmappedAndRequiredMissingIsExplicit() {
        val manifest = form().copy(sections = listOf(ApplicationFormSectionDefinition(
            "company", "기업", "공식 문항", "입력", listOf(
                ApplicationFormFieldDefinition("name", "기업명", "입력", true),
                ApplicationFormFieldDefinition("optional", "선택", "입력", false),
            ),
        )))
        val mappings = manifest.fieldMappings(map(emptyList()))
        assertEquals(listOf(ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING, ApplicationFieldMappingStatus.UNMAPPED), mappings.map { it.status })
        mappings.forEach { assertFalse(it.mapped); assertFalse(it.autoFillSupported); assertFalse(it.writable) }
    }

    @Test
    fun unknownOfficialIdentityIsRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            form().fieldMappings(map(listOf(control().copy(fieldId = "unknown:field"))))
        }
    }

    @Test
    fun duplicateControlIdIsRejectedEvenAcrossDifferentFields() {
        assertThrows(IllegalArgumentException::class.java) {
            map(listOf(control(), control().copy(fieldId = "company:representative")))
        }
    }

    @Test
    fun multipleControlsForOneFieldRequireReviewInsteadOfAssumingFileMultiplicity() {
        val error = assertThrows(IllegalArgumentException::class.java) {
            map(listOf(control(), control().copy(controlId = "another-control")))
        }
        assertTrue(error.message!!.contains("require review"))
    }

    @Test
    fun invalidSchemaAndBlankReferencesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { map(emptyList()).copy(schemaVersion = 2) }
        assertThrows(IllegalArgumentException::class.java) { map(emptyList()).copy(formId = " ") }
        assertThrows(IllegalArgumentException::class.java) { control().copy(controlId = " ") }
        assertThrows(IllegalArgumentException::class.java) { control().copy(fieldId = "") }
        assertThrows(IllegalArgumentException::class.java) { control().copy(label = "") }
    }

    @Test
    fun requiredConflictIsRejectedAndManifestOwnsDisplayLabel() {
        assertThrows(IllegalArgumentException::class.java) {
            form().fieldMappings(map(listOf(control().copy(required = false))))
        }
        assertEquals("기업명", form().fieldMappings(map(listOf(control().copy(label = "확인된 control 제목")))).first().label)
    }

    @Test
    fun statusAndCapabilityDoNotOverrideMissingBindingOrOnlineWriter() {
        val mapped = form().fieldMappings(map(listOf(control()))).first()
        assertFalse(mapped.copy(bindings = emptyList()).mapped)
        assertFalse(mapped.copy(bindings = emptyList()).writable)
        assertFalse(mapped.copy(status = ApplicationFieldMappingStatus.UNMAPPED).mapped)
        assertFalse(mapped.copy(status = ApplicationFieldMappingStatus.UNMAPPED).writable)
        assertThrows(IllegalArgumentException::class.java) {
            ApplicationFieldBinding("control", ApplicationDocumentBox(0f, 0f, 1f, 1f), ApplicationFieldBindingSourceType.ONLINE_FORM)
        }
    }

    @ParameterizedTest
    @ValueSource(strings = ["s0.p1", "t1.r1.c2.p1", "pdf-field:company", "docx:t:1:r:1:c:2:p:1", "xlsx:s:Sheet1:c:B4"])
    fun fileFiveFormatsKeepMappingAndWriterCapability(targetId: String) {
        val snapshot = ApplicationDocumentMapSnapshot(
            "application-document-mcp-v1", "pipeline", "a".repeat(64), "map", "engine",
            listOf(ApplicationDocumentPlacement("company:name", targetId)), listOf(targetId), emptyMap(),
        )
        val mapping = form().fieldMappings(snapshot).first()
        assertTrue(mapping.mapped)
        assertTrue(mapping.autoFillSupported)
        assertTrue(mapping.writable)
        assertEquals(ApplicationFieldBindingSourceType.FILE, mapping.bindings.single().sourceType)
        assertEquals(targetId, mapping.bindings.single().referenceId)
    }

    private fun control() = ApplicationOnlineFormControl("company:name", "company-name", "기업명", true)
    private fun map(controls: List<ApplicationOnlineFormControl>) = ApplicationOnlineFormMap(1, "synthetic-online-form-v1", controls)
    private fun form() = ApplicationFormManifest(
        1, "mapping-form-v1", "BIZINFO", "PBLN_1", "공고", "신청서", "https://www.bizinfo.go.kr/form",
        "form.pdf", 10, "a".repeat(64), "SOURCE_DOCUMENT_EXTRACTED", false,
        listOf(ApplicationServiceField.GENERAL), listOf(
            ApplicationFormSectionDefinition("company", "기업", "공식 문항", "기업 입력", listOf(
                ApplicationFormFieldDefinition("name", "기업명", "입력", true),
                ApplicationFormFieldDefinition("representative", "대표자명", "입력", true),
                ApplicationFormFieldDefinition("registration", "사업자등록번호", "입력", true),
            )),
            ApplicationFormSectionDefinition("project", "계획", "공식 문항", "계획 입력", listOf(
                ApplicationFormFieldDefinition("purpose", "지원금 사용 목적", "입력", true),
            )),
        ),
    )
}
