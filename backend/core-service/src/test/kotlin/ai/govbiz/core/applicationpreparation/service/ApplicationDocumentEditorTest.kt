package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import kr.dogfoot.hwplib.tool.blankfilemaker.BlankFileMaker
import kr.dogfoot.hwplib.reader.HWPReader
import kr.dogfoot.hwplib.writer.HWPWriter
import org.apache.pdfbox.Loader
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField
import org.apache.pdfbox.rendering.PDFRenderer
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import java.util.zip.ZipEntry

class ApplicationDocumentEditorTest {
    private val editor = ApplicationDocumentEditor()
    private val facts = listOf(ApplicationDocumentFact("company:name", "업체명", "새봄 & 연구소"))

    @Test
    fun reusesPdfFieldAndAllowsEditingSavingAndReopeningKorean() {
        val original = PDDocument().use { doc ->
            doc.addPage(PDPage())
            ByteArrayOutputStream().also { doc.save(it) }.toByteArray()
        }
        val first = editor.fill(original, "PDF", facts, listOf(ApplicationDocumentPlacement("company:name", "page-0", ApplicationDocumentBox(.1f, .1f, .7f, .15f))))
        val inspection = editor.inspect(first, "PDF")
        val target = inspection.targets.single()
        assertTrue(target.id.startsWith("pdf-field:"))
        val changedFacts = listOf(ApplicationDocumentFact("company:name", "업체명", "수정한 가상기업"))
        val second = editor.fill(first, "PDF", changedFacts, listOf(ApplicationDocumentPlacement("company:name", target.id)))
        Loader.loadPDF(second).use { doc ->
            assertEquals(1, doc.documentCatalog.acroForm.fields.size)
            val field = doc.documentCatalog.acroForm.fields.single() as PDTextField
            assertEquals("수정한 가상기업", field.value)
            field.value = "다운로드 후 다시 수정"
            val saved = ByteArrayOutputStream().also { doc.save(it) }.toByteArray()
            Loader.loadPDF(saved).use { reopened ->
                val editable = reopened.documentCatalog.acroForm.fields.single() as PDTextField
                assertEquals("다운로드 후 다시 수정", editable.value)
                assertNotNull(editable.widgets[0].appearance.normalAppearance)
                assertNotNull(PDFRenderer(reopened).renderImage(0))
            }
        }
    }

    @Test
    fun rejectsPdfOverflowWithoutPublishingAnIntermediateFile() {
        val original = PDDocument().use { doc -> doc.addPage(PDPage()); ByteArrayOutputStream().also { doc.save(it) }.toByteArray() }
        val error = assertThrows(ApplicationDocumentException::class.java) {
            editor.fill(original, "PDF", facts, listOf(ApplicationDocumentPlacement("company:name", "page-0", ApplicationDocumentBox(.1f, .1f, .01f, .01f))))
        }
        assertEquals("APPLICATION_DOCUMENT_OVERFLOW", error.code)
        Loader.loadPDF(original).use { assertNull(it.documentCatalog.acroForm) }
    }

    @Test
    fun fillsHwpAndReopensAsAnEditableHwpWithOriginalParagraphs() {
        val file = BlankFileMaker.make()
        val paragraph = file.bodyText.sectionList[0].addNewParagraph()
        paragraph.createText(); paragraph.text.addString("업체명:")
        paragraph.createCharShape(); paragraph.charShape.addParaCharShape(0, 0)
        val original = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        val target = editor.inspect(original, "HWP").targets.single { it.text == "업체명:" }
        val filled = editor.fill(original, "HWP", facts, listOf(ApplicationDocumentPlacement("company:name", target.id)))
        assertArrayEquals(original.take(8).toByteArray(), filled.take(8).toByteArray())
        val reopened = HWPReader.fromInputStream(filled.inputStream())
        assertEquals("업체명: 새봄 & 연구소", reopened.bodyText.sectionList[0].getParagraph(1).normalString)
        assertEquals(file.docInfo.paraShapeList.size, reopened.docInfo.paraShapeList.size)
    }

