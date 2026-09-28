package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core.applicationpreparation.client.ai.dto.AiOnlineFormInspectionPayload
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationOnlineFormMcpException
import ai.govbiz.core.applicationpreparation.client.ai.mapper.ApplicationOnlineFormMcpMapper
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
    fun inspect(url: String): ApplicationOnlineFormSource {
        if (token.length < 32) throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_NOT_READY")
        val payload = try {
            client.post().uri("/internal/v1/application-preparations/online-form/inspect")
                .header("Authorization", "Bearer $token").contentType(MediaType.APPLICATION_JSON)
                .body(mapOf("url" to url)).retrieve()
                .onStatus({ it.value() != 200 }, { _, response ->
                    val code = runCatching { json.readTree(response.body.readNBytes(8192)).path("detail").path("code").asString() }.getOrNull()
                    val allowed = setOf("INVALID_URL", "UNSUPPORTED", "SOURCE_CHANGED", "PARSER_FAILED", "SOURCE_UNAVAILABLE", "REDIRECT_LIMIT", "LIMIT_EXCEEDED", "MCP_NOT_READY", "MCP_FAILED").map { "APPLICATION_ONLINE_FORM_$it" }
                    throw ApplicationOnlineFormMcpException(code?.takeIf { it in allowed } ?: "APPLICATION_ONLINE_FORM_MCP_FAILED")
                })
                .body(AiOnlineFormInspectionPayload::class.java) ?: throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_FAILED")
        } catch (error: ApplicationOnlineFormMcpException) {
            throw error
        } catch (error: Exception) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_MCP_FAILED", error)
        }
        if (payload.contractVersion != "google-public-form-reader-v1" || payload.parserVersion != "semantic-dom-v1" ||
            payload.formTitle.length !in 1..1000 || !Regex("[a-f0-9]{64}").matches(payload.semanticFingerprint) ||
            payload.questions.size !in 1..200 || payload.questions.map { it.controlId }.distinct().size != payload.questions.size ||
            payload.questions.withIndex().any { (index, it) -> it.order != index + 1 || it.controlId.length !in 1..100 ||
                it.label.length !in 1..1000 || it.options.size > 100 || it.options.any { option -> option.length !in 1..1000 } ||
                it.kind !in setOf("SHORT_TEXT", "LONG_TEXT", "SINGLE_CHOICE", "MULTI_CHOICE", "DROPDOWN", "UNKNOWN") }) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_SOURCE_CHANGED")
        }
        if (payload.questions.any { !it.supported || it.kind == "UNKNOWN" }) {
            throw ApplicationOnlineFormMcpException("APPLICATION_ONLINE_FORM_UNSUPPORTED")
        }
        return mapper.toSource(payload)
    }
}
