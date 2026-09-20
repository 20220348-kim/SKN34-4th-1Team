package ai.govbiz.core.supportprogram.client.catalog

import ai.govbiz.core.supportprogram.client.catalog.config.CatalogClientProperties
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException
import ai.govbiz.core.supportprogram.client.catalog.exception.CatalogServiceCallException.Failure
import java.net.URI
import java.net.SocketTimeoutException
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.springframework.http.HttpHeaders
import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.test.web.client.MockRestServiceServer
import org.springframework.test.web.client.match.MockRestRequestMatchers.*
import org.springframework.test.web.client.response.MockRestResponseCreators.*
import org.springframework.web.client.RestClient
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class CatalogSnapshotClientTest {
    private val token = "catalog-test-only-token-not-for-production-0001"
    private val properties = CatalogClientProperties(URI("http://catalog.test"), token)
    private val builder = RestClient.builder().baseUrl(properties.baseUrl.toString())
    private val server = MockRestServiceServer.bindTo(builder).build()
    private val mapper = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val client = CatalogSnapshotClient(builder.build(), properties, mapper)

    @AfterEach
    fun verifyRequests() = server.verify()

    @Test
    fun readsVersionedSnapshotUsingServerCredentialAndNotUserCredential() {
        server.expect(requestTo("http://catalog.test/internal/v1/catalog/snapshots/BIZINFO"))
            .andExpect(header(HttpHeaders.AUTHORIZATION, "Bearer $token"))
            .andRespond(withSuccess(snapshot(), MediaType.APPLICATION_JSON))
        val actual = client.fetch("BIZINFO")
        assertEquals(7L, actual.revision)
        assertEquals(3L, actual.status.publishedGeneration)
        assertTrue(actual.programs.isEmpty())
    }

    @Test
    fun rejectsAuthenticationErrorsWithoutLeakingRemoteBodyOrToken() {
        server.expect(anything()).andRespond(withStatus(HttpStatus.UNAUTHORIZED).body("sensitive $token"))
        val error = assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }
        assertEquals(Failure.AUTHENTICATION, error.failure)
        assertFalse(error.toString().contains(token))
        assertNull(error.cause)
    }

    @Test
    fun mapsExplicitWireProgramAndRejectsUnknownStatus() {
        val program = """{"program":{"id":"한글-1","sourceCode":"KSTARTUP","title":"창업 지원","organization":"기관",
          "summary":"본문","categories":["사업화"],"regions":["전국"],"targetDescription":"창업기업",
          "applicationPeriod":"상시","applicationStartDate":null,"applicationEndDate":null,
          "status":"UNKNOWN","sourceName":"K-Startup","sourceUrl":"https://www.k-startup.go.kr/"},
          "sortTimestamp":"2026-09-19","startupDetails":{"startupStages":["초기"],"applicantTypes":["기업"],"founderAges":[]}}"""
        val body = snapshot().replace("BIZINFO", "KSTARTUP")
            .replace("\"programs\":[]", "\"programs\":[$program]")
            .replace("\"publishedProgramCount\":0", "\"publishedProgramCount\":1")
        server.expect(anything()).andRespond(withSuccess(body, MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(body.replace("\"status\":\"UNKNOWN\"", "\"status\":\"UNSUPPORTED\""), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(body.replace(",\"applicationEndDate\":null", ""), MediaType.APPLICATION_JSON))
        val item = client.fetch("KSTARTUP").programs.single()
        assertEquals("KSTARTUP:한글-1", item.program.sourceQualifiedId)
        assertEquals(listOf("초기"), item.startupDetails?.startupStages)
        assertTrue(item.program.matchedReasons.isEmpty())
        repeat(2) {
            assertEquals(Failure.INVALID_RESPONSE,
                assertThrows(CatalogServiceCallException::class.java) { client.fetch("KSTARTUP") }.failure)
        }
    }

    @Test
    fun rejectsMissingNullableFieldsAndNullPrimitiveInsteadOfSilentlyReplacingWithDefaults() {
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("\"lastFailedSyncAt\":null,", ""), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("\"indexReady\":true", "\"indexReady\":null"), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("\"indexReady\":true,", ""), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("\"publishedProgramCount\":0,", ""), MediaType.APPLICATION_JSON))
        repeat(4) {
            assertEquals(Failure.INVALID_RESPONSE,
                assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }.failure)
        }
    }

    @Test
    fun rejectsUnsupportedVersionAndWrongSourceWithoutAcceptingAnEmptyFallback() {
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("\"schemaVersion\":1", "\"schemaVersion\":2"), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(snapshot().replace("BIZINFO", "MSIT"), MediaType.APPLICATION_JSON))
        repeat(2) {
            assertEquals(Failure.INVALID_RESPONSE,
                assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }.failure)
        }
    }

    @Test
    fun rejectsPartialJsonAndNonJsonResponse() {
        server.expect(anything()).andRespond(withSuccess(snapshot().dropLast(8), MediaType.APPLICATION_JSON))
        server.expect(anything()).andRespond(withSuccess(snapshot(), MediaType.TEXT_HTML))
        server.expect(anything()).andRespond(withSuccess(snapshot() + " {}", MediaType.APPLICATION_JSON))
        repeat(3) {
            assertEquals(Failure.INVALID_RESPONSE,
                assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }.failure)
        }
    }

    @Test
    fun rejectsOversizedDeclaredBodyBeforeReading() {
        server.expect(anything()).andRespond(withSuccess(snapshot(), MediaType.APPLICATION_JSON)
            .header(HttpHeaders.CONTENT_LENGTH, (CatalogSnapshotClient.MAX_RESPONSE_BYTES.toLong() + 1).toString()))
        assertEquals(Failure.INVALID_RESPONSE,
            assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }.failure)
    }

    @Test
    fun surfacesTimeoutAndUnpublishedSnapshotAsUnavailable() {
        server.expect(anything()).andRespond(withException(SocketTimeoutException("do not expose details")))
        server.expect(anything()).andRespond(withStatus(HttpStatus.SERVICE_UNAVAILABLE))
        repeat(2) {
            assertEquals(Failure.UNAVAILABLE,
                assertThrows(CatalogServiceCallException::class.java) { client.fetch("BIZINFO") }.failure)
        }
    }

    @Test
    fun rejectsUntrustedPathAndUnsafeSettingsBeforeAnyRequest() {
        assertThrows(IllegalArgumentException::class.java) { client.fetch("../accounts") }
        listOf("http://user:password@catalog.test", "http://catalog.test/path", "file:///tmp/catalog").forEach {
            assertThrows(IllegalArgumentException::class.java) { CatalogClientProperties(URI(it), token) }
        }
        assertThrows(IllegalArgumentException::class.java) { CatalogClientProperties(URI("http://catalog.test"), "short") }
        assertThrows(IllegalArgumentException::class.java) { CatalogClientProperties(URI("http://catalog.test"), "$token\r\n") }
        assertThrows(IllegalArgumentException::class.java) { CatalogClientProperties(URI("http://catalog.test"), "한".repeat(40)) }
        assertThrows(IllegalArgumentException::class.java) { CatalogClientProperties(URI("http://catalog.test"), "a".repeat(1025)) }
        assertThrows(IllegalArgumentException::class.java) {
            CatalogClientProperties(URI("http://catalog.test"), token, sources = listOf("BIZINFO", "BIZINFO"))
        }
    }

    private fun snapshot() = """
        {"schemaVersion":1,"catalogId":"30a5d246-39ca-40ed-a6ac-9354315111e0","revision":7,
         "status":{"sourceCode":"BIZINFO","publishedGeneration":3,
         "publishedCatalogFingerprint":"${"a".repeat(64)}","publishedProgramCount":0,"indexReady":true,
         "lastSuccessfulSyncAt":"2026-09-19T09:00:00","lastFailedSyncAt":null,"lastSyncOutcome":"SUCCESS"},
         "programs":[]}
    """.trimIndent()
}
