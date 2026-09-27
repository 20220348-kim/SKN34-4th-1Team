package ai.govbiz.core.applicationpreparation.domain

import java.nio.file.Files
import java.nio.file.Path
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import tools.jackson.databind.ObjectMapper
import tools.jackson.module.kotlin.jacksonObjectMapper

class ApplicationOnlineFormSourceTest {
    private fun field(key: String, label: String, required: Boolean = true) = ApplicationFormFieldDefinition(key, label, "입력", required)
    private fun form(vararg fields: ApplicationFormFieldDefinition): ApplicationFormManifest {
        val seed = javaClass.getResourceAsStream("/application-preparation/innovation-voucher-2026-v1.json")!!.use {
            jacksonObjectMapper().readValue(it, ApplicationFormManifest::class.java)
        }
        return seed.copy(sections = listOf(ApplicationFormSectionDefinition("company", "기업", "문항", "입력", fields.toList())))
    }
    private fun control(id: String = "name", label: String = "기업명", required: Boolean = true) = ApplicationOnlineFormSourceControl(id, label, required)
    private fun source(vararg controls: ApplicationOnlineFormSourceControl) = ApplicationOnlineFormSource(1, "synthetic", "신청서", controls.toList())

    @Test
    fun invalidSourcesAreRejected() {
        assertThrows(IllegalArgumentException::class.java) { source(control(), control()) }
        assertThrows(IllegalArgumentException::class.java) { control(id = " ") }
        assertThrows(IllegalArgumentException::class.java) { control(label = "\t") }
        assertThrows(IllegalArgumentException::class.java) { source().copy(schemaVersion = 2) }
        assertThrows(IllegalArgumentException::class.java) { source().copy(formId = "") }
        assertThrows(IllegalArgumentException::class.java) { source().copy(formTitle = " ") }
    }

    @Test
    fun uniqueMatchingNormalizesOnlyWhitespaceAndKeepsReadOnlyCapabilities() {
        val manifest = form(field("name", "기업명"), field("representative", "대표자 이름"))
        val review = manifest.reviewOnlineForm(source(control(label = "  기업명  "), control("representative", "대표자\n\t  이름")))
        assertEquals(2, review.formMap.controls.size)
        assertTrue(review.issues.isEmpty())
        manifest.fieldMappings(review.formMap).forEach {
            assertEquals(ApplicationFieldMappingStatus.MAPPED, it.status)
            assertTrue(it.mapped)
            assertFalse(it.autoFillSupported)
            assertFalse(it.writable)
        }
    }

    @Test
    fun ambiguousControlsAreNeverSelected() {
        val review = form(field("name", "기업명")).reviewOnlineForm(source(control(), control("another")))
        assertTrue(review.formMap.controls.isEmpty())
        assertEquals(ApplicationOnlineFormReviewIssueCode.AMBIGUOUS_CONTROL, review.issues.single().code)
        assertEquals(listOf("name", "another"), review.issues.single().candidateControlIds)
    }

    @Test
    fun duplicateManifestLabelsCannotReuseAControlEvenAcrossSections() {
        val manifest = form(field("name", "기업명"))
        val otherSection = manifest.sections.single().copy(key = "other")
        val review = manifest.copy(sections = manifest.sections + otherSection).reviewOnlineForm(source(control()))
        assertTrue(review.formMap.controls.isEmpty())
        assertEquals(2, review.issues.size)
        assertTrue(review.issues.all { it.code == ApplicationOnlineFormReviewIssueCode.AMBIGUOUS_CONTROL })
    }

    @Test
    fun requiredMismatchInBothDirectionsNeedsReview() {
        listOf(true, false).forEach { required ->
            val review = form(field("name", "기업명", required)).reviewOnlineForm(source(control(required = !required)))
            assertTrue(review.formMap.controls.isEmpty())
            assertEquals(ApplicationOnlineFormReviewIssueCode.REQUIRED_FLAG_MISMATCH, review.issues.single().code)
        }
    }

    @Test
    fun missingRequiredOptionalAndUnmatchedSourceRemainExplicit() {
        val manifest = form(field("name", "기업명"), field("optional", "선택", false))
        val review = manifest.reviewOnlineForm(source(control("consent", "개인정보 수집 동의")))
        assertTrue(review.formMap.controls.isEmpty())
        assertEquals(listOf(ApplicationFieldMappingStatus.REQUIRED_MAPPING_MISSING, ApplicationFieldMappingStatus.UNMAPPED), manifest.fieldMappings(review.formMap).map { it.status })
        assertEquals(listOf(ApplicationOnlineFormReviewIssueCode.REQUIRED_CONTROL_NOT_FOUND, ApplicationOnlineFormReviewIssueCode.UNMATCHED_SOURCE_CONTROL), review.issues.map { it.code })
        assertEquals(listOf("consent"), review.issues.last().candidateControlIds)
        assertNull(review.issues.last().fieldId)
    }

    @Test
    fun wordsPunctuationNumbersAndCaseAreNotRemovedOrGuessed() {
        listOf("기업명 (필수)", "기업명1", "기업", "기업명 추가", "COMPANY").forEach { label ->
            val review = form(field("name", "기업명")).reviewOnlineForm(source(control(label = label)))
            assertTrue(review.formMap.controls.isEmpty())
        }
        assertTrue(form(field("name", "Company")).reviewOnlineForm(source(control(label = "company"))).formMap.controls.isEmpty())
    }

    @Test
    fun sourceFixtureIsDistinctFromConfirmedMapFixture() {
        val node = ObjectMapper().readTree(Files.readString(Path.of("../../evaluation/application-map/fixtures/synthetic-online-form-source-v1.json")))
        val source = ApplicationOnlineFormSource(node["schemaVersion"].asInt(), node["formId"].asText(), node["formTitle"].asText(),
            node["controls"].toList().map { ApplicationOnlineFormSourceControl(it["controlId"].asText(), it["label"].asText(), it["required"].asBoolean()) })
        val manifest = form(field("name", "기업명"), field("representative", "대표자명"))
        val review = manifest.reviewOnlineForm(source)
        assertEquals(2, review.formMap.controls.size)
        assertEquals(ApplicationOnlineFormReviewIssueCode.UNMATCHED_SOURCE_CONTROL, review.issues.single().code)
    }
}
