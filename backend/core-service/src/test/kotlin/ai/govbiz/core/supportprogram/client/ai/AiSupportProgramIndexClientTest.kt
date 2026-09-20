package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexBatchRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexDocumentRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexPruneRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexReferenceRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramIndexSearchRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.http.HttpMethod
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withStatus
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient

class AiSupportProgramIndexClientTest {
    private lateinit var client: AiSupportProgramIndexClient
    private lateinit var server: MockRestServiceServer
    private val hash = "a".repeat(64)
    private val reference = AiSupportProgramIndexReferenceRequest("BIZINFO:one", hash)
    private val search = AiSupportProgramIndexSearchRequest("서울 AI", listOf(reference), 20)

    @BeforeEach
    fun setUp() {
        val builder = RestClient.builder().baseUrl("http://ai-service.test")
        server = MockRestServiceServer.bindTo(builder).build()
        client = AiSupportProgramIndexClient(builder.build())
    }

    @AfterEach
    fun verifyRequests() = server.verify()

    @Test
    fun sendsExactBatchPruneAndSearchContractsWithSourceAndContentVersion() {
        server.expect(requestTo("http://ai-service.test/internal/v1/support-program-index/batch"))
            .andExpect(method(HttpMethod.PUT))
            .andExpect(content().json("""{"documents":[{"id":"BIZINFO:one","contentHash":"$hash","text":"제목: 서울 AI"}]}"""))
            .andRespond(withSuccess("""{"indexedCount":1}""", MediaType.APPLICATION_JSON))
        server.expect(requestTo("http://ai-service.test/internal/v1/support-program-index/prune"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""{"sourceCode":"BIZINFO","documents":[{"id":"BIZINFO:one","contentHash":"$hash"}]}"""))
            .andRespond(withSuccess("""{"retainedCount":1}""", MediaType.APPLICATION_JSON))
        server.expect(requestTo("http://ai-service.test/internal/v1/support-program-index/search"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""{"query":"서울 AI","eligibleDocuments":[{"id":"BIZINFO:one","contentHash":"$hash"}],"limit":20}"""))
            .andRespond(withSuccess("""{"query":"서울 AI","matches":[{"id":"BIZINFO:one","contentHash":"$hash","score":0.91}]}""", MediaType.APPLICATION_JSON))

        assertEquals(1, client.indexBatch(AiSupportProgramIndexBatchRequest(listOf(AiSupportProgramIndexDocumentRequest("BIZINFO:one", hash, "제목: 서울 AI")))).indexedCount)
        assertEquals(1, client.prune(AiSupportProgramIndexPruneRequest("BIZINFO", listOf(reference))).retainedCount)
        assertEquals(0.91, client.search(search).matches?.single()?.score)
    }

    @Test
    fun classifiesIncompleteIndexAndTransportStatusFailures() {
        for ((status, failure) in listOf(
            HttpStatus.NO_CONTENT to AiServiceFailure.INVALID_RESPONSE,
            HttpStatus.SERVICE_UNAVAILABLE to AiServiceFailure.UNAVAILABLE,
            HttpStatus.GATEWAY_TIMEOUT to AiServiceFailure.TIMEOUT,
            HttpStatus.BAD_GATEWAY to AiServiceFailure.UPSTREAM_ERROR,
        )) {
            server.reset()
            server.expect(requestTo("http://ai-service.test/internal/v1/support-program-index/search"))
                .andRespond(withStatus(status))
            val exception = assertThrows(AiServiceCallException::class.java) { client.search(search) }
            assertEquals(failure, exception.failure)
            server.verify()
        }
    }

    @Test
    fun malformedJsonIsAnExplicitInvalidResponse() {
        server.expect(requestTo("http://ai-service.test/internal/v1/support-program-index/search"))
            .andRespond(withSuccess("{bad", MediaType.APPLICATION_JSON))
        val exception = assertThrows(AiServiceCallException::class.java) { client.search(search) }
        assertEquals(AiServiceFailure.INVALID_RESPONSE, exception.failure)
    }
}
