package ai.govbiz.core.applicationpreparation.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core._common.helper.executeAiServiceCall
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationConfigurationPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationPreparationInterpretRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryPayload
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationFormDiscoveryRequest
import ai.govbiz.core.applicationpreparation.client.ai.exception.AiApplicationFormValidationException
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.http.MediaType
import org.springframework.http.client.ClientHttpResponse
import org.slf4j.LoggerFactory
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import tools.jackson.core.JacksonException
import tools.jackson.databind.ObjectMapper
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDraftRequest
import ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDraftPayload

@Component
class AiApplicationPreparationClient(
    @param:Qualifier("aiServiceRestClient") private val client: RestClient,
    private val json: ObjectMapper,
    @param:Qualifier("aiApplicationFormDiscoveryRestClient") private val discoveryClient: RestClient,
    private val properties: ai.govbiz.core._common.ai_config.AiServiceClientProperties,

) {
    fun placeDocument(request: ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDocumentRequest): ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDocumentPayload = executeAiServiceCall {
        client.post().uri("/internal/v1/application-preparations/document").contentType(MediaType.APPLICATION_JSON).body(request).retrieve()
            .onStatus({ it.value() == 504 }, { _, _ -> throw AiServiceCallException.timeout(null) })
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.invalidResponse("Document placement failed", null) })
            .body(ai.govbiz.core.applicationpreparation.client.ai.dto.AiApplicationDocumentPayload::class.java)
            ?: throw AiServiceCallException.invalidResponse("Document placement was empty", null)
    }

    fun draftConfiguration(): AiApplicationPreparationConfigurationPayload = executeAiServiceCall {
        client.get().uri("/internal/v1/application-preparations/draft/configuration").retrieve()
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiApplicationPreparationConfigurationPayload::class.java)
            ?: throw AiServiceCallException.invalidResponse("Application draft configuration was empty", null)
    }

    fun draft(request: AiApplicationDraftRequest): AiApplicationDraftPayload = executeAiServiceCall {
        client.post().uri("/internal/v1/application-preparations/draft").contentType(MediaType.APPLICATION_JSON).body(request).retrieve()
            .onStatus({ it.value() == 504 }, { _, _ -> throw AiServiceCallException.timeout(null) })
            .onStatus({ it.value() == 503 }, { _, response ->
                if (readErrorCode(response) == "APPLICATION_PREPARATION_FAILED") {
                    throw AiServiceCallException.invalidResponse("Application draft response failed validation", null)
                }
                throw AiServiceCallException.unavailable(null)
            })
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiApplicationDraftPayload::class.java)
            ?: throw AiServiceCallException.invalidResponse("Application draft response was empty", null)
    }

    fun configuration(): AiApplicationPreparationConfigurationPayload = executeAiServiceCall {
        client.get().uri("/internal/v1/application-preparations/configuration").retrieve()
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiApplicationPreparationConfigurationPayload::class.java)
            ?: throw AiServiceCallException.invalidResponse("Application preparation configuration was empty", null)
    }

    fun interpret(request: AiApplicationPreparationInterpretRequest): AiApplicationPreparationInterpretPayload = executeAiServiceCall {
        client.post().uri("/internal/v1/application-preparations/interpret")
            .contentType(MediaType.APPLICATION_JSON).body(request).retrieve()
            .onStatus({ it.value() == 503 }, { _, response ->
                if (readErrorCode(response) == "APPLICATION_PREPARATION_FAILED") {
                    throw AiServiceCallException.invalidResponse("Application preparation response failed validation", null)
                }
                throw AiServiceCallException.unavailable(null)
            })
            .onStatus({ it.value() == 504 }, { _, _ -> throw AiServiceCallException.timeout(null) })
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiApplicationPreparationInterpretPayload::class.java)
            ?: throw AiServiceCallException.invalidResponse("Application preparation response was empty", null)
    }

    fun discoveryConfiguration(): AiApplicationPreparationConfigurationPayload = executeAiServiceCall {
        discoveryClient.get().uri("/internal/v1/application-preparations/discovery/configuration").retrieve()
            .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
            .body(AiApplicationPreparationConfigurationPayload::class.java)
            ?.also { config ->
                val model = requireNotNull(config.modelTimeoutSeconds) { "Discovery model timeout missing" }
                val run = requireNotNull(config.runTimeoutSeconds) { "Discovery run timeout missing" }
                require(model.isFinite() && run.isFinite() && model > 0 && model < run && run * 1000 < properties.applicationFormDiscoveryReadTimeout.toMillis()) { "Discovery timeout ordering mismatch" }
            }
            ?: throw AiServiceCallException.invalidResponse("Application form discovery configuration was empty", null)
    }

    fun discover(request: AiApplicationFormDiscoveryRequest): AiApplicationFormDiscoveryPayload = try {
        executeAiServiceCall {
            discoveryClient.post().uri("/internal/v1/application-preparations/discovery")
                .contentType(MediaType.APPLICATION_JSON).body(request).retrieve()
                .onStatus({ it.value() == 422 }, { _, response ->
                    if (readErrorCode(response) == "APPLICATION_FORM_AI_INVALID_RESPONSE") {
                        throw AiApplicationFormValidationException()
                    }
                    throw AiServiceCallException.unavailable(null)
                })
                .onStatus({ it.value() == 503 }, { _, response ->
                    if (readErrorCode(response) == "APPLICATION_PREPARATION_FAILED") {
                        throw AiServiceCallException.invalidResponse("Application form discovery response failed validation", null)
                    }
                    throw AiServiceCallException.unavailable(null)
                })
                .onStatus({ it.value() == 504 }, { _, response ->
                    val stage = runCatching { json.readTree(response.body.readNBytes(8192)).path("detail").path("timeoutStage").asString("AI_UNKNOWN") }
                        .getOrDefault("AI_UNKNOWN")
                    throw ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException(
                        stage.takeIf { it in setOf("AI_MODEL", "AI_RUN") } ?: "AI_UNKNOWN")
                })
                .onStatus({ it.value() != 200 }, { _, _ -> throw AiServiceCallException.unavailable(null) })
                .body(AiApplicationFormDiscoveryPayload::class.java)
                ?: throw AiServiceCallException.invalidResponse("Application form discovery response was empty", null)
        }
    } catch (error: AiServiceCallException) {
        if (error.failure == AiServiceFailure.TIMEOUT) throw ai.govbiz.core.applicationpreparation.client.ai.exception.ApplicationFormTimeoutException("CORE_READ", error)
        if (error.failure == AiServiceFailure.INVALID_RESPONSE) {
            val decoding = generateSequence(error as Throwable?) { it.cause }
                .filterIsInstance<JacksonException>()
                .firstOrNull()
            val stage = when {
                decoding != null -> "decode"
                error.message?.endsWith("was empty") == true -> "empty"
                else -> "upstream-validation"
            }
            logger.warn(
                "application_form_discovery_response_invalid stage={} path={} errorType={} documentCount={} blockCount={}",
                stage,
                decoding?.safePath() ?: "unknown",
                decoding?.javaClass?.simpleName ?: error.cause?.javaClass?.simpleName ?: "UNKNOWN",
                request.documents.size,
                request.documents.sumOf { it.blocks.size },
            )
        }
        throw error
    }

    private fun readErrorCode(response: ClientHttpResponse): String? {
        val bytes = response.body.readNBytes(8193)
        if (bytes.size > 8192) return null
        return runCatching { json.readTree(bytes).path("detail").path("code").asString() }.getOrNull()
    }

    private fun JacksonException.safePath(): String = path.joinToString("") { reference ->
        reference.propertyName?.let { ".$it" } ?: "[${reference.index}]"
    }.removePrefix(".").ifEmpty { "unknown" }

    private companion object {
        val logger = LoggerFactory.getLogger(AiApplicationPreparationClient::class.java)
    }
}
