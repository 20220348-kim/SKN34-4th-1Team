package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core.applicationpreparation.client.ai.dto.AiOnlineFormInspectionPayload
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.client.ai.mapper.ApplicationOnlineFormMcpMapper
import ai.govbiz.core.applicationpreparation.domain.ApplicationGoogleForm
import ai.govbiz.core.applicationpreparation.domain.ApplicationOnlineFormSource
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.ObjectMapper

@Component
class ApplicationOnlineFormMcpClient(
    @param:Qualifier("aiApplicationFormDiscoveryRestClient") private val client: RestClient,
    @param:Value("\${DOCUMENT_INTERNAL_TOKEN:}") private val token: String,
    private val json: ObjectMapper,
    private val mapper: ApplicationOnlineFormMcpMapper,
) {
    /** 신청 양식 Manifest와 대조할 문항입니다. 지원하지 않는 문항이 하나라도 있으면 완전한 source로 보지 않는다. */
    fun inspect(url: String): ApplicationOnlineFormSource {
        val payload = read(url)
        if (payload.questions.any { !it.supported || it.kind == "UNKNOWN" }) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_UNSUPPORTED")
        }
        return mapper.toSource(payload)
    }

    /** 미리 채운 설문 링크를 만들 문항입니다. 지원하지 않는 문항은 사용자가 구글 설문에서 직접 답하도록 남긴다. */
    fun readGoogleForm(url: String): ApplicationGoogleForm {
        val payload = read(url)
        return try {
            mapper.toGoogleForm(payload)
        } catch (_: IllegalArgumentException) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_SOURCE_CHANGED")
        }
    }

    private fun read(url: String): AiOnlineFormInspectionPayload {
        if (token.length < 32) throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_NOT_READY")
        val payload = try {
            client.post().uri("/internal/v1/application-preparations/online-form/inspect")
                .header("Authorization", "Bearer $token").contentType(MediaType.APPLICATION_JSON)
                .body(mapOf("url" to url)).retrieve()
                .onStatus({ it.value() != 200 }, { _, response ->
                    val code = runCatching { json.readTree(response.body.readNBytes(8192)).path("detail").path("code").asString() }.getOrNull()
                    throw ApplicationOnlineFormMcpException(code?.takeIf { it in ERROR_CODES } ?: "APPLICATION_ONLINE_FORM_MCP_FAILED")
                })
                .body(AiOnlineFormInspectionPayload::class.java) ?: throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_FAILED")
        } catch (error: ApplicationOnlineFormMcpException) {
            throw error
        } catch (error: Exception) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_FAILED", error)
        }
        if (payload.contractVersion != "google-public-form-reader-v2" || payload.parserVersion != "fb-public-load-data-v1" ||
            payload.formTitle.length !in 1..1000 || !Regex("[a-f0-9]{64}").matches(payload.semanticFingerprint) ||
            payload.questions.size !in 1..200 || payload.questions.map { it.controlId }.distinct().size != payload.questions.size ||
            payload.questions.withIndex().any { (index, it) -> it.order != index + 1 || it.controlId.length !in 1..100 ||
                it.label.length !in 1..5000 || it.description.length > 5000 || it.options.size > 300 ||
                it.options.any { option -> option.length !in 1..1000 } ||
                it.kind !in setOf("SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN", "UNKNOWN") ||
                it.supported == (it.kind == "UNKNOWN") || it.supported == (it.entryId == null) }) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_SOURCE_CHANGED")
        }
        return payload
    }

    private companion object {
        val ERROR_CODES = setOf("INVALID_URL", "UNSUPPORTED", "SOURCE_CHANGED", "PARSER_FAILED", "SOURCE_UNAVAILABLE",
            "REDIRECT_LIMIT", "LIMIT_EXCEEDED", "LOGIN_REQUIRED", "CLOSED", "NO_QUESTIONS", "MCP_NOT_READY", "MCP_FAILED")
            .map { "APPLICATION_ONLINE_FORM_$it" }.toSet()
    }
}
