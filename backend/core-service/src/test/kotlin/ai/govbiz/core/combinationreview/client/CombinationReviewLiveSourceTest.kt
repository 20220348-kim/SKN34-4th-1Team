package ai.govbiz.core.combinationreview.client

import ai.govbiz.core._common.helper.buildRestClient
import ai.govbiz.core.combinationreview.helper.CombinationReviewHashHelper
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoAttachmentClient
import ai.govbiz.core.supportprogram.client.bizinfo.BizInfoSourceDocumentClient
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentParser
import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException
import java.net.URI
import java.time.Duration
import org.apache.pdfbox.Loader
import org.apache.pdfbox.text.PDFTextStripper
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.springframework.web.client.RestClient

/** Opt-in official-source network smoke test. No Spring/DB/AI client or paid call. */
@Tag("live-source")
class CombinationReviewLiveSourceTest {
    @Test
    fun fetchesBothPilotNoticesThroughTheirOfficialLinksAndParsesThem() {
        val http = buildRestClient(RestClient.builder(), URI("https://www.bizinfo.go.kr"), Duration.ofSeconds(5), Duration.ofSeconds(20))
        val collector = BizInfoAttachmentClient(BizInfoSourceDocumentClient(http), http)
        val mapper = SupportProgramDocumentParser()
        var totalText = 0
        for (id in listOf("PBLN_000000000117820", "PBLN_000000000117172")) {
            val fetched = collector.collect("BIZINFO", id)
            assertTrue(fetched.programTitle.contains("창업도약패키지"))
            assertTrue(fetched.files.isNotEmpty())
            val blocks = fetched.files.flatMap { file ->
                val parsed = mapper.parse(file.bytes, file.format)
                println("LIVE_SOURCE $id ${file.format} bytes=${file.bytes.size} sha256=${CombinationReviewHashHelper.sha256(file.bytes)} blocks=${parsed.size} chars=${parsed.sumOf { it.text.length }}")
                parsed
            }
            assertTrue(blocks.any { it.text.contains("3개 유형에 중복 신청은 가능하나 1개 유형만 수행 가능") })
            assertTrue(blocks.any { it.text.contains("사업연도를 불문하고") })
            totalText += blocks.sumOf { it.text.length }
        }
        assertTrue(totalText <= 120_000)
        println("LIVE_SOURCE totalChars=$totalText paidCalls=0")
    }

    @Test
    fun fetchesAndParsesThePerformanceSharingNoticeWithRaisedAttachmentLimits() {
        val id = "PBLN_000000000126098"
        val http = buildRestClient(RestClient.builder(), URI("https://www.bizinfo.go.kr"), Duration.ofSeconds(5), Duration.ofSeconds(60))
        val fetched = BizInfoAttachmentClient(BizInfoSourceDocumentClient(http), http)
            .collect("BIZINFO", id)
        val expectedSizes = mapOf(
            "FILE_000000000771886:1" to 216_404,
            "FILE_000000000771886:2" to 14_021_729,
            "FILE_000000000771843:2" to 3_706_081,
        )
        val actualSizes = fetched.files.associate { file ->
            val uri = URI(file.sourceUrl)
            "${parameter(uri, "atchFileId")}:${parameter(uri, "fileSn")}" to file.bytes.size
        }
        assertEquals(expectedSizes, actualSizes)
        assertEquals(17_944_214, fetched.files.sumOf { it.bytes.size })

        val mapper = SupportProgramDocumentParser()
        val failures = mutableListOf<Triple<Int, SupportProgramDocumentException.Reason, String>>()
        val parsed = fetched.files.mapNotNull { file ->
            try {
                val blocks = mapper.parse(file.bytes, file.format)
                println("LIVE_SOURCE $id ${file.fileName} ${file.format} bytes=${file.bytes.size} sha256=${CombinationReviewHashHelper.sha256(file.bytes)} blocks=${blocks.size} chars=${blocks.sumOf { it.text.length }}")
                blocks
            } catch (error: SupportProgramDocumentException) {
                val detail = if (file.format == "PDF") Loader.loadPDF(file.bytes).use { pdf ->
                    val shortTextPages = (1..pdf.numberOfPages).filter { page ->
                        PDFTextStripper().apply { startPage = page; endPage = page; sortByPosition = true }.getText(pdf).trim().length < 10
                    }
                    "pages=${pdf.numberOfPages} shortTextPages=$shortTextPages"
                } else "format=${file.format}"
                println("LIVE_SOURCE_FAILED $id ${file.fileName} bytes=${file.bytes.size} reason=${error.reason} $detail")
                failures.add(Triple(file.bytes.size, error.reason, detail))
                null
            }
        }
        assertEquals(setOf(14_021_729, 3_706_081), failures.map { it.first }.toSet())
        assertTrue(failures.all { it.second == SupportProgramDocumentException.Reason.UNSUPPORTED })
        assertTrue(failures.single { it.first == 14_021_729 }.third.contains("pages=35 shortTextPages=[1, 2, 3"))
        assertEquals("pages=1 shortTextPages=[1]", failures.single { it.first == 3_706_081 }.third)
        assertEquals(1, parsed.size)
        assertTrue(parsed.all { it.isNotEmpty() })
        println("LIVE_SOURCE $id title=${fetched.programTitle} files=${fetched.files.size} totalBytes=${fetched.files.sumOf { it.bytes.size }} parsedFiles=${parsed.size} failedFiles=${failures.size} totalBlocks=${parsed.sumOf { it.size }} totalChars=${parsed.flatten().sumOf { it.text.length }} paidCalls=0")
    }

    @Test
    fun keepsUsableDocumentsForNoticesThatIncludeAnImageOnlyAppendix() {
        val http = buildRestClient(RestClient.builder(), URI("https://www.bizinfo.go.kr"), Duration.ofSeconds(5), Duration.ofSeconds(30))
        val collector = BizInfoAttachmentClient(BizInfoSourceDocumentClient(http), http)
        val mapper = SupportProgramDocumentParser()
        val failures = mutableMapOf<String, MutableList<Pair<String, SupportProgramDocumentException.Reason>>>()

        for (id in listOf("PBLN_000000000126309", "PBLN_000000000126337")) {
            val fetched = collector.collect("BIZINFO", id)
            var parsedFiles = 0
            fetched.files.forEach { file ->
                try {
                    val blocks = mapper.parse(file.bytes, file.format)
                    assertTrue(blocks.isNotEmpty())
                    parsedFiles++
                } catch (error: SupportProgramDocumentException) {
                    failures.getOrPut(id) { mutableListOf() }.add(file.fileName to error.reason)
                }
            }
            assertTrue(parsedFiles > 0, "$id must retain at least one usable official document")
            println("LIVE_SOURCE $id files=${fetched.files.size} parsedFiles=$parsedFiles rejected=${failures[id].orEmpty()} paidCalls=0")
        }

        assertTrue(failures["PBLN_000000000126337"].orEmpty().any { (name, reason) ->
            name.contains("(붙임)") && reason == SupportProgramDocumentException.Reason.UNSUPPORTED
        })
    }

    private fun parameter(uri: URI, name: String): String = uri.rawQuery.orEmpty().split('&')
        .single { it.substringBefore('=') == name }.substringAfter('=')
}
