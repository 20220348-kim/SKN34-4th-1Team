package ai.govbiz.core.assistant.helper

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import io.opentelemetry.api.OpenTelemetry
import io.opentelemetry.api.trace.Span
import io.opentelemetry.api.trace.StatusCode
import io.opentelemetry.api.trace.Tracer
import io.opentelemetry.context.Context
import io.opentelemetry.context.ContextKey
import org.slf4j.LoggerFactory

/** 도우미 요청마다 독립된 trace를 만들고 내부 AI 호출에만 부모 문맥을 전달한다. */
class AssistantTracingHelper(
    private val tracer: Tracer = OpenTelemetry.noop().getTracer("govbiz-assistant"),
    private val environment: String = "development",
    private val release: String = "",
) {
    fun <T> observe(stage: String, action: () -> T): T {
        val builder = tracer.spanBuilder("assistant.$stage")
        if (stage == "total") builder.setNoParent()
        val span = builder.startSpan()
        span.setAttribute("langfuse.trace.name", "assistant-agent")
        span.setAttribute("langfuse.environment", environment)
        if (release.isNotEmpty()) span.setAttribute("langfuse.release", release)
        val scope = Context.current().with(span).with(ASSISTANT_CONTEXT, true).makeCurrent()
        try {
            return action().also { span.setAttribute("langfuse.observation.metadata.outcome", "completed") }
        } catch (error: Throwable) {
            val outcome = if (error is AiServiceCallException && error.failure == AiServiceFailure.TIMEOUT) "timeout" else "failed"
            // 예외 메시지·질문·계정·문서·도구 토큰을 span이나 event에 기록하지 않는다.
            span.setStatus(StatusCode.ERROR)
            span.setAttribute("langfuse.observation.level", "ERROR")
            span.setAttribute("langfuse.observation.status_message", outcome)
            span.setAttribute("langfuse.observation.metadata.outcome", outcome)
            throw error
        } finally {
            if (stage == "total" && span.isRecording) logger.info("assistant_request trace_id={}", span.spanContext.traceId)
            scope.close()
            span.end()
        }
    }

    companion object {
        private val ASSISTANT_CONTEXT = ContextKey.named<Boolean>("govbiz-assistant")
        private val logger = LoggerFactory.getLogger(AssistantTracingHelper::class.java)

        fun currentTraceParent(): String? {
            if (Context.current().get(ASSISTANT_CONTEXT) != true) return null
            val context = Span.current().spanContext
            return if (context.isValid && context.isSampled) "00-${context.traceId}-${context.spanId}-01" else null
        }
    }
}