    @Test
    fun fillsOfficialHwpxWithoutChangingOtherZipEntriesAndRetainsOriginalText() {
        val original = requireNotNull(javaClass.getResourceAsStream("/combinationreview/general.hwpx")).readBytes()
        val targets = editor.inspect(original, "HWPX").targets
        val target = targets.first { it.text.isBlank() }
        val filled = editor.fill(original, "HWPX", facts, listOf(ApplicationDocumentPlacement("company:name", target.id)))
        val originalEntries = entries(original)
        val filledEntries = entries(filled)
        assertEquals(originalEntries.keys, filledEntries.keys)
        originalEntries.filterKeys { !it.startsWith("Contents/section") && it != "Contents/header.xml" }.forEach { (name, data) -> assertArrayEquals(data, filledEntries[name], name) }
        val newTargets = editor.inspect(filled, "HWPX").targets
        assertEquals("새봄 & 연구소", newTargets.single { it.id == target.id }.text)
        targets.filter { it.id != target.id }.forEach { old -> assertEquals(old.text, newTargets.single { it.id == old.id }.text) }
    }

    @Test
    fun removesOnlySelectedBlueHwpExamplesAndWritesBlackAnswers() {
        val file = BlankFileMaker.make()
        val blue = file.docInfo.charShapeList[0].clone().also { it.charColor.value = 0xff0000L }
        val blueId = file.docInfo.charShapeList.size.toLong()
        file.docInfo.charShapeList.add(blue)
        fun paragraph(text: String, start: Long) = file.bodyText.sectionList[0].addNewParagraph().apply {
            createText(); this.text.addString(text)
            createCharShape(); charShape.addParaCharShape(0, 0); charShape.addParaCharShape(start, blueId)
        }
        paragraph("업체명: 예시 회사", 5)
        paragraph("파란 제목", 0)
        paragraph("차별화 전략 등에 대하여 작성", 0)
        val original = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        val target = editor.inspect(original, "HWP").targets.single { it.text.startsWith("업체명:") }
        assertEquals("예시 회사", target.exampleText)
        val placement = listOf(ApplicationDocumentPlacement("company:name", target.id))
        assertThrows(ApplicationDocumentException::class.java) { editor.fill(original, "HWP", facts, placement) }
        val unanswered = editor.inspect(original, "HWP").targets.single { it.text == "차별화 전략 등에 대하여 작성" }
        val result = editor.fill(original, "HWP", facts, placement, listOf(target.id, unanswered.id))
        assertTrue(editor.inspect(result, "HWP").targets.single { it.id == unanswered.id }.text.isBlank())
        val reopened = HWPReader.fromInputStream(result.inputStream())
        val filled = reopened.bodyText.sectionList[0].getParagraph(1)
        assertEquals("업체명: 새봄 & 연구소", filled.normalString)
        assertTrue(editor.inspect(result, "HWP").targets.single { it.id == target.id }.exampleText.isEmpty())
        assertEquals("파란 제목", editor.inspect(result, "HWP").targets.single { it.text == "파란 제목" }.exampleText)
        val answerStyle = filled.charShape.positonShapeIdPairList.last().shapeId.toInt()
        assertEquals(0L, reopened.docInfo.charShapeList[answerStyle].charColor.value)
    }

    @Test
    fun replacesHwpxExampleRunsPreservingBlackLabelsBlueTitlesAndOtherEntries() {
        val header = """<hh:head xmlns:hh="urn:header"><hh:charProperties itemCnt="2"><hh:charPr id="0" textColor="#000000"/><hh:charPr id="1" textColor="#0000FF"/></hh:charProperties></hh:head>"""
        val section = """<hp:sec xmlns:hp="urn:paragraph"><hp:p><hp:run charPrIDRef="0"><hp:t>업체명:</hp:t></hp:run><hp:run charPrIDRef="1"><hp:t>예시 회사</hp:t></hp:run><hp:linesegarray/></hp:p><hp:p><hp:run charPrIDRef="1"><hp:t>파란 제목</hp:t></hp:run></hp:p><hp:p><hp:run charPrIDRef="1"><hp:t>구현 방법을 작성</hp:t></hp:run></hp:p></hp:sec>"""
        val original = ByteArrayOutputStream().also { out -> ZipOutputStream(out).use { zip ->
            mapOf("Contents/header.xml" to header, "Contents/section0.xml" to section, "unrelated.txt" to "preserve").forEach { (name, text) -> zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry() }
        } }.toByteArray()
        val target = editor.inspect(original, "HWPX").targets.first()
        assertEquals("예시 회사", target.exampleText)
        val placements = listOf(ApplicationDocumentPlacement("company:name", target.id))
        assertThrows(ApplicationDocumentException::class.java) { editor.fill(original, "HWPX", facts, placements) }
        val unanswered = editor.inspect(original, "HWPX").targets.last()
        val result = editor.fill(original, "HWPX", facts, placements, listOf(target.id, unanswered.id))
        val targets = editor.inspect(result, "HWPX").targets
        assertEquals("업체명: 새봄 & 연구소", targets.first().text)
        assertEquals("", targets.first().exampleText)
        assertEquals("파란 제목", targets[1].exampleText)
        assertTrue(targets.single { it.id == unanswered.id }.text.isBlank())
        assertArrayEquals(entries(original)["unrelated.txt"], entries(result)["unrelated.txt"])
        assertFalse(entries(result).getValue("Contents/section0.xml").toString(Charsets.UTF_8).contains("linesegarray"))
        assertThrows(ApplicationDocumentException::class.java) { editor.fill(result, "HWPX", facts, placements, listOf(target.id)) }
    }

