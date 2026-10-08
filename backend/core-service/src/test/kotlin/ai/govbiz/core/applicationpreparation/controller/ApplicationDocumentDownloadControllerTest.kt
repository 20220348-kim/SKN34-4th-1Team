package ai.govbiz.core.applicationpreparation.controller

import ai.govbiz.core.account.helper.AccountTestHelper
import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.account.domain.Account
import ai.govbiz.core.account.domain.AccountRole
import ai.govbiz.core.account.service.AccountSessionService
import ai.govbiz.core.account.service.exception.AuthenticationRequiredException
import ai.govbiz.core.account.web.AuthenticatedAccountArgumentResolver
import ai.govbiz.core.applicationpreparation.domain.ApplicationDocumentFile
import ai.govbiz.core.applicationpreparation.domain.exception.ApplicationPreparationNotFoundException
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentDownloadLinkService
import ai.govbiz.core.applicationpreparation.service.ApplicationDocumentService
import ai.govbiz.core.applicationpreparation.service.dto.ApplicationDocumentDownloadLinkResult
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentDownloadLinkException
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.Duration
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path
import org.apache.catalina.startup.Tomcat
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.mockito.Mockito.*
import org.springframework.http.ContentDisposition
import org.springframework.http.HttpHeaders
import org.springframework.boot.test.context.TestConfiguration
import org.springframework.web.context.support.AnnotationConfigWebApplicationContext
import org.springframework.web.servlet.DispatcherServlet
import org.springframework.web.servlet.config.annotation.EnableWebMvc
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders

class ApplicationDocumentDownloadControllerTest {
    private val files = mock(ApplicationDocumentService::class.java)
    private val links = mock(ApplicationDocumentDownloadLinkService::class.java)
    private val sessions = mock(AccountSessionService::class.java)
    private val account = Account(1, "owner@test.com", AccountRole.USER, null, null, LocalDateTime.of(2026, 10, 7, 12, 0))
    private val ticket = "a".repeat(43)
    private val root = "/api/v1/application-preparations/9/documents/11"
    private lateinit var mvc: MockMvc

    @BeforeEach fun setup() {
        doReturn(account).`when`(sessions).requireAccount("session-token")
        doThrow(AuthenticationRequiredException()).`when`(sessions).requireAccount(null)
        mvc = MockMvcBuilders.standaloneSetup(ApplicationDocumentController(files, links))
            .setCustomArgumentResolvers(AuthenticatedAccountArgumentResolver(sessions, AccountTestHelper.cookieHelper()))
            .setControllerAdvice(ApiExceptionHandler(), ApplicationDocumentExceptionHandler()).build()
    }

    @Test fun authenticatedPostReturnsOnlyFileScopedRelativePathAndExpiry() {
        doReturn(ApplicationDocumentDownloadLinkResult(9, 11, ticket, OffsetDateTime.parse("2026-10-07T12:02:00+09:00")))
            .`when`(links).create(account, 9, 11)
        mvc.perform(post("$root/download-link").header(HttpHeaders.AUTHORIZATION, "Bearer session-token"))
            .andExpect(status().isOk()).andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.preparationId").value(9)).andExpect(jsonPath("$.fileId").value(11))
            .andExpect(jsonPath("$.downloadPath").value("$root/download?ticket=$ticket"))
            .andExpect(jsonPath("$.expiresAt").value("2026-10-07T12:02:00+09:00"))
        verify(links).create(account, 9, 11)
        verifyNoInteractions(files)
    }

    @Test fun issuingLinkAndNormalDownloadStillRequireTheAccountSession() {
        mvc.perform(post("$root/download-link")).andExpect(status().isUnauthorized())
        mvc.perform(get("$root/download")).andExpect(status().isUnauthorized())
        verifyNoInteractions(links, files)
    }

    @Test fun otherOwnersFileCannotReceiveALink() {
        doThrow(ApplicationPreparationNotFoundException()).`when`(links).create(account, 9, 11)
        mvc.perform(post("$root/download-link").header(HttpHeaders.AUTHORIZATION, "Bearer session-token"))
            .andExpect(status().isNotFound()).andExpect(jsonPath("$.code").value("APPLICATION_PREPARATION_NOT_FOUND"))
    }

