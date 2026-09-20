package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core._common.helper.buildRestClient
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.cntradenotice.CnTradeNoticeAttachmentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import ai.govbiz.core.supportprogram.client.kstartup.KStartupAttachmentClient
import ai.govbiz.core.supportprogram.client.msit.MsitAttachmentClient
import java.net.URI
import java.time.Duration
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.springframework.web.client.RestClient

/** 사용자 보고 공고의 공식 첨부 수집·파싱만 확인합니다. OpenAI를 호출하지 않습니다. */
@Tag("live-source")
class ApplicationFormDiscoveryLiveSourceTest {
    @Test
    fun reportedNoticesKeepAtLeastOneReadableOfficialDocument() {
        val http = buildRestClient(
            RestClient.builder(),
            URI("https://www.bizinfo.go.kr"),
            Duration.ofSeconds(5),
            Duration.ofSeconds(60),
        )
        val collector = BizInfoAttachmentClient(BizInfoSourceDocumentClient(http), http)
        val parser = SupportProgramDocumentParser()

        for (id in listOf("PBLN_000000000126400", "PBLN_000000000126418")) {
            val fetched = collector.collect("BIZINFO", id)
            val readable = fetched.files.mapNotNull { file ->
                try {
                    parser.parse(file.bytes, file.format)
                } catch (error: SupportProgramDocumentException) {
                    if (error.reason !in setOf(
                            SupportProgramDocumentException.Reason.UNSUPPORTED,
                            SupportProgramDocumentException.Reason.TOO_LARGE,
                        )) throw error
                    null
                }
            }
            assertTrue(readable.isNotEmpty(), "$id must keep at least one readable official PDF/HWP/HWPX")
            assertTrue(readable.flatten().all { it.locator.isNotBlank() && it.text.isNotBlank() })
        }
    }

    @Test
    fun msitNoticeKeepsItsReadableOfficialApplicationForm() {
        val id = "3186573"
        val sourceUrl = "https://www.msit.go.kr/bbs/view.do?bbsSeqNo=100&mId=311&mPid=121&nttSeqNo=$id&sCode=user"
        val http = buildRestClient(
            RestClient.builder(),
            null,
            Duration.ofSeconds(5),
            Duration.ofSeconds(60),
        )
        val fetched = MsitAttachmentClient(http).collect("MSIT", id, sourceUrl)
        val readable = fetched.files.mapNotNull { file ->
            try {
                SupportProgramDocumentParser().parse(file.bytes, file.format)
            } catch (error: SupportProgramDocumentException) {
                if (error.reason !in setOf(
                        SupportProgramDocumentException.Reason.UNSUPPORTED,
                        SupportProgramDocumentException.Reason.TOO_LARGE,
                    )) throw error
                null
            }
        }

        assertTrue(fetched.files.any { it.fileName.contains("신청") && it.format == "HWPX" })
        assertTrue(readable.isNotEmpty(), "$id must keep at least one readable official PDF/HWP/HWPX")
        assertTrue(readable.flatten().all { it.locator.isNotBlank() && it.text.isNotBlank() })
    }

    @Test
    fun kStartupNoticeKeepsItsPublicOfficialHwp() {
        val id = "177911"
        val sourceUrl = "https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?pbancSn=$id&schM=view"
        val http = buildRestClient(RestClient.builder(), null, Duration.ofSeconds(5), Duration.ofSeconds(60))
        val fetched = KStartupAttachmentClient(http).collect("KSTARTUP", id, sourceUrl)
        val readable = fetched.files.mapNotNull { file -> readable(file.bytes, file.format) }

        assertTrue(fetched.files.any { it.format == "HWP" })
        assertTrue(readable.isNotEmpty(), "$id must keep at least one readable official HWP")
    }

    @Test
    fun cnTradeNoticeResolvesItsOfficialBoardAttachmentsWithoutGuessingTheEncryptedIndex() {
        val http = buildRestClient(RestClient.builder(), null, Duration.ofSeconds(5), Duration.ofSeconds(60))
        val fetched = CnTradeNoticeAttachmentClient(http).collect(
            "CNTRADE_NOTICE",
            "3862",
            "(경기평택항만공사) 2021 글로벌 점프업 지원사업 2차 모집 안내",
            "정보 없음",
        )
        val readable = fetched.files.mapNotNull { file -> readable(file.bytes, file.format) }

        assertTrue(fetched.files.any { it.format in setOf("PDF", "HWP", "HWPX") })
        assertTrue(readable.isNotEmpty(), "3862 must keep at least one readable official attachment")
    }

    private fun readable(bytes: ByteArray, format: String) = try {
        SupportProgramDocumentParser().parse(bytes, format)
    } catch (error: SupportProgramDocumentException) {
        println("LIVE_SOURCE_FAILED format=$format bytes=${bytes.size} reason=${error.reason} cause=${error.cause?.javaClass?.name}:${error.cause?.message}")
        if (error.reason !in setOf(
                SupportProgramDocumentException.Reason.UNSUPPORTED,
                SupportProgramDocumentException.Reason.TOO_LARGE,
            )) throw error
        null
    }
}