    @Test
    fun fillsRealCheckboxesReplacesCountAndLaysOutLongAnswersWithoutCombiningFields() {
        val original = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val targets = editor.inspect(original, "HWP").targets
        val digital = targets.single { it.kind == "CHECKBOX" && it.text == "디지털 테크" }
        val count = targets.single { it.text.contains("____명") }
        val summary = targets.single { it.exampleText.contains("40자 내외") }
        val role = "s0-p0-t1-r10-c4-p0"
        val values = listOf(
            ApplicationDocumentFact("idea", "아이디어 분야", "디지털 테크"),
            ApplicationDocumentFact("count", "팀원 수", "3"),
            ApplicationDocumentFact("summary", "아이디어 요약", "음식점의 재고와 발주 정보를 관리하는 서비스입니다. ".repeat(5)),
            ApplicationDocumentFact("role", "역할", "서비스 기획과 매장 인터뷰를 담당합니다."),
        )
        val placements = listOf(ApplicationDocumentPlacement("idea", digital.id), ApplicationDocumentPlacement("count", count.id), ApplicationDocumentPlacement("summary", summary.id), ApplicationDocumentPlacement("role", role))
        val result = editor.fill(original, "HWP", values, placements, listOf(summary.id))
        val reread = HWPReader.fromInputStream(result.inputStream())
        val table = reread.bodyText.sectionList[0].getParagraph(0).controlList.filterIsInstance<kr.dogfoot.hwplib.`object`.bodytext.control.ControlTable>()[1]
        val countText = table.rowList[7].cellList[3].paragraphList.getParagraph(0).normalString
        assertTrue(countText.contains("3명(팀장포함)"))
        assertFalse(countText.contains("____"))
        val paragraph = table.rowList[5].cellList[1].paragraphList.getParagraph(0)
        assertTrue(paragraph.normalString.contains(values[2].value))
        assertTrue(paragraph.lineSeg.lineSegItemList.size > 1)
        assertTrue(paragraph.lineSeg.lineSegItemList.zipWithNext().all { (a, b) -> b.textStartPosition > a.textStartPosition && b.lineVerticalPosition >= a.lineVerticalPosition + a.lineHeight })
        val style = reread.docInfo.charShapeList[paragraph.charShape.positonShapeIdPairList.first().shapeId.toInt()]
        assertFalse(style.property.isItalic)
        val controls = table.rowList.slice(2..3).flatMap { it.cellList }.flatMap { it.paragraphList.toList() }.flatMap { it.controlList.orEmpty() }.filterIsInstance<kr.dogfoot.hwplib.`object`.bodytext.control.ControlForm>()
        val checked = controls.filter { control ->
            val button = control.formObject.properties.getProperty("ButtonSet") as kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertySet
            (button.getProperty("Value") as kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertyNormal).value == "1"
        }
        assertEquals(1, checked.size)
        val button = checked.single().formObject.properties.getProperty("ButtonSet") as kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertySet
        assertEquals("디지털 테크", (button.getProperty("Caption") as kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertyNormal).value)
        assertThrows(ApplicationDocumentException::class.java) {
            editor.fill(original, "HWP", values.take(2), listOf(ApplicationDocumentPlacement("idea", role), ApplicationDocumentPlacement("count", role)))
        }
    }

