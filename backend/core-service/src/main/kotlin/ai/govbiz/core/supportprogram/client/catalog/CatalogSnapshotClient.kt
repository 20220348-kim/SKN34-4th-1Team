package ai.govbiz.core.supportprogram.client.catalog

import ai.govbiz.core.supportprogram.client.catalog.config.CatalogClientProperties
import ai.govbiz.core.supportprogram.client.catalog.dto.CatalogSnapshotResponse
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException.Failure
import ai.govbiz.core.supportprogram.client.catalog.mapper.CatalogSnapshotMapper
import ai.govbiz.core.supportprogram.domain.CatalogProjectionSnapshot
import java.io.IOException
import org.springframework.beans.factory.annotation.Qualifier
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.client.RestClient
import org.springframework.web.client.RestClientException
import tools.jackson.databind.ObjectMapper
import tools.jackson.databind.DeserializationFeature

/** 네트워크 수신을 DB transaction 전에 끝내며, 실패 시 로컬 원장을 대체하지 않습니다. */
@Component
@ConditionalOnProperty(prefix = "app.catalog.projection", name = ["enabled"], havingValue = "true")
class CatalogSnapshotClient(
    @param:Qualifier("catalogRestClient") private val client: RestClient,
    private val properties: CatalogClientProperties,
    private val objectMapper: ObjectMapper,
) {
    fun fetch(sourceCode: String): CatalogProjectionSnapshot {
        require(sourceCode in CatalogClientProperties.SUPPORTED_SOURCES)
        try {
            return requireNotNull(client.get().uri("/internal/v1/catalog/snapshots/{sourceCode}", sourceCode)
                .headers { it.setBearerAuth(properties.internalToken) }
                .exchange { _, response ->
                    if (response.statusCode.value() in setOf(401, 403)) throw CatalogServiceCallException(Failure.AUTHENTICATION)
                    if (!response.statusCode.is2xxSuccessful) throw CatalogServiceCallException(Failure.UNAVAILABLE)
                    if (response.headers.contentType?.isCompatibleWith(MediaType.APPLICATION_JSON) != true ||
                        response.headers.contentLength > MAX_RESPONSE_BYTES
                    ) throw CatalogServiceCallException(Failure.INVALID_RESPONSE)
                    val bytes = response.body.readNBytes(MAX_RESPONSE_BYTES + 1)
                    if (bytes.size > MAX_RESPONSE_BYTES) throw CatalogServiceCallException(Failure.INVALID_RESPONSE)
                    val snapshot = try {
                        objectMapper.readerFor(CatalogSnapshotResponse::class.java)
                            .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                            .with(DeserializationFeature.FAIL_ON_MISSING_CREATOR_PROPERTIES)
                            .with(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
                            .readValue<CatalogSnapshotResponse>(bytes)
                    } catch (_: RuntimeException) {
                        throw CatalogServiceCallException(Failure.INVALID_RESPONSE)
                    }
                    if (snapshot.schemaVersion != 1 || snapshot.status.sourceCode != sourceCode ||
                        snapshot.programs.size > 20_000
                    ) throw CatalogServiceCallException(Failure.INVALID_RESPONSE)
                    try {
                        CatalogSnapshotMapper.toDomain(snapshot)
                    } catch (_: IllegalArgumentException) {
                        throw CatalogServiceCallException(Failure.INVALID_RESPONSE)
                    }
                })
        } catch (exception: CatalogServiceCallException) {
            throw exception
        } catch (_: RestClientException) {
            throw CatalogServiceCallException(Failure.UNAVAILABLE)
        } catch (_: IOException) {
            throw CatalogServiceCallException(Failure.UNAVAILABLE)
        }
    }

    companion object {
        const val MAX_RESPONSE_BYTES = 64 * 1024 * 1024
    }
}
