package ai.govbiz.core.supportprogram.client.ops

import ai.govbiz.core.supportprogram.client.ops.config.ProductionQualityProperties
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityContextRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityOperationMaterialRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityOperationSampleRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualityMaterialRequest
import ai.govbiz.core.supportprogram.client.ops.dto.ProductionQualitySampleRequest
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.net.http.HttpTimeoutException
import java.time.Instant
import java.util.UUID
import java.util.concurrent.CompletionException
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit
import org.slf4j.LoggerFactory
import tools.jackson.databind.ObjectMapper

/** 검증 완료 표본을 최대 8건까지만 비동기로 전송한다. 수집 오류는 사용자 답변과 분리한다. */
class ProductionQualityClient(
    private val properties: ProductionQualityProperties,
    private val mapper: ObjectMapper,
    private val httpClient: HttpClient,
) : AutoCloseable {
    private val inFlight = Semaphore(8)

    fun record(material: ProductionQualityMaterialRequest, traceId: String?) {
        if (properties.endpoint == null) return
        val id = UUID.randomUUID()
        if (!selected(id)) return
        // 질문·답변의 민감정보와 근거의 주민번호·인증정보는 마스킹 전에 제외한다.
        if (sensitive(material.question) || sensitive(material.answer) ||
            material.chunks.any { chunk -> BLOCKED_PATTERNS.any { it.containsMatchIn(chunk.text) } }
        ) {
            logger.info("production_quality_sample_skipped reason=sensitive_content")
            return
        }
        dispatch(id) {
            // 공고 문의처 때문에 표본 전체가 누락되지 않도록 수집용 근거 사본만 마스킹한다.
            val collectedMaterial = material.copy(chunks = material.chunks.map { chunk ->
                chunk.copy(text = CONTACT_PATTERNS.fold(chunk.text) { text, pattern -> pattern.replace(text, "[REDACTED]") })
            })
            val documentIds = material.chunks.map { it.documentId }.distinct()
            require(documentIds.size == 1)
            val payload = ProductionQualitySampleRequest(
                id = id.toString(), capturedAt = Instant.now().toString(), sampleRateBps = properties.rateBps,
                sourceDocumentId = documentIds.single(), traceId = traceId?.takeIf { TRACE_ID.matches(it) },
                release = properties.release.takeIf { RELEASE.matches(it) }, material = collectedMaterial,
                evidenceRedacted = collectedMaterial != material,
            )
            mapper.writeValueAsBytes(payload)
        }
    }

    /** 정상 업무와 분리된 운영 표본이다. 계정·작업·프로필 객체를 직렬화하지 않고 호출부 allowlist만 받는다. */
    fun recordOperation(
        scope: String,
        question: String,
        contexts: List<ProductionQualityContextRequest>,
        output: String,
        outputStatus: String = "COMPLETED",
        traceId: String? = null,
        sourceDocumentId: String = "",
    ) {
        if (properties.endpoint == null) return
        val id = UUID.randomUUID()
        if (!selected(id)) return
        dispatch(id) {
            require(scope in OPERATION_SCOPES)
            require(question.isNotBlank() && question.length <= 4_000)
            require(output.isNotBlank() && outputStatus in OUTPUT_STATUSES)
            require(sourceDocumentId.isEmpty() || (DOCUMENT_ID.matches(sourceDocumentId) && sourceDocumentId == sourceDocumentId.trim() && !sensitive(sourceDocumentId)))
            require(contexts.map { it.id }.distinct().size == contexts.size)
            require(contexts.all { it.label.isNotBlank() && it.text.isNotBlank() && CONTEXT_ID.matches(it.id) })
            // 잘리기 전의 전체 사본을 검사하여 뒤쪽의 인증정보도 전송하지 않는다.
            if (sensitive(question) || sensitive(output) || contexts.any { context ->
                    sensitive(context.id) || BLOCKED_PATTERNS.any { it.containsMatchIn(context.label) || it.containsMatchIn(context.text) }
                }
            ) {
                logger.info("production_quality_sample_skipped reason=sensitive_content")
                return@dispatch null
            }
            val masked = contexts.map { it.copy(label = redactContacts(it.label), text = redactContacts(it.text)) }
            var material = ProductionQualityOperationMaterialRequest(
                question, masked.take(20).map { it.copy(label = clip(it.label, 200), text = clip(it.text, 12_000)) },
                clip(output, 16_000), outputStatus,
                masked.size > 20 || masked.any { it.label.length > 200 || it.text.length > 12_000 }, output.length > 16_000,
            )
            fun bytes() = mapper.writeValueAsBytes(ProductionQualityOperationSampleRequest(
                id = id.toString(), capturedAt = Instant.now().toString(), scope = scope,
                sampleRateBps = properties.rateBps, sourceDocumentId = sourceDocumentId,
                traceId = traceId?.takeIf { TRACE_ID.matches(it) }, release = properties.release.takeIf { RELEASE.matches(it) },
                material = material, evidenceRedacted = masked != contexts,
            ))
            var body = bytes()
            // UTF-8 총량도 제한한다. 근거를 줄인 경우 반드시 부분 자료라고 표시한다.
            while (body.size > 102_400 && material.contexts.any { it.text.length > 1 }) {
                val longest = material.contexts.indices.maxBy { material.contexts[it].text.length }
                material = material.copy(contexts = material.contexts.mapIndexed { index, context ->
                    if (index == longest) context.copy(text = clip(context.text, maxOf(1, context.text.length / 2))) else context
                }, contextTruncated = true)
                body = bytes()
            }
            body
        }
    }

    // Kotlin 문자열 길이는 UTF-16이므로 잘림 경계의 surrogate pair를 분리하지 않는다.
    private fun clip(text: String, limit: Int): String {
        if (text.length <= limit) return text
        val boundary = if (limit > 0 && text[limit - 1].isHighSurrogate()) limit - 1 else limit
        return text.take(boundary)
    }

    private fun redactContacts(text: String): String =
        CONTACT_PATTERNS.fold(text) { value, pattern -> pattern.replace(value, "[REDACTED]") }

    private fun dispatch(id: UUID, prepare: () -> ByteArray?) {
        val endpoint = properties.endpoint ?: return
        if (!inFlight.tryAcquire()) {
            logger.warn("production_quality_sample_skipped reason=capacity")
            return
        }
        val startedAt = System.nanoTime()
        try {
            val body = prepare()
            if (body == null) {
                inFlight.release()
                return
            }
            require(body.size <= 102_400)
            val request = HttpRequest.newBuilder(endpoint)
                .timeout(properties.requestTimeout)
                .header("Authorization", "Bearer ${properties.token}")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                .build()
            httpClient.sendAsync(request, HttpResponse.BodyHandlers.discarding()).whenComplete { response, failure ->
                inFlight.release()
                val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt)
                when {
                    failure != null -> {
                        val cause = if (failure is CompletionException) failure.cause else failure
                        val reason = if (cause is HttpTimeoutException) "timeout" else "transport"
                        // 응답을 못 받았어도 Ops가 이미 저장했을 수 있다. 재전송하거나 실패로 단정하지 않는다.
                        logger.warn("production_quality_sample_delivery_unknown reason={} sample_id={} elapsed_ms={}", reason, id, elapsedMs)
                    }
                    response.statusCode() !in 200..299 -> logger.warn(
                        "production_quality_sample_failed reason=rejected sample_id={} status={} elapsed_ms={}",
                        id, response.statusCode(), elapsedMs,
                    )
                    else -> logger.info(
                        "production_quality_sample_accepted sample_id={} status={} elapsed_ms={}",
                        id, response.statusCode(), elapsedMs,
                    )
                }
            }
        } catch (_: Exception) {
            inFlight.release()
            logger.warn("production_quality_sample_failed reason=dispatch sample_id={}", id)
        }
    }

    // 새 UUID의 균등한 하위 비트로 표본을 선택한다. 질문·계정·trace ID에 따라 편향되지 않는다.
    internal fun selected(id: UUID): Boolean =
        java.lang.Long.remainderUnsigned(id.leastSignificantBits, 10_000) < properties.rateBps

    private fun sensitive(text: String): Boolean =
        CONTACT_PATTERNS.any { it.containsMatchIn(text) } || BLOCKED_PATTERNS.any { it.containsMatchIn(text) }

    override fun close() = httpClient.shutdown()

    companion object {
        private val logger = LoggerFactory.getLogger(ProductionQualityClient::class.java)
        private val OPERATION_SCOPES = setOf("assistant-agent", "support-program-search", "application-document-generation", "combination-review")
        private val OUTPUT_STATUSES = setOf("COMPLETED", "NO_RESULTS", "INSUFFICIENT_EVIDENCE")
        private val DOCUMENT_ID = Regex("[A-Z][A-Z0-9_]{0,63}:[^\\p{C}]{1,255}")
        private val CONTEXT_ID = Regex("[A-Za-z0-9_:.\\-]{1,128}")
        private val TRACE_ID = Regex("[0-9a-f]{32}")
        private val RELEASE = Regex("[0-9a-f]{40}")
        // 고정 패턴 검사이며 완전한 개인정보 탐지로 해석하지 않는다.
        private val CONTACT_PATTERNS = listOf(
            Regex("[A-Z0-9._%+\\-]+@[A-Z0-9.\\-]+\\.[A-Z]{2,}", RegexOption.IGNORE_CASE),
            Regex("(?<![0-9])(?:0[0-9]{1,2}|\\+82[ \\-]?[0-9]{1,2})[ \\-]?[0-9]{3,4}[ \\-]?[0-9]{4}(?![0-9])"),
        )
        private val BLOCKED_PATTERNS = listOf(
            Regex("https?://[^\\s]*[?&](?:X-Amz-[^=]*|signature|token|credential)=[^\\s]+", RegexOption.IGNORE_CASE),
            Regex("(?<![0-9])[0-9]{6}[ \\-]?[1-8][0-9]{6}(?![0-9])"),
            Regex("(?:Bearer\\s+\\S+|(?:api[_-]?key|password|secret|token|cookie|set-cookie)\\s*[:=]\\s*\\S+|sk-[A-Z0-9_-]{16,}|eyJ[A-Z0-9_-]+\\.[A-Z0-9_-]+\\.[A-Z0-9_-]+)", RegexOption.IGNORE_CASE),
        )
    }
}
