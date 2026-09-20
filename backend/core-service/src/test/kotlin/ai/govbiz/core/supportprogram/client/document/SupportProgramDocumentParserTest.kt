package ai.govbiz.core.supportprogram.client.document

import ai.govbiz.core.supportprogram.client.document.SupportProgramDocumentException.Reason
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.poi.hpsf.PropertySetFactory
import org.apache.poi.poifs.filesystem.POIFSFileSystem
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class SupportProgramDocumentParserTest {
    private val mapper = SupportProgramDocumentParser()
    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/combinationreview/$name")).use { it.readBytes() }

    @Test
    fun readsBothOfficialHwpxDocumentsIncludingFootnotesAndAppendices() {
        for (name in listOf("general.hwpx", "deeptech.hwpx")) {
            val blocks = mapper.parse(resource(name), "HWPX")
            val text = blocks.joinToString("\n") { it.text }
            assertTrue(text.contains("3개 유형에 중복 신청은 가능하나 1개 유형만 수행 가능"))
            assertTrue(text.contains("최초 ‘협약체결확약서’"))
            assertTrue(text.contains("글로벌기업 협업 프로그램"))
            assertTrue(text.contains("사업연도를 불문하고"))
            assertTrue(blocks.all { it.text.length <= 3000 && it.locator.startsWith("HWPX section0") })
        }
    }

    @Test
    fun readsOfficialPdfWithRealPageLocators() {
        val blocks = mapper.parse(resource("deeptech.pdf"), "PDF")
        assertTrue(blocks.any { it.locator.startsWith("PDF page 1 ") && it.text.contains("동시수행 불가") })
        assertTrue(blocks.any { it.locator.startsWith("PDF page 18 ") && it.text.contains("지원 제외사업") })
        assertTrue(blocks.any { it.locator.startsWith("PDF page 24 ") })
    }

    @Test
    fun refusesScannedOrBlankPdfInsteadOfSilentlyLosingAPage() {
        val bytes = PDDocument().use { pdf ->
            pdf.addPage(PDPage())
            ByteArrayOutputStream().also { pdf.save(it) }.toByteArray()
        }
        assertEquals(Reason.UNSUPPORTED, assertThrows(SupportProgramDocumentException::class.java) { mapper.parse(bytes, "PDF") }.reason)
    }

    @Test
    fun readsHwpFiveParagraphsAndRejectsInvalidHwp() {
        val first = "첫 번째 신청 문항을 구체적으로 작성해 주세요. ".repeat(2).trim()
        val second = "두 번째 신청 문항에는 지원 필요성을 작성해 주세요. ".repeat(2).trim()
        val blocks = mapper.parse(hwp(first, second), "HWP")
        assertEquals(listOf("HWP paragraphs 1-2"), blocks.map { it.locator })
        assertEquals("$first\n$second", blocks.single().text)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) { mapper.parse(byteArrayOf(1), "HWP") }.reason)
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) { mapper.parse("html error page".toByteArray(), "PDF") }.reason)
    }

    @Test
    fun rejectsExternalXmlEntities() {
        val xml = """<?xml version="1.0"?><!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>"""
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) { mapper.parse(zip("Contents/section0.xml", xml.toByteArray()), "HWPX") }.reason)
    }

    @Test
    fun keepsSupplementaryUnicodeCharactersWholeAtBlockBoundaries() {
        val text = "가".repeat(2999) + "🚀끝"
        val xml = """<root xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>$text</hp:t></hp:run></hp:p></root>"""
        val blocks = mapper.parse(zip("Contents/section0.xml", xml.toByteArray(Charsets.UTF_8)), "HWPX")
        assertEquals(text, blocks.joinToString("") { it.text })
        assertTrue(blocks.none { Character.isHighSurrogate(it.text.last()) || Character.isLowSurrogate(it.text.first()) })
    }

    @Test
    fun rejectsArchiveExpansionAndRawSizeOverflow() {
        assertEquals(Reason.TOO_LARGE, assertThrows(SupportProgramDocumentException::class.java) {
            mapper.parse(zip("Contents/section0.xml", ByteArray(25 * 1024 * 1024) { 65 }), "HWPX")
        }.reason)
        assertEquals(Reason.TOO_LARGE, assertThrows(SupportProgramDocumentException::class.java) {
            mapper.parse(ByteArray(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1), "PDF")
        }.reason)
    }

    @Test
    fun acceptsExactRawFileBoundaryAndRejectsOneByteOver() {
        val xml = """<root xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:t>${"정상 본문".repeat(20)}</hp:t></hp:run></hp:p></root>"""
        val valid = zip("Contents/section0.xml", xml.toByteArray(Charsets.UTF_8))
        val blocks = mapper.parse(valid.copyOf(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES), "HWPX")
        assertTrue(blocks.joinToString("\n") { it.text }.contains("정상 본문"))
        assertEquals(Reason.TOO_LARGE, assertThrows(SupportProgramDocumentException::class.java) {
            mapper.parse(valid.copyOf(MAX_SUPPORT_PROGRAM_ATTACHMENT_BYTES + 1), "HWPX")
        }.reason)
    }

    private fun zip(name: String, bytes: ByteArray): ByteArray = ByteArrayOutputStream().also { output ->
        ZipOutputStream(output).use { it.putNextEntry(ZipEntry(name)); it.write(bytes); it.closeEntry() }
    }.toByteArray()

    @Test
    fun preservesHwpCheckboxCaptionWithItsQuestionContext() {
        val blocks = mapper.parse(hwp("신청 안내를 읽고 해당하는 분야 하나를 선택하여 참가신청서를 작성합니다.", "아이디어 분야 택1", caption = "디지털 테크"), "HWP")
        val control = blocks.single { it.locator.contains("form controls") }
        assertTrue(control.text.contains("아이디어 분야 택1"))
        assertTrue(control.text.contains("디지털 테크"))
        assertFalse(control.text.contains("Value:int"))
    }

    private fun hwp(vararg paragraphs: String, caption: String? = null): ByteArray = ByteArrayOutputStream().also { output ->
        POIFSFileSystem().use { fileSystem ->
            val header = ByteArray(256)
            "HWP Document File".toByteArray(Charsets.US_ASCII).copyInto(header)
            fileSystem.root.createDocument("FileHeader", ByteArrayInputStream(header))

            val summary = ByteArrayOutputStream().also { PropertySetFactory.newSummaryInformation().write(it) }.toByteArray()
            fileSystem.root.createDocument("\u0005HwpSummaryInformation", ByteArrayInputStream(summary))

            val section = ByteArrayOutputStream()
            paragraphs.forEach { paragraph ->
                val text = paragraph.toByteArray(Charsets.UTF_16LE)
                val recordHeader = 0x43 or (text.size shl 20)
                section.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(recordHeader).array())
                section.write(text)
            }
            if (caption != null) {
                val text = "Caption:wstring:${caption.length}:$caption Value:int:0".toByteArray(Charsets.UTF_16LE)
                section.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(91 or (text.size shl 20)).array())
                section.write(text)
            }
            fileSystem.root.createDirectory("BodyText")
                .createDocument("Section0", ByteArrayInputStream(section.toByteArray()))
            fileSystem.writeFilesystem(output)
        }
    }.toByteArray()
}
