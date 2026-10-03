package ai.govbiz.core.applicationpreparation.client.ai.mapper

import ai.govbiz.core.applicationpreparation.client.ai.dto.AiOnlineFormInspectionPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiOnlineFormQuestionPayload
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleFormQuestionKind
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormSourceKind
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class ApplicationOnlineFormMcpMapperTest {
    @Test fun preservesQuestionMetadataAndLegacyFormId() {
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val questions = listOf(
            AiOnlineFormQuestionPayload(1, "first", "11", "첫 질문", "", true, "SINGLE_CHOICE", listOf("나", "가"), true, true, null),
            AiOnlineFormQuestionPayload(2, "second", "12", "둘째 질문", "설명", false, "LONG_TEXT", emptyList(), false, true, null),
        )
        val payload = AiOnlineFormInspectionPayload("google-public-form-reader-v2", "fb-public-load-data-v1", url, url,
            "신청서", "a".repeat(64), questions)
        val expected = MessageDigest.getInstance("SHA-256").digest(url.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }.take(24)
        val source = ApplicationOnlineFormMcpMapper().toSource(payload)
        assertEquals("gpub-form-v1:$expected", source.formId)
        assertEquals(listOf("first", "second"), source.controls.map { it.controlId })
        assertEquals(listOf("첫 질문", "둘째 질문"), source.controls.map { it.label })
        assertEquals(listOf(true, false), source.controls.map { it.required })
        assertEquals(ApplicationOnlineFormSourceKind.SINGLE_CHOICE, source.controls.first().kind)
        assertEquals(listOf("나", "가"), source.controls.first().options)
    }

    @Test fun googleFormMarksUnknownQuestionsUnsupported() {
        val url = "https://docs.google.com/forms/d/e/public-id/viewform"
        val payload = AiOnlineFormInspectionPayload("google-public-form-reader-v2", "fb-public-load-data-v1", url, url, "신청서",
            "a".repeat(64), listOf(
                AiOnlineFormQuestionPayload(1, "first", "11", "기업명", "상호", true, "SHORT_TEXT", emptyList(), false, true, null),
                AiOnlineFormQuestionPayload(2, "second", null, "설립일", "", true, "UNKNOWN", emptyList(), false, false, "DATE"),
            ))
        val form = ApplicationOnlineFormMcpMapper().toGoogleForm(payload)
        assertEquals(url, form.responderUrl)
        assertEquals(listOf(ApplicationGoogleFormQuestionKind.SHORT_TEXT, ApplicationGoogleFormQuestionKind.UNSUPPORTED), form.questions.map { it.kind })
        assertEquals("상호", form.questions.first().description)
    }
}