    @Test fun browserGetsExactOriginalFormatBytesAndUtf8FilenameWithoutLoginHeaders() {
        val formats = mapOf("pdf" to "application/pdf", "hwp" to "application/x-hwp", "hwpx" to "application/hwp+zip",
            "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        for ((extension, mediaType) in formats) {
            val name = "신청서-초안.$extension"
            val bytes = byteArrayOf(0, 1, 2, -1)
            doReturn(ApplicationDocumentFile(11, 1, name, mediaType, bytes)).`when`(links).download(9, 11, ticket)
            val response = mvc.perform(get("$root/download").param("ticket", ticket))
                .andExpect(status().isOk()).andExpect(content().bytes(bytes)).andExpect(content().contentType(mediaType))
                .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
                .andExpect(header().string("Referrer-Policy", "no-referrer"))
                .andExpect(header().string("X-Content-Type-Options", "nosniff")).andReturn().response
            assertEquals(name, ContentDisposition.parse(response.getHeader(HttpHeaders.CONTENT_DISPOSITION)!!).filename)
            assertEquals(bytes.size.toString(), response.getHeader(HttpHeaders.CONTENT_LENGTH))
        }
        verifyNoInteractions(sessions, files)
    }

    @Test fun headCanProbeTheAttachmentWithoutConsumingTheTicket() {
        doReturn(ApplicationDocumentFile(11, 1, "신청서.pdf", "application/pdf", byteArrayOf(1, 2)))
            .`when`(links).download(9, 11, ticket)
        mvc.perform(head("$root/download").param("ticket", ticket)).andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CONTENT_LENGTH, "2"))
            .andExpect(content().contentType("application/pdf"))
        mvc.perform(get("$root/download").param("ticket", ticket)).andExpect(status().isOk())
            .andExpect(content().bytes(byteArrayOf(1, 2)))
        verify(links, times(2)).download(9, 11, ticket)
    }

    @Test fun realHttpHeadHasNoBodyAndTheSameTicketStillDownloadsTheFile(@TempDir directory: Path) {
        val bytes = byteArrayOf(1, 2)
        doReturn(ApplicationDocumentFile(11, 1, "신청서.pdf", "application/pdf", bytes)).`when`(links).download(9, 11, ticket)
        val application = AnnotationConfigWebApplicationContext()
        application.register(DownloadHttpConfig::class.java)
        application.addBeanFactoryPostProcessor { factory ->
            factory.registerSingleton("documentController", ApplicationDocumentController(files, links))
        }
        val tomcat = Tomcat()
        tomcat.setBaseDir(directory.toString())
        tomcat.setPort(0)
        val context = tomcat.addContext("", directory.toString())
        Tomcat.addServlet(context, "download", DispatcherServlet(application)).loadOnStartup = 1
        context.addServletMappingDecoded("/", "download")
        val connector = tomcat.connector
        connector.setProperty("address", "127.0.0.1")
        try {
            tomcat.start()
            HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build().use { client ->
                val url = URI.create("http://127.0.0.1:${connector.localPort}$root/download?ticket=$ticket")
                val head = client.send(HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(5))
                    .method("HEAD", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.ofByteArray())
                assertEquals(200, head.statusCode())
                assertEquals("2", head.headers().firstValue("Content-Length").orElseThrow())
                assertArrayEquals(byteArrayOf(), head.body())
                val downloaded = client.send(HttpRequest.newBuilder(url).timeout(Duration.ofSeconds(5)).GET().build(), HttpResponse.BodyHandlers.ofByteArray())
                assertEquals(200, downloaded.statusCode())
                assertArrayEquals(bytes, downloaded.body())
                assertEquals("신청서.pdf", ContentDisposition.parse(downloaded.headers().firstValue("Content-Disposition").orElseThrow()).filename)
            }
            verify(links, times(2)).download(9, 11, ticket)
            verifyNoInteractions(sessions, files)
        } finally { tomcat.stop(); tomcat.destroy(); application.close() }
    }

    @TestConfiguration(proxyBeanMethods = false)
    @EnableWebMvc
    class DownloadHttpConfig

    @Test fun expiredOrInvalidLinkReturnsGoneAndDoesNotUseTheNormalAuthenticatedDownload() {
        doThrow(ApplicationDocumentDownloadLinkException()).`when`(links).download(9, 11, ticket)
        mvc.perform(get("$root/download").param("ticket", ticket))
            .andExpect(status().isGone()).andExpect(jsonPath("$.code").value("APPLICATION_DOCUMENT_DOWNLOAD_LINK_INVALID"))
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
        verifyNoInteractions(sessions, files)
    }

    @Test fun existingAuthenticatedBinaryDownloadStillReturnsItsFile() {
        doReturn(ApplicationDocumentFile(11, 1, "신청서.pdf", "application/pdf", byteArrayOf(4, 5)))
            .`when`(files).download(account, 9, 11)
        mvc.perform(get("$root/download").header(HttpHeaders.AUTHORIZATION, "Bearer session-token"))
            .andExpect(status().isOk()).andExpect(content().bytes(byteArrayOf(4, 5)))
        verify(files).download(account, 9, 11)
        verifyNoInteractions(links)
    }
}
