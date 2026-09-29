package ai.govbiz.core.supportprogram.helper

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.Tracer
import io.opentelemetry.context.Context
import io.opentelemetry.context.ContextKey
import org.slf4j.LoggerFactory

/** 상세 공고 질문의 Core 단계와 내부 AI 호출을 본문 없이 연결한다. */
class SupportProgramEvidenceTracingHelper(
    private val tracer: Tracer = OpenTelemetry.noop().getTracer("govbiz-evidence"),
    private val environment: String = "development",
    private val release: String = "",
) {
    fun <T> observe(stage: String, action: () -> T): T {
        // 자료 선수집·도우미 준비 같은 다른 유스케이스에 독립 Core trace를 만들지 않는다.
        if (stage != "total" && Context.current().get(EVIDENCE_CONTEXT) != true) return action()
        val builder = tracer.spanBuilder("evidence.$stage")
        if (stage == "total") builder.setNoParent()
        val span = builder.startSpan()
        span.setAttribute("langfuse.trace.name", "support-program-evidence")
        span.setAttribute("langfuse.environment", environment)
        if (release.isNotEmpty()) span.setAttribute("langfuse.release", release)
        val scope = Context.current().with(span).with(EVIDENCE_CONTEXT, true).makeCurrent()
        try {
            return action().also { span.setAttribute("langfuse.observation.metadata.outcome", "completed") }
        } catch (error: Throwable) {
            val outcome = if (error is AiServiceCallException && error.failure == AiServiceFailure.TIMEOUT) "timeout" else "failed"
            span.setStatus(StatusCode.ERROR)
            span.setAttribute("langfuse.observation.level", "ERROR")
            span.setAttribute("langfuse.observation.status_message", outcome)
            span.setAttribute("langfuse.observation.metadata.outcome", outcome)
            throw error
        } finally {
            if (stage == "total" && span.isRecording) logger.info("support_program_evidence trace_id={}", span.spanContext.traceId)
            scope.close()
            span.end()
        }
    }

    fun recordCache(state: String, chunkCount: Int? = null) {
        if (Context.current().get(EVIDENCE_CONTEXT) != true) return
        Span.current().setAttribute("langfuse.observation.metadata.cache_state", state)
        chunkCount?.let { Span.current().setAttribute("langfuse.observation.metadata.chunk_count", it.toLong()) }
    }

    companion object {
        private val EVIDENCE_CONTEXT = ContextKey.named<Boolean>("govbiz-evidence")
        private val logger = LoggerFactory.getLogger(SupportProgramEvidenceTracingHelper::class.java)

        fun currentTraceParent(): String? {
            if (Context.current().get(EVIDENCE_CONTEXT) != true) return null
            val context = Span.current().spanContext
            return if (context.isValid && context.isSampled) "00-${context.traceId}-${context.spanId}-01" else null
        }
    }
}