    @Test
    fun rejectsBlankParagraphsOutsideHwpTablesIncludingAfterExampleCleanup() {
        val file = HWPReader.fromInputStream(requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")))
        val section = file.bodyText.sectionList[0]
        val outsideIndex = section.toList().size
        section.addNewParagraph().apply {
            createText(); text.addString(" ")
            createCharShape(); charShape.addParaCharShape(0, 0)
        }
        val blueId = file.docInfo.charShapeList.size.toLong()
        file.docInfo.charShapeList.add(file.docInfo.charShapeList[0].clone().also { it.charColor.value = 0xff0000L })
        section.addNewParagraph().apply {
            createText(); text.addString("제안 배경을 작성")
            createCharShape(); charShape.addParaCharShape(0, blueId)
        }
        val original = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        val outsideId = "s0-p$outsideIndex"
        val exampleId = "s0-p${outsideIndex + 1}"
        val targets = editor.inspect(original, "HWP").targets
        assertFalse(targets.any { it.id == outsideId })
        assertTrue(targets.any { it.text.isBlank() && "-t" in it.id })
        assertThrows(ApplicationDocumentException::class.java) {
            editor.fill(original, "HWP", facts, listOf(ApplicationDocumentPlacement("company:name", outsideId)))
        }
        assertThrows(ApplicationDocumentException::class.java) {
            editor.fill(original, "HWP", facts, listOf(ApplicationDocumentPlacement("company:name", exampleId)), listOf(exampleId))
        }
        val answerCell = targets.first { it.text.isBlank() && "-t" in it.id }
        val filled = editor.fill(original, "HWP", facts, listOf(ApplicationDocumentPlacement("company:name", answerCell.id)))
        assertEquals(facts.single().value, editor.inspect(filled, "HWP").targets.single { it.id == answerCell.id }.text.trim())
        assertTrue(HWPReader.fromInputStream(filled.inputStream()).bodyText.sectionList[0].getParagraph(outsideIndex).normalString.isBlank())
    }

    @Test
    fun retainsBlankAnswerParagraphsInHwpWithoutTables() {
        val file = BlankFileMaker.make()
        file.bodyText.sectionList[0].addNewParagraph().apply {
            createText(); text.addString(" ")
            createCharShape(); charShape.addParaCharShape(0, 0)
        }
        val original = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        val target = editor.inspect(original, "HWP").targets.first { it.text.isBlank() }
        val filled = editor.fill(original, "HWP", facts, listOf(ApplicationDocumentPlacement("company:name", target.id)))
        assertEquals(facts.single().value, editor.inspect(filled, "HWP").targets.single { it.id == target.id }.text.trim())
    }

    @Test
    fun createsEditableKoreanPdfFieldsAndCanEditAndRenderThemAgain() {
        val original = PDDocument().use { doc -> doc.addPage(PDPage()); ByteArrayOutputStream().also { doc.save(it) }.toByteArray() }
        val inspection = editor.inspect(original, "PDF")
        assertEquals(1, inspection.pageImages.size)
        val filled = editor.fill(original, "PDF", facts, listOf(ApplicationDocumentPlacement("company:name", "page-0", ApplicationDocumentBox(.1f, .1f, .5f, .1f))))
        Loader.loadPDF(filled).use { doc ->
            assertEquals(1, doc.numberOfPages)
            val field = doc.documentCatalog.acroForm.fields.single() as PDTextField
            assertEquals("새봄 & 연구소", field.value)
            assertFalse(field.isReadOnly)
            field.value = "수정한 회사"
            assertEquals("수정한 회사", field.value)
            val image = PDFRenderer(doc).renderImage(0)
            val nonWhite = (0 until image.height).sumOf { y -> (0 until image.width).count { x -> image.getRGB(x, y) and 0xffffff != 0xffffff } }
            assertTrue(nonWhite > 100)
        }
    }

    @Test
    fun rejectsMissingTargetsInvalidFilesAndUnmappedFactsWithoutProducingAnotherFormat() {
        assertThrows(ApplicationDocumentException::class.java) { editor.inspect("not a document".toByteArray(), "HWP") }
        assertThrows(ApplicationDocumentException::class.java) { editor.inspect(byteArrayOf(1), "DOCX") }
        assertThrows(ApplicationDocumentException::class.java) { editor.fill(byteArrayOf(1), "HWPX", facts, emptyList()) }
    }

    private fun entries(bytes: ByteArray): Map<String, ByteArray> = buildMap {
        ZipInputStream(bytes.inputStream()).use { zip -> while (true) { val entry = zip.nextEntry ?: break; put(entry.name, zip.readBytes()) } }
    }
}
