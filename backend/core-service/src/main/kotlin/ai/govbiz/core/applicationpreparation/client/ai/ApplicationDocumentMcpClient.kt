package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core.applicationpreparation.client.ai.dto.*
import ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationDocumentMcpException
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.beans.factory.annotation.Value
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.databind.ObjectMapper
import java.net.ConnectException
import java.net.UnknownHostException
import java.net.http.HttpConnectTimeoutException
import java.nio.channels.UnresolvedAddressException

@Component
class ApplicationDocumentMcpClient(
    @param:Qualifier("aiApplicationFormDiscoveryRestClient") private val client: RestClient,
    @param:Value("\${DOCUMENT_INTERNAL_TOKEN:}") private val token: String,
    private val json: ObjectMapper,
) {
    /** 부작용 없는 설정 조회라 어떤 실패든 결과 불명이 아닙니다. 연결 실패는 다시 시도할 수 있는 일시 오류로 둡니다. */
    fun configuration(): AiDocumentConfigurationPayload = call(readOnly = true) {
        client.get().uri("/internal/v1/application-preparations/document/configuration").retrieve()
            .body(AiDocumentConfigurationPayload::class.java)!!.also {
                if (it.contractVersion != "application-document-mcp-v1" || !Regex("[a-f0-9]{64}").matches(it.pipelineVersion))
                    throw ApplicationDocumentMcpException("APPLICATION_DOCUMENT_MCP_NOT_READY", "문서 편집 실행 환경의 계약 버전을 확인하지 못했습니다.")
            }
    }

    fun generate(request: AiDocumentGenerationRequest): AiDocumentGenerationPayload = call {
        post("/internal/v1/application-preparations/document/generate", request).body(AiDocumentGenerationPayload::class.java)!!
    }

    fun map(request: AiDocumentMappingRequest): AiDocumentMappingPayload = call {
        post("/internal/v1/application-preparations/document/map", request).body(AiDocumentMappingPayload::class.java)!!
    }

    private fun post(path: String, request: Any): RestClient.ResponseSpec {
        if (token.length < 32) throw ApplicationDocumentMcpException("APPLICATION_DOCUMENT_MCP_NOT_READY", "문서 편집 실행 환경이 준비되지 않았습니다.")
        return client.post().uri(path).header("Authorization", "Bearer $token").contentType(MediaType.APPLICATION_JSON).body(request).retrieve()
            .onStatus({ it.value() != 200 }, { _, response ->
                val code = runCatching { json.readTree(response.body.readNBytes(8192)).path("detail").path("code").asString() }.getOrNull()
                val allowed = setOf("INPUT_REQUIRED", "UNSUPPORTED", "MAPPING_FAILED", "FORM_REANALYSIS_REQUIRED", "UNMAPPED_INPUT", "SOURCE_CHANGED", "MCP_NOT_READY", "MCP_FAILED", "PLAN_FAILED", "PLAN_TIMEOUT", "RUN_CONFLICT", "VALIDATION_FAILED", "OVERFLOW", "OUTCOME_UNKNOWN", "LIMIT_EXCEEDED", "NO_WRITABLE_INPUT").map { "APPLICATION_DOCUMENT_$it" }
                throw ApplicationDocumentMcpException(code?.takeIf { it in allowed } ?: "APPLICATION_DOCUMENT_MCP_FAILED", "문서 편집을 완료하지 못했습니다. 오류 상태를 확인해 주세요.")
            })
    }

    // 요청을 보내기 전에 끝난 실패와 설정 조회 실패는 유료 작업이 시작되지 않았으므로 결과 불명으로 두지 않습니다.
    // 결과 불명은 작성본을 오래 잠그므로 요청 본문을 보낸 뒤의 실패에만 씁니다.
    private fun <T> call(readOnly: Boolean = false, block: () -> T): T = try { block() }
    catch (error: ApplicationDocumentMcpException) { throw error }
    catch (error: Exception) {
        if (readOnly || error.failedBeforeSending()) throw ApplicationDocumentMcpException("APPLICATION_DOCUMENT_MCP_UNAVAILABLE",
            "문서 편집 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", error)
        throw ApplicationDocumentMcpException("APPLICATION_DOCUMENT_OUTCOME_UNKNOWN", "문서 작업 결과를 확인하지 못했습니다. 관리자 확인 후 다시 시도해 주세요.", error)
    }

    private fun Throwable.failedBeforeSending(): Boolean = generateSequence(this) { it.cause }.any {
        it is HttpConnectTimeoutException || it is ConnectException || it is UnknownHostException || it is UnresolvedAddressException
    }
}
