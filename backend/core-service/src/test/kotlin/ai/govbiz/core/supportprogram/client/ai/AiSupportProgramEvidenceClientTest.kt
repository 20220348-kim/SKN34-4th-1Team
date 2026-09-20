package ai.govbiz.core.supportprogram.client.ai

import ai.govbiz.core._common.exception.AiServiceCallException
import ai.govbiz.core._common.exception.AiServiceFailure
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerChunkRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceAnswerRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceChunkReferenceRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceChunkRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceIndexRequest
import ai.govbiz.core.supportprogram.client.ai.dto.AiSupportProgramEvidenceSearchRequest
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

class AiSupportProgramEvidenceClientTest {
    private lateinit var client: AiSupportProgramEvidenceClient
    private lateinit var semanticServer: MockRestServiceServer
    private lateinit var answerServer: MockRestServiceServer
    private val chunkId = "a".repeat(64)
    private val hash = "b".repeat(64)
    private val chunk = AiSupportProgramEvidenceChunkRequest(
        id = chunkId,
        contentHash = hash,
        documentId = "BIZINFO:PBLN_TEST",
        order = 0,
        text = "공식 원문 청크",
    )

    @BeforeEach
    fun setUp() {
        val semanticBuilder = RestClient.builder().baseUrl("http://semantic.test")
        val answerBuilder = RestClient.builder().baseUrl("http://answer.test")
        semanticServer = MockRestServiceServer.bindTo(semanticBuilder).build()
        answerServer = MockRestServiceServer.bindTo(answerBuilder).build()
        client = AiSupportProgramEvidenceClient(semanticBuilder.build(), answerBuilder.build())
    }

    @AfterEach
    fun verifyRequests() {
        semanticServer.verify()
        answerServer.verify()
    }

    @Test
    fun sendsExactEvidenceIndexSearchAndAnswerContracts() {
        semanticServer.expect(requestTo("http://semantic.test/internal/v1/support-program-evidence/chunks"))
            .andExpect(method(HttpMethod.PUT))
            .andExpect(content().json("""{"chunks":[{"id":"$chunkId","contentHash":"$hash","documentId":"BIZINFO:PBLN_TEST","order":0,"text":"공식 원문 청크"}]}"""))
            .andRespond(withSuccess("""{"indexedCount":1}""", MediaType.APPLICATION_JSON))
        semanticServer.expect(requestTo("http://semantic.test/internal/v1/support-program-evidence/search"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""{"question":"신청 방법","eligibleChunks":[{"id":"$chunkId","contentHash":"$hash","documentId":"BIZINFO:PBLN_TEST","order":0}],"limit":1}"""))
            .andRespond(withSuccess("""{"question":"신청 방법","matches":[{"id":"$chunkId","contentHash":"$hash","documentId":"BIZINFO:PBLN_TEST","order":0,"score":0.9}]}""", MediaType.APPLICATION_JSON))
        answerServer.expect(requestTo("http://answer.test/internal/v1/support-program-evidence/answers"))
            .andExpect(method(HttpMethod.POST))
            .andExpect(content().json("""{"question":"신청 방법","chunks":[{"id":"$chunkId","documentId":"BIZINFO:PBLN_TEST","order":0,"text":"공식 원문 청크"}]}"""))
            .andRespond(withSuccess("""{"answer":"온라인입니다.","answerStatus":"ANSWERED","citationChunkIds":["$chunkId"]}""", MediaType.APPLICATION_JSON))

        assertEquals(1, client.indexChunks(AiSupportProgramEvidenceIndexRequest(listOf(chunk))).indexedCount)
        assertEquals(
            0.9,
            client.searchChunks(
                AiSupportProgramEvidenceSearchRequest(
                    "신청 방법",
                    listOf(AiSupportProgramEvidenceChunkReferenceRequest(chunkId, hash, "BIZINFO:PBLN_TEST", 0)),
                    1,
                ),
            ).matches?.single()?.score,
        )
        assertEquals(
            "ANSWERED",
            client.answer(
                AiSupportProgramEvidenceAnswerRequest(
                    "신청 방법",
                    listOf(AiSupportProgramEvidenceAnswerChunkRequest(chunkId, "BIZINFO:PBLN_TEST", 0, "공식 원문 청크")),
                ),
            ).answerStatus,
        )
    }

    @Test
    fun classifiesEvidenceServiceFailuresWithTheExistingAiProblemContract() {
        semanticServer.expect(requestTo("http://semantic.test/internal/v1/support-program-evidence/search"))
            .andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))

        val exception = assertThrows(AiServiceCallException::class.java) {
            client.searchChunks(
                AiSupportProgramEvidenceSearchRequest(
                    "질문",
                    listOf(AiSupportProgramEvidenceChunkReferenceRequest(chunkId, hash, "BIZINFO:PBLN_TEST", 0)),
                    1,
                ),
            )
        }

        assertEquals(AiServiceFailure.UNAVAILABLE, exception.failure)
    }
}
