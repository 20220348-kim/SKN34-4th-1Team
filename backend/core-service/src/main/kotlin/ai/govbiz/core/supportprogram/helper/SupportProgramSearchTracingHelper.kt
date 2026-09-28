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

/** 검색 단계의 본문 없는 span과 내부 AI HTTP 요청의 부모 문맥만 관리한다. */
class SupportProgramSearchTracingHelper(
    private val tracer: Tracer = OpenTelemetry.noop().getTracer("govbiz-search"),
    private val environment: String = "development",
    private val release: String = "",
) {
    fun <T> observe(stage: String, action: () -> T): T {
        val builder = tracer.spanBuilder("search.$stage")
        if (stage == "total") builder.setNoParent()
        val span = builder.startSpan()
        span.setAttribute("langfuse.trace.name", "support-program-search")
        span.setAttribute("langfuse.environment", environment)
        if (release.isNotEmpty()) span.setAttribute("langfuse.release", release)
        val scope = Context.current().with(span).with(SEARCH_CONTEXT, true).makeCurrent()
        try {
            return action().also { span.setAttribute("langfuse.observation.metadata.outcome", "completed") }
        } catch (error: Throwable) {
            val outcome = if (error is AiServiceCallException && error.failure == AiServiceFailure.TIMEOUT) "timeout" else "failed"
            // 원문 예외·질문·기업 조건·본문은 전송하지 않는다.
            span.setStatus(StatusCode.ERROR)
            span.setAttribute("langfuse.observation.level", "ERROR")
            span.setAttribute("langfuse.observation.status_message", outcome)
            span.setAttribute("langfuse.observation.metadata.outcome", outcome)
            throw error
        } finally {
            if (stage == "total" && span.isRecording) {
                logger.info("support_program_search trace_id={}", span.spanContext.traceId)
            }
            scope.close()
            span.end()
        }
    }

    fun recordSelection(candidateIds: List<String>, selectedIds: List<String>) {
        val span = Span.current()
        span.setAttribute("langfuse.observation.metadata.candidate_ids", candidateIds.take(20).joinToString(","))
        span.setAttribute("langfuse.observation.metadata.selected_ids", selectedIds.take(20).joinToString(","))
        span.setAttribute("langfuse.observation.metadata.candidate_count", candidateIds.size.toLong())
        span.setAttribute("langfuse.observation.metadata.selected_count", selectedIds.size.toLong())
    }

    companion object {
        private val SEARCH_CONTEXT = ContextKey.named<Boolean>("govbiz-search")
        private val logger = LoggerFactory.getLogger(SupportProgramSearchTracingHelper::class.java)

        fun currentTraceParent(): String? {
            if (Context.current().get(SEARCH_CONTEXT) != true) return null
            val context = Span.current().spanContext
            return if (context.isValid && context.isSampled) "00-${context.traceId}-${context.spanId}-01" else null
        }
    }
}
