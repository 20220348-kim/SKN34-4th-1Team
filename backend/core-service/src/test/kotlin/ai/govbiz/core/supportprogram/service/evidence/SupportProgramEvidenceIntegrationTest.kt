package ai.govbiz.core.supportprogram.service.evidence

import ai.govbiz.core._common.test.MySqlTestContainerConfig
import ai.govbiz.core.supportprogram.client.bizinfo.mapper.BizInfoSourceDocumentMapper
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.helper.SupportProgramContentHashHelper
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.context.annotation.Import
import org.springframework.http.HttpMethod
import org.springframework.http.MediaType
import org.springframework.http.client.BufferingClientHttpRequestFactory
import org.springframework.http.client.JdkClientHttpRequestFactory
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.test.context.bean.override.convention.TestBean
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.content
import org.springframework.test.web.client.match.MockRestRequestMatchers.method
import org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo
import org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess
import org.springframework.web.client.RestClient
import tools.jackson.databind.JsonNode
import tools.jackson.databind.json.JsonMapper

/** Real Core HTTP and MySQL; external transports are fixtures unless BOTH live-run variables are explicit. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = [
        "app.account.jwt-secret=test-jwt-secret-0123456789abcdef0123456789",
        "app.bizinfo.sync.enabled=false",
        "app.support-program-index.enabled=false",
        "app.ai-service.base-url=http://127.0.0.1:1",
        "app.support-program-request.per-client-per-minute=100",
    ],
)
@Import(MySqlTestContainerConfig::class)
class SupportProgramEvidenceIntegrationTest {
    @Autowired private lateinit var repository: SupportProgramRepository
    @Autowired private lateinit var jdbc: JdbcTemplate
    @LocalServerPort private var port: Int = 0

    @TestBean(name = "bizInfoSourceDocumentRestClient", methodName = "sourceClient", enforceOverride = true)
    private lateinit var sourceRestClient: RestClient

    @TestBean(name = "aiSemanticSearchRestClient", methodName = "aiClient", enforceOverride = true)
    private lateinit var semanticRestClient: RestClient

    @TestBean(name = "aiServiceRestClient", methodName = "aiClient", enforceOverride = true)
    private lateinit var answerRestClient: RestClient

    @BeforeEach
    fun resetOnlyTheTestContainerAndHttpExpectations() {
        jdbc.update("DELETE FROM support_program_source_document")
        jdbc.update("DELETE FROM support_program")
        sourceServer.reset()
        aiServer?.reset()
        synchronized(aiCalls) { aiCalls.clear() }
        assertEquals(2, fixture["documents"].size())
        assertEquals(6, fixture["documents"].sumOf { it["cases"].size() })
        fixture["documents"].forEach { document ->
            assertEquals(document["htmlSha256"].asString(), SupportProgramContentHashHelper.sha256(html(document)))
        }
    }

    @AfterEach
    fun verifyExternalRequests() {
        sourceServer.verify()
        aiServer?.verify()
    }

    @Test
    fun runsSixFixedOfficialQuestionsThroughThePublicHttpApi() {
        val output = liveOutput?.let { Files.createDirectory(it).resolve("capture.json") }
            ?: Path.of("build/reports/evidence-flow/capture.json").also { Files.createDirectories(it.parent) }
        val observations = mutableListOf<MutableMap<String, Any?>>()
        val capture = linkedMapOf<String, Any?>(
            "schemaVersion" to "official-evidence-flow-capture-v1",
            "scope" to "core-http-mysql-frozen-html-ai-evidence-flow",
            "aiTransport" to if (liveUrl == null) "http-fixture" else "explicit-local-ai-http",
            "officialSourceTransport" to "frozen-official-html-fragments",
            "fixtureSha256" to SupportProgramContentHashHelper.sha256(resource("official-sources.json")),
            "fixture" to fixture,
            "startedAt" to Instant.now().toString(),
            "expectedCaseCount" to 6,
            "completed" to false,
            "cases" to observations,
        )
        fun save() { Files.writeString(output, json.writerWithDefaultPrettyPrinter().writeValueAsString(capture) + "\n") }
        save() // Validate the fresh output location before any optional AI HTTP request.
        try {
            fixture["documents"].forEach { document ->
                repository.upsert(CatalogSupportProgram(program(document), ""))
                expectSource(document)
                if (liveUrl == null) document["cases"].forEach { expectAi(document, it) }
            }
            fixture["documents"].forEach { document ->
                document["cases"].forEach { case ->
                    val before = callsSnapshot().size
                    val request = request(document, case["question"].asString())
                    val observation = linkedMapOf<String, Any?>(
                        "id" to case["id"].asString(), "publicRequest" to request,
                        "expectedStatus" to case["expectedStatus"].asString(), "startedAt" to Instant.now().toString(),
                    )
                    observations += observation
                    try {
                        val response = post(request)
                        val body = json.readTree(response.body())
                        observation["publicStatus"] = response.statusCode()
                        observation["publicResponse"] = body
                        val stored = repository.findPresentSourceDocument("BIZINFO", document["sourceProgramId"].asString())
                        observation["sourceDocument"] = stored?.let {
                            mapOf("sourceCode" to it.sourceCode, "sourceProgramId" to it.sourceProgramId,
                                "sourceUrl" to it.sourceUrl, "content" to it.content, "contentHash" to it.contentHash,
                                "fetchedAt" to it.fetchedAt.toString())
                        }
                        assertEquals(200, response.statusCode(), "Stop after the first failed public request")
                        val current = requireNotNull(stored)
                        assertEquals(SupportProgramContentHashHelper.sha256(current.content), current.contentHash)
                        assertFalse(current.content.contains("해시태그 목록"))
                        val chunks = SupportProgramEvidenceChunker.chunk(current)
                        body["citations"].forEach { citation ->
                            assertEquals(current.sourceUrl, citation["sourceUrl"].asString())
                            assertEquals(chunks[citation["chunkOrder"].asInt()].text, citation["excerpt"].asString())
                        }
                        if (liveUrl == null) {
                            assertEquals(case["expectedStatus"].asString(), body["answerStatus"].asString())
                            if (case["expectedStatus"].asString() == "ANSWERED") {
                                assertTrue(body["citations"].any { it["excerpt"].asString().contains(case["evidenceText"].asString()) })
                            } else assertEquals(0, body["citations"].size())
                        }
                    } catch (failure: Throwable) {
                        observation["failureType"] = failure.javaClass.simpleName
                        throw failure
                    } finally {
                        observation["aiCalls"] = callsSnapshot().drop(before)
                        observation["finishedAt"] = Instant.now().toString()
                        save()
                    }
                }
            }
            assertEquals(18, callsSnapshot().size)
            assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM support_program_source_document", Int::class.java))
            // Each source is fetched exactly once despite three questions: MockRestServiceServer verifies the cache reuse.
            sourceServer.verify()
            aiServer?.verify()
            capture["completed"] = true
        } catch (failure: Throwable) {
            capture["failureType"] = failure.javaClass.simpleName
            throw failure
        } finally {
            capture["finishedAt"] = Instant.now().toString()
            save()
        }
    }

    @Test
    fun refusesAnEvidenceSearchResultFromAnotherDocumentAtThePublicBoundary() {
        assumeTrue(liveUrl == null, "Failure injection is only for the offline HTTP fixture")
        val document = fixture["documents"][0]
        repository.upsert(CatalogSupportProgram(program(document), ""))
        expectSource(document)
        expectAi(document, document["cases"][0], corruptDocument = true)

        val response = post(request(document, document["cases"][0]["question"].asString()))

        assertEquals(502, response.statusCode())
        assertEquals("AI_SERVICE_INVALID_RESPONSE", json.readTree(response.body())["code"].asString())
        assertEquals(2, callsSnapshot().size) // No answer request follows invalid retrieval.
    }

    @Test
    fun refusesAnotherProgramsHtmlWithoutStoringOrSendingItsTextToAi() {
        assumeTrue(liveUrl == null, "Failure injection is only for the offline HTTP fixture")
        val document = fixture["documents"][0]
        repository.upsert(CatalogSupportProgram(program(document), ""))
        sourceServer.expect(requestTo(document["sourceUrl"].asString()))
            .andRespond(withSuccess(html(fixture["documents"][1]), MediaType.TEXT_HTML))

        val response = post(request(document, "지원 대상은 누구인가요?"))

        assertEquals(503, response.statusCode())
        assertEquals("SUPPORT_PROGRAM_EVIDENCE_UNAVAILABLE", json.readTree(response.body())["code"].asString())
        assertNull(repository.findPresentSourceDocument("BIZINFO", document["sourceProgramId"].asString()))
        assertTrue(callsSnapshot().isEmpty())
    }

    @Test
    fun refusesANonPresentProgramBeforeAnySourceOrAiRequest() {
        assumeTrue(liveUrl == null, "Failure injection is only for the offline HTTP fixture")
        val response = post(request(fixture["documents"][0], "지원 대상은 누구인가요?"))

        assertEquals(404, response.statusCode())
        assertTrue(callsSnapshot().isEmpty())
    }

    private fun expectSource(document: JsonNode) {
        sourceServer.expect(requestTo(document["sourceUrl"].asString()))
            .andExpect(method(HttpMethod.GET))
            .andRespond(withSuccess(html(document), MediaType.TEXT_HTML))
    }

    private fun expectAi(document: JsonNode, case: JsonNode, corruptDocument: Boolean = false) {
        val chunks = SupportProgramEvidenceChunker.chunk(
            BizInfoSourceDocumentMapper.fromHtml(program(document), html(document), LocalDateTime.of(2026, 9, 7, 0, 13)),
        )
        val chunkInputs = chunks.map { mapOf("id" to it.id, "contentHash" to it.contentHash,
            "documentId" to it.documentId, "order" to it.order, "text" to it.text) }
        val references = chunkInputs.map { it - "text" }
        val selected = chunks.take(5)
        val question = case["question"].asString()
        val matches = selected.mapIndexed { index, chunk -> mapOf("id" to chunk.id, "contentHash" to chunk.contentHash,
            "documentId" to if (corruptDocument) "OTHER:${document["sourceProgramId"].asString()}" else chunk.documentId,
            "order" to chunk.order, "score" to 0.9 - index * 0.1) }
        expectAiCall(HttpMethod.PUT, "chunks", mapOf("chunks" to chunkInputs), mapOf("indexedCount" to chunks.size))
        expectAiCall(HttpMethod.POST, "search", mapOf("question" to question, "eligibleChunks" to references,
            "limit" to minOf(5, chunks.size)), mapOf("question" to question, "matches" to matches))
        if (corruptDocument) return
        val citationIds = if (case["expectedStatus"].asString() == "ANSWERED") {
            listOf(selected.first { it.text.contains(case["evidenceText"].asString()) }.id)
        } else emptyList()
        expectAiCall(HttpMethod.POST, "answers", mapOf("question" to question,
            "chunks" to chunkInputs.take(5).map { it - "contentHash" }),
            mapOf("answer" to case["stubAnswer"].asString(), "answerStatus" to case["expectedStatus"].asString(),
                "citationChunkIds" to citationIds))
    }

    private fun expectAiCall(method: HttpMethod, operation: String, request: Any, response: Any) {
        requireNotNull(aiServer).expect(requestTo("http://ai-evidence.test/internal/v1/support-program-evidence/$operation"))
            .andExpect(method(method))
            .andExpect(content().json(json.writeValueAsString(request)))
            .andRespond(withSuccess(json.writeValueAsString(response), MediaType.APPLICATION_JSON))
    }

    private fun request(document: JsonNode, question: String): Map<String, String> = mapOf(
        "sourceCode" to "BIZINFO", "sourceProgramId" to document["sourceProgramId"].asString(), "question" to question,
    )

    private fun post(request: Any): HttpResponse<String> = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(2)).version(HttpClient.Version.HTTP_1_1).build().use { client ->
            client.send(HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/v1/support-programs/detail/answers"))
                .timeout(Duration.ofSeconds(180)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(request))).build(),
                HttpResponse.BodyHandlers.ofString())
        }

    private fun program(document: JsonNode) = SupportProgram(
        id = document["sourceProgramId"].asString(), sourceCode = "BIZINFO", title = document["title"].asString(),
        organization = "", summary = "", categories = emptyList(), regions = emptyList(), targetDescription = "",
        applicationPeriod = "", applicationStartDate = null, applicationEndDate = null, status = SupportProgramStatus.UNKNOWN,
        sourceName = "기업마당", sourceUrl = document["sourceUrl"].asString(), matchedReasons = emptyList(),
    )

    private fun html(document: JsonNode): String = resource(document["htmlFile"].asString())

    companion object {
        private val json = JsonMapper.builder().build()
        private val fixture = json.readTree(resource("official-sources.json"))
        private val liveUrl = System.getenv("GOVBIZ_EVIDENCE_FLOW_AI_URL")?.let { raw ->
            URI(raw).also { uri ->
                require(uri.scheme == "http" && uri.host in setOf("127.0.0.1", "[::1]") && uri.port in 1..65535 &&
                    uri.rawPath.orEmpty() in setOf("", "/") && uri.rawQuery == null && uri.rawFragment == null && uri.userInfo == null) {
                    "GOVBIZ_EVIDENCE_FLOW_AI_URL must be an explicit literal loopback HTTP origin"
                }
            }
        }
        private val liveOutput = System.getenv("GOVBIZ_EVIDENCE_FLOW_CAPTURE_DIR")?.let { Path.of(it).toAbsolutePath().normalize() }
        init {
            require((liveUrl == null) == (liveOutput == null)) { "Both live AI URL and a fresh capture directory are required" }
            require(liveOutput == null || !Files.exists(liveOutput)) { "Live capture directory must not already exist" }
        }
        private val aiCalls = mutableListOf<Map<String, Any?>>()
        private val sourceBuilder = RestClient.builder()
        private val sourceServer = MockRestServiceServer.bindTo(sourceBuilder).build()
        private val aiBuilder = RestClient.builder().baseUrl(liveUrl?.toString() ?: "http://ai-evidence.test").also { builder ->
            if (liveUrl != null) {
                val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2))
                    .version(HttpClient.Version.HTTP_1_1).followRedirects(HttpClient.Redirect.NEVER).build()
                builder.requestFactory(BufferingClientHttpRequestFactory(JdkClientHttpRequestFactory(client).apply {
                    setReadTimeout(Duration.ofSeconds(60))
                }))
            }
            builder.requestInterceptor { request, body, execution ->
                check(callsSnapshot().size < 18) { "Fixed flow permits at most 18 internal AI HTTP operations" }
                val record = linkedMapOf<String, Any?>("operation" to request.uri.path.substringAfterLast('/'),
                    "method" to request.method.name(), "request" to json.readTree(body))
                try {
                    val response = execution.execute(request, body)
                    record["status"] = response.statusCode.value()
                    record["response"] = json.readTree(response.body.readAllBytes())
                    response
                } catch (failure: Throwable) {
                    record["failureType"] = failure.javaClass.simpleName
                    throw failure
                } finally { synchronized(aiCalls) { aiCalls += record } }
            }
        }
        // Buffer the mocked response as well: the recorder must not consume the response needed by production Client.
        private val aiServer = if (liveUrl == null) MockRestServiceServer.bindTo(aiBuilder).bufferContent().build() else null

        @JvmStatic fun sourceClient(): RestClient = sourceBuilder.build()
        @JvmStatic fun aiClient(): RestClient = aiBuilder.build()

        private fun resource(name: String): String = requireNotNull(
            SupportProgramEvidenceIntegrationTest::class.java.getResourceAsStream("/support-program-evidence/$name"),
        ).bufferedReader(Charsets.UTF_8).use { it.readText() }

        private fun callsSnapshot(): List<Map<String, Any?>> = synchronized(aiCalls) { aiCalls.toList() }
    }
}
