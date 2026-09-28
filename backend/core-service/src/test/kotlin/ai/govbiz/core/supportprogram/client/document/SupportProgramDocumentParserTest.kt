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
    fun readsXlsxVisibleCellsSharedStringsAndInlineLabelsWithoutHiddenData() {
        fun workbook(unsafe: Boolean = false): ByteArray = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                val ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
                mapOf(
                    "[Content_Types].xml" to """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>""",
                    "xl/workbook.xml" to """<workbook xmlns="$ns" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="지원 신청서" sheetId="1" r:id="rId1"/><sheet name="내부 계산" sheetId="2" state="veryHidden" r:id="rId2"/></sheets></workbook>""",
                    "xl/_rels/workbook.xml.rels" to """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>""",
                    "xl/sharedStrings.xml" to """<sst xmlns="$ns"><si><t>기업명과 대표자명, 사업자등록번호, 신청금액, 담당자 연락처 및 이메일을 정확히 작성해 주세요.</t></si></sst>""",
                    "xl/worksheets/sheet1.xml" to ((if (unsafe) """<!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>""" else "") +
                        """<worksheet xmlns="$ns"><cols><col min="3" max="3" hidden="1"/></cols><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"/><c r="C1" t="inlineStr"><is><t>숨긴 비밀</t></is></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>숨긴 행</t></is></c></row><row r="3"><c r="A3"><f>SUM(B1:B2)</f><v>100</v></c></row></sheetData></worksheet>"""),
                    "xl/worksheets/sheet2.xml" to """<worksheet xmlns="$ns"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>내부 비밀</t></is></c></row></sheetData></worksheet>""",
                ).forEach { (name, value) ->
                    zip.putNextEntry(ZipEntry(name)); zip.write(value.toByteArray(Charsets.UTF_8)); zip.closeEntry()
                }
            }
        }.toByteArray()
        val blocks = mapper.parse(workbook(), "XLSX")
        assertTrue(blocks.first().locator.startsWith("XLSX sheet 지원 신청서 row 1"))
        assertTrue(blocks.first().text.contains("A1: 기업명"))
        assertFalse(blocks.first().text.contains("B1: [빈 셀"))
        assertFalse(blocks.joinToString { it.text }.contains("비밀"))
        assertFalse(blocks.joinToString { it.text }.contains("숨긴 행"))
        assertTrue(blocks.last().text.contains("수식 셀: 자동 입력 불가"))
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            mapper.parse(workbook(true), "XLSX")
        }.reason)
    }
    @Test
    fun ignoresLargeFormattedBlankRangeWhileKeepingMeaningfulXlsxCells() {
        val ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
        val sheetData = buildString {
            append("<row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>신청 기업명과 담당자 연락처, 지원 필요성 및 사업 계획을 정확히 작성해 주세요. 신청기관의 주소와 대표자 정보도 함께 작성해 주세요.</t></is></c></row>")
            for (row in 2..500) {
                append("<row r=\"$row\">")
                for (column in 'A'..'K') append("<c r=\"$column$row\" s=\"1\"/>")
                append("</row>")
            }
        }
        val workbook = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                mapOf(
                    "[Content_Types].xml" to """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>""",
                    "xl/workbook.xml" to """<workbook xmlns="$ns" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="신청서" sheetId="1" r:id="rId1"/></sheets></workbook>""",
                    "xl/_rels/workbook.xml.rels" to """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>""",
                    "xl/worksheets/sheet1.xml" to """<worksheet xmlns="$ns"><dimension ref="A1:K500"/><sheetData>$sheetData</sheetData></worksheet>""",
                ).forEach { (name, value) -> zip.putNextEntry(ZipEntry(name)); zip.write(value.toByteArray()); zip.closeEntry() }
            }
        }.toByteArray()
        val blocks = mapper.parse(workbook, "XLSX")
        assertEquals(1, blocks.size)
        assertTrue(blocks.single().text.contains("신청 기업명"))
        assertFalse(blocks.single().text.contains("빈 셀"))
    }
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
    fun readsDocxParagraphsAndRejectsExternalEntities() {
        val contentTypes = """<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"""
        val paragraph = "신청기업의 상호와 대표자명, 사업자등록번호, 주소, 연락처를 작성해 주세요. ".repeat(2).trim()
        val xml = """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>$paragraph</w:t></w:r></w:p></w:body></w:document>"""
        fun archive(document: String) = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                zip.putNextEntry(ZipEntry("[Content_Types].xml"))
                zip.write(contentTypes.toByteArray())
                zip.closeEntry()
                zip.putNextEntry(ZipEntry("word/document.xml"))
                zip.write(document.toByteArray())
                zip.closeEntry()
            }
        }.toByteArray()
        val blocks = mapper.parse(archive(xml), "DOCX")
        assertEquals(paragraph, blocks.single().text)
        assertEquals("DOCX paragraphs 1-1", blocks.single().locator)
        val malicious = """<!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>$xml"""
        assertEquals(Reason.INVALID, assertThrows(SupportProgramDocumentException::class.java) {
            mapper.parse(archive(malicious), "DOCX")
        }.reason)
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
