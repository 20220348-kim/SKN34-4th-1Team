package ai.govbiz.core.supportprogram.controller

import ai.govbiz.core._common.exception.ApiExceptionHandler
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramAttachmentLink
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import ai.govbiz.core.supportprogram.domain.CatalogSupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgram
import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.repository.SupportProgramRepository
import ai.govbiz.core.supportprogram.service.attachment.SupportProgramAttachmentService
import ai.govbiz.core.supportprogram.service.detail.SupportProgramDetailService
import java.io.ByteArrayInputStream
import java.io.InputStream
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.ArgumentMatchers.anyString
import org.mockito.ArgumentMatchers.eq
import org.mockito.Mockito.doAnswer
import org.mockito.Mockito.doReturn
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.ValueOperations
import org.springframework.http.HttpHeaders
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.header
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath
import org.springframework.test.web.servlet.result.MockMvcResultMatchers.status
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import tools.jackson.databind.json.JsonMapper
import tools.jackson.module.kotlin.KotlinModule

class SupportProgramAttachmentControllerTest {
    private val repository = mock(SupportProgramRepository::class.java)
    private val bizInfo = mock(BizInfoAttachmentClient::class.java)
    private val redis = mock(StringRedisTemplate::class.java)
    @Suppress("UNCHECKED_CAST")
    private val values = mock(ValueOperations::class.java) as ValueOperations<String, String>
    private val json = JsonMapper.builder().addModule(KotlinModule.Builder().build()).build()
    private val key = "support-program-attachments:v1:BIZINFO:PBLN_1"
    private val form = SupportProgramAttachmentLink("신청서 양식.hwp", "hwp", "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_1&fileSn=0")
    private val bundle = SupportProgramAttachmentLink("서식 묶음.zip", "zip", "https://www.bizinfo.go.kr/cmm/fms/fileDown.do?atchFileId=FILE_2&fileSn=1")
    private lateinit var mockMvc: MockMvc

    @BeforeEach
    fun setUp() {
        doReturn(values).`when`(redis).opsForValue()
        doReturn(program()).`when`(repository).findPresentBySourceAndProgramId("BIZINFO", "PBLN_1")
        val service = SupportProgramAttachmentService(SupportProgramDetailService(repository), bizInfo,
            mock(KStartupAttachmentClient::class.java), mock(MsitAttachmentClient::class.java),
            mock(CnTradeNoticeAttachmentClient::class.java), redis, json)
        mockMvc = MockMvcBuilders.standaloneSetup(SupportProgramAttachmentController(service))
            .setControllerAdvice(ApiExceptionHandler())
            .build()
    }

    @Test
    fun listsAttachmentsWithoutExposingOfficialUrlsAndKeepsTheListForLaterViews() {
        doReturn(listOf(form, bundle)).`when`(bizInfo).links("PBLN_1")

        val body = mockMvc.perform(get(PATH).queryParam("sourceCode", "BIZINFO").queryParam("sourceProgramId", "PBLN_1"))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CACHE_CONTROL, "no-store"))
            .andExpect(jsonPath("$.items[0].index").value(0))
            .andExpect(jsonPath("$.items[0].fileName").value("신청서 양식.hwp"))
            .andExpect(jsonPath("$.items[1].extension").value("zip"))
            .andReturn().response.getContentAsString(Charsets.UTF_8)

        assertTrue("bizinfo.go.kr" !in body)
        verify(values).set(eq(key) ?: key, eq(json.writeValueAsString(listOf(form, bundle))) ?: "",
            any(java.time.Duration::class.java) ?: java.time.Duration.ZERO)
    }

    @Test
    fun reusesTheKeptListWithoutReadingTheOfficialPageAgain() {
        doReturn(json.writeValueAsString(listOf(form))).`when`(values).get(key)

        mockMvc.perform(get(PATH).queryParam("sourceCode", "BIZINFO").queryParam("sourceProgramId", "PBLN_1"))
            .andExpect(status().isOk())
            .andExpect(jsonPath("$.items[0].fileName").value("신청서 양식.hwp"))

        verify(bizInfo, never()).links(anyString())
    }

    @Test
    fun downloadsThroughCoreWithTheKoreanFileNameReEncodedAsUtf8() {
        doReturn(json.writeValueAsString(listOf(form, bundle))).`when`(values).get(key)
        doAnswer { invocation ->
            invocation.getArgument<(Long, InputStream) -> Unit>(1)(3L, ByteArrayInputStream(byteArrayOf(1, 2, 3)))
        }.`when`(bizInfo).open(eq(bundle) ?: bundle, any() ?: { _, _ -> })

        val response = mockMvc.perform(download(1))
            .andExpect(status().isOk())
            .andExpect(header().string(HttpHeaders.CONTENT_TYPE, "application/octet-stream"))
            .andExpect(header().string("X-Content-Type-Options", "nosniff"))
            .andReturn().response

        assertTrue(response.getHeader(HttpHeaders.CONTENT_DISPOSITION)!!.contains("filename*=UTF-8''%EC%84%9C%EC%8B%9D%20%EB%AC%B6%EC%9D%8C.zip"))
        assertArrayEquals(byteArrayOf(1, 2, 3), response.contentAsByteArray)
    }

    @Test
    fun reportsUnknownFilesOversizedFilesAndUnavailableSourcesWithStableCodes() {
        doReturn(json.writeValueAsString(listOf(form))).`when`(values).get(key)
        mockMvc.perform(download(5)).andExpect(status().isNotFound())
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_ATTACHMENT_NOT_FOUND"))

        doAnswer { invocation ->
            invocation.getArgument<(Long, InputStream) -> Unit>(1)(200L * 1024 * 1024, ByteArrayInputStream(byteArrayOf()))
        }.`when`(bizInfo).open(eq(form) ?: form, any() ?: { _, _ -> })
        mockMvc.perform(download(0)).andExpect(status().`is`(413))
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_ATTACHMENT_TOO_LARGE"))

        doThrow(SupportProgramDocumentException(SupportProgramDocumentException.Reason.UNAVAILABLE))
            .`when`(bizInfo).open(eq(form) ?: form, any() ?: { _, _ -> })
        mockMvc.perform(download(0)).andExpect(status().isServiceUnavailable())
            .andExpect(jsonPath("$.code").value("SUPPORT_PROGRAM_ATTACHMENTS_UNAVAILABLE"))
    }

    private fun download(index: Int) = get("$PATH/download").queryParam("sourceCode", "BIZINFO")
        .queryParam("sourceProgramId", "PBLN_1").queryParam("index", index.toString())

    private fun program() = CatalogSupportProgram(
        program = SupportProgram(
            id = "PBLN_1",
            sourceCode = "BIZINFO",
            title = "검증 공고",
            organization = "수행기관",
            summary = "요약",
            categories = emptyList(),
            regions = emptyList(),
            targetDescription = "중소기업",
            applicationPeriod = "상시 접수",
            applicationStartDate = null,
            applicationEndDate = null,
            status = SupportProgramStatus.OPEN,
            sourceName = "기업마당",
            sourceUrl = "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1",
            matchedReasons = emptyList(),
        ),
        sortTimestamp = "2026-10-07 10:00:00",
    )

    private companion object {
        const val PATH = "/api/v1/support-programs/detail/attachments"
    }
}
