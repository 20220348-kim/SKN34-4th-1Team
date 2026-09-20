package ai.govbiz.core.supportprogram.client.ai.mapper

import ai.govbiz.core.supportprogram.domain.SupportProgramStatus
import ai.govbiz.core.supportprogram.domain.SupportProgramStartupDetails
import ai.govbiz.core.supportprogram.helper.SupportProgramTestHelper.catalogProgram
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.HexFormat
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SupportProgramIndexDocumentMapperTest {
    @Test
    fun preservesTheExactExistingBizinfoTextAndHashWithoutAddingMetadataLines() {
        val candidate = catalogProgram("legacy")
        val expected = "제목: legacy 지원사업\n기관: 수행기관\n지원대상: 중소기업\n" +
            "분야: AI, 기술\n지역: 서울\n신청기간: 상시 접수\n내용: 서울 AI 기업 기술 지원"
        val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        assertEquals(expected, document.text)
        assertEquals(
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(expected.toByteArray(StandardCharsets.UTF_8))),
            document.contentHash,
        )
        assertEquals(document, SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = SupportProgramStartupDetails(listOf("예비창업자"), listOf("일반인"), listOf("만 40세 이상")),
        )))
    }

    @Test
    fun appendsStartupClassificationsAfterOriginalContentWithoutChangingTheCandidate() {
        val base = catalogProgram("179197")
        val candidate = base.copy(
            program = base.program.copy(sourceCode = "KSTARTUP", targetDescription = "원문 신청 조건"),
            startupDetails = SupportProgramStartupDetails(listOf("예비창업자", "3년미만"), listOf("일반인"), listOf("만 40세 이상")),
        )
        val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        val original = SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(startupDetails = null))
        assertEquals("KSTARTUP:179197", document.id)
        assertEquals(original.text + "\n검색용 분류 메타데이터 (신청 자격 근거 아님)\n" +
            "창업 업력 분류: 예비창업자, 3년미만\n대상 분류: 일반인\n대표자 연령 분류: 만 40세 이상", document.text)
        assertEquals("원문 신청 조건", candidate.program.targetDescription)
        assertNotEquals(original.contentHash, document.contentHash)
        assertNotEquals(document.contentHash, SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = candidate.startupDetails!!.copy(startupStages = listOf("7년미만")),
        )).contentHash)
        assertNotEquals(document.contentHash, SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = candidate.startupDetails!!.copy(applicantTypes = listOf("일반기업")),
        )).contentHash)
        assertNotEquals(document.contentHash, SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = candidate.startupDetails!!.copy(founderAges = listOf("만 20세 미만")),
        )).contentHash)
    }

    @Test
    fun doesNotAppendEmptyStartupClassificationsOrDisplaceLongOriginalText() {
        val base = catalogProgram("179197", "🙂".repeat(15_000))
        val candidate = base.copy(program = base.program.copy(sourceCode = "KSTARTUP"))
        val original = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        assertEquals(original, SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = SupportProgramStartupDetails(emptyList(), emptyList(), emptyList()),
        )))
        val withTags = SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(
            startupDetails = SupportProgramStartupDetails(listOf("예비창업자"), emptyList(), emptyList()),
        ))
        assertEquals(original, withTags)
        assertEquals(12_000, withTags.text.codePointCount(0, withTags.text.length))
        assertFalse(withTags.text.last().isHighSurrogate())
    }

    @Test
    fun createsAStableSourceIdentityAndHashOfTheExactUtf8Text() {
        val candidate = catalogProgram("PBLN:한글")
        val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        assertEquals("BIZINFO:PBLN:한글", document.id)
        assertEquals(
            HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(document.text.toByteArray(StandardCharsets.UTF_8))),
            document.contentHash,
        )
        assertTrue(document.text.contains("제목: PBLN:한글 지원사업"))
        assertTrue(document.text.contains("분야: AI, 기술"))
        assertTrue(document.text.contains("지역: 서울"))
        assertEquals(document, SupportProgramIndexDocumentMapper.fromCatalog(candidate))
        assertNotEquals(
            document.contentHash,
            SupportProgramIndexDocumentMapper.fromCatalog(candidate.copy(program = candidate.program.copy(summary = "변경된 지원내용"))).contentHash,
        )
    }

    @Test
    fun distinguishesProgramsWithTheSameRawIdFromDifferentSources() {
        val bizInfo = catalogProgram("SHARED")
        val other = bizInfo.copy(
            program = bizInfo.program.copy(
                sourceCode = "OTHER",
                sourceName = "다른 제공처",
                sourceUrl = "https://other.example/program/SHARED",
            ),
        )

        val bizInfoDocument = SupportProgramIndexDocumentMapper.fromCatalog(bizInfo)
        val otherDocument = SupportProgramIndexDocumentMapper.fromCatalog(other)

        assertEquals("BIZINFO:SHARED", bizInfoDocument.id)
        assertEquals("OTHER:SHARED", otherDocument.id)
        assertNotEquals(bizInfoDocument.id, otherDocument.id)
    }

    @Test
    fun doesNotReembedWhenOnlyTodaysDerivedStatusOrSortTimestampChanges() {
        val candidate = catalogProgram("one")
        val changed = candidate.copy(program = candidate.program.copy(status = SupportProgramStatus.CLOSED), sortTimestamp = "newer")
        assertEquals(SupportProgramIndexDocumentMapper.fromCatalog(candidate), SupportProgramIndexDocumentMapper.fromCatalog(changed))
    }

    @Test
    fun normalizesUnsupportedControlAndFormatCharactersBeforeHashing() {
        val candidate = catalogProgram("one", "AI\u0000지원\u200b사업\n다음\t줄")
        val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        assertTrue(document.text.endsWith("내용: AI 지원 사업\n다음\t줄"))
        assertFalse(document.text.contains('\u0000'))
        assertFalse(document.text.contains('\u200b'))
    }

    @Test
    fun truncatesTextWithoutBreakingUnicodeSurrogatePairs() {
        val candidate = catalogProgram("one", "🙂".repeat(15_000))
        val document = SupportProgramIndexDocumentMapper.fromCatalog(candidate)
        assertEquals(12_000, document.text.codePointCount(0, document.text.length))
        assertFalse(document.text.last().isHighSurrogate())
        assertTrue(document.text.endsWith("🙂"))
    }
}
