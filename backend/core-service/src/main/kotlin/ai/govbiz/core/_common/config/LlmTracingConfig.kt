package ai.govbiz.core._common.config

import ai.govbiz.core.assistant.helper.AssistantTracingHelper
import ai.govbiz.core.supportprogram.helper.SupportProgramSearchTracingHelper
import io.opentelemetry.exporter.otlp.http.trace.OtlpHttpSpanExporter
import io.opentelemetry.sdk.trace.SdkTracerProvider
import io.opentelemetry.sdk.trace.export.BatchSpanProcessor
import io.opentelemetry.sdk.trace.samplers.Sampler
import java.net.URI
import java.time.Duration
import java.util.Base64
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.env.Environment

@Configuration(proxyBeanMethods = false)
class LlmTracingConfig {
    @Bean(destroyMethod = "close")
    fun llmTracerProvider(environment: Environment): SdkTracerProvider {
        val enabled = environment.getProperty("LANGFUSE_ENABLED", "false")
        require(enabled in setOf("true", "false")) { "LANGFUSE_ENABLED must be true or false" }
        val builder = SdkTracerProvider.builder()
        if (enabled == "false") return builder.setSampler(Sampler.alwaysOff()).build()
        val baseUrl = environment.getProperty("LANGFUSE_BASE_URL", "")
        val uri = try { URI(baseUrl) } catch (_: Exception) {
            throw IllegalArgumentException("Invalid LANGFUSE_BASE_URL")
        }
        require(uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank() && uri.userInfo == null &&
            uri.query == null && uri.fragment == null && uri.path in setOf("", "/")) { "Invalid LANGFUSE_BASE_URL" }
        val publicKey = environment.getProperty("LANGFUSE_PUBLIC_KEY", "")
        val secretKey = environment.getProperty("LANGFUSE_SECRET_KEY", "")
        require(publicKey.isNotBlank() && secretKey.isNotBlank()) { "Enabled Langfuse requires both keys" }
        val credentials = Base64.getEncoder().encodeToString("$publicKey:$secretKey".toByteArray(Charsets.UTF_8))
        val exporter = OtlpHttpSpanExporter.builder()
            .setEndpoint("${baseUrl.trimEnd('/')}/api/public/otel/v1/traces")
            .addHeader("Authorization", "Basic $credentials")
            .addHeader("x-langfuse-ingestion-version", "4")
            .setTimeout(Duration.ofSeconds(2))
            .build()
        return builder.addSpanProcessor(BatchSpanProcessor.builder(exporter)
            .setMaxQueueSize(1024).setMaxExportBatchSize(64)
            .setScheduleDelay(Duration.ofSeconds(1)).setExporterTimeout(Duration.ofSeconds(2)).build()).build()
    }

    @Bean
    fun supportProgramSearchTracingHelper(llmTracerProvider: SdkTracerProvider, environment: Environment): SupportProgramSearchTracingHelper {
        val deployment = environment.getProperty("LANGFUSE_ENVIRONMENT", "development")
        val release = environment.getProperty("GIT_SHA", "")
        require(deployment.matches(Regex("[a-z0-9][a-z0-9_-]{0,39}"))) { "Invalid LANGFUSE_ENVIRONMENT" }
        require(release.isEmpty() || release.matches(Regex("[0-9a-f]{7,40}"))) { "Invalid GIT_SHA" }
        return SupportProgramSearchTracingHelper(llmTracerProvider.get("govbiz-search"), deployment, release)
    }

    @Bean
    fun assistantTracingHelper(llmTracerProvider: SdkTracerProvider, environment: Environment): AssistantTracingHelper {
        val deployment = environment.getProperty("LANGFUSE_ENVIRONMENT", "development")
        val release = environment.getProperty("GIT_SHA", "")
        require(deployment.matches(Regex("[a-z0-9][a-z0-9_-]{0,39}"))) { "Invalid LANGFUSE_ENVIRONMENT" }
        require(release.isEmpty() || release.matches(Regex("[0-9a-f]{7,40}"))) { "Invalid GIT_SHA" }
        return AssistantTracingHelper(llmTracerProvider.get("govbiz-assistant"), deployment, release)
    }
}
