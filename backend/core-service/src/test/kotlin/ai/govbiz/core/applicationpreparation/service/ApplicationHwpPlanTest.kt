package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import kr.dogfoot.hwplib.reader.HWPReader
import kr.dogfoot.hwplib.writer.HWPWriter
import kr.dogfoot.hwplib.tool.blankfilemaker.BlankFileMaker
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

class ApplicationHwpPlanTest {
    private val editor = ApplicationDocumentEditor()
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun source(text: String): ByteArray {
        val file = BlankFileMaker.make()
        listOf(text, "필수 고지 및 서명란 유지").forEach { value -> file.bodyText.sectionList[0].addNewParagraph().apply {
            createText(); this.text.addString(value); createCharShape(); charShape.addParaCharShape(0, 0)
        } }
        return ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
    }
    private fun plan(bytes: ByteArray, operations: List<ApplicationDocumentEditOperation>, scope: List<String>) =
        ApplicationDocumentWritePlan(hash(bytes), "native-map-v3", 2, "a".repeat(64), operations, emptyList(), scope)
    private fun operation(target: ApplicationDocumentTarget, start: Int, end: Int, kind: String = "replace_range", fact: String? = "company") =
        ApplicationDocumentEditOperation(target.id, kind, target.text, start, end, fact, reason = "사람이 지정한 검증용 범위")

    @Test fun preservesLabelNoticeOtherParagraphsAndNewlinesWhenReopened() {
        val original = source("기업명: 예시 회사 / 고지 유지")
        val savedSource = original.copyOf()
        val before = editor.inspect(original, "hwp").targets
        val target = before.single { it.text.startsWith("기업명:") }
        val start = target.text.indexOf("예시")
        val facts = listOf(ApplicationDocumentFact("company", "기업명", "새봄 & 연구소\n개발팀"))
        val op = operation(target, start, start + "예시 회사".length)
        val result = editor.applyHwpPlan(original, facts, plan(original, listOf(op), listOf(target.id)), listOf(ApplicationDocumentPlacement("company", target.id)), listOf(target.id))
        val after = editor.inspect(result, "hwp").targets
        assertEquals("기업명: 새봄 & 연구소\n개발팀 / 고지 유지", after.single { it.id == target.id }.text)
        before.filter { it.id != target.id }.forEach { old -> assertEquals(old.text, after.single { it.id == old.id }.text) }
        assertArrayEquals(savedSource, original)
        assertEquals(before.map { it.id }, after.map { it.id })
    }

    @Test fun fillsRealTableAndCheckboxAndPreservesEmbeddedResources() {
        val original = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val targets = editor.inspect(original, "hwp").targets
        val count = targets.single { it.text.contains("____명") }
        val check = targets.single { it.kind == "CHECKBOX" && it.text == "디지털 테크" }
        val facts = listOf(ApplicationDocumentFact("company", "인원", "3"), ApplicationDocumentFact("choice", "분야", "디지털 테크"))
        val operations = listOf(operation(count, count.text.indexOf("____"), count.text.indexOf("____") + 4), operation(check, 0, check.text.length, "set_check", "choice"))
        val bindings = listOf(ApplicationDocumentPlacement("company", count.id), ApplicationDocumentPlacement("choice", check.id))
        val result = editor.applyHwpPlan(original, facts, plan(original, operations, targets.map { it.id }), bindings, targets.map { it.id })
        assertTrue(editor.inspect(result, "hwp").targets.single { it.id == count.id }.text.contains("3명"))
        val before = HWPReader.fromInputStream(original.inputStream())
        val after = HWPReader.fromInputStream(result.inputStream())
        assertEquals(before.binData.embeddedBinaryDataList.map { it.name }, after.binData.embeddedBinaryDataList.map { it.name })
        before.binData.embeddedBinaryDataList.zip(after.binData.embeddedBinaryDataList).forEach { (a, b) -> assertArrayEquals(a.data, b.data) }
    }

    @Test fun rejectsStaleTextSourceOverlappingRangesAndUnboundLocations() {
        val original = source("기업명: ____")
        val target = editor.inspect(original, "hwp").targets.single { it.text.startsWith("기업명:") }
        val facts = listOf(ApplicationDocumentFact("company", "기업명", "새봄"))
        val op = operation(target, target.text.indexOf("____"), target.text.length)
        val valid = plan(original, listOf(op), listOf(target.id))
        val bindings = listOf(ApplicationDocumentPlacement("company", target.id))
        val invalid = listOf(valid.copy(sourceSha256 = "0".repeat(64)), valid.copy(operations = listOf(op.copy(expectedText = "변경됨"))),
            valid.copy(operations = listOf(op, op.copy(operation = "delete_range", valueRef = null))), valid.copy(scopeTargetIds = emptyList()))
        invalid.forEach { candidate -> assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, facts, candidate, bindings, listOf(target.id)) } }
        assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, facts, valid, listOf(bindings.single().copy(targetId = "unbound")), listOf(target.id)) }
    }

    @Test fun rejectsInventedChecksAndScopeThatCannotClearTheChoiceGroup() {
        val original = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val targets = editor.inspect(original, "hwp").targets
        val check = targets.single { it.kind == "CHECKBOX" && it.text == "디지털 테크" }
        val op = operation(check, 0, check.text.length, "set_check")
        val binding = listOf(ApplicationDocumentPlacement("company", check.id))
        assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, listOf(ApplicationDocumentFact("company", "분야", "없는 선택지")), plan(original, listOf(op), targets.map { it.id }), binding, targets.map { it.id }) }
        assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, listOf(ApplicationDocumentFact("company", "분야", check.text)), plan(original, listOf(op), listOf(check.id)), binding, listOf(check.id)) }
    }

    @Test fun writesDerivedChoiceMarksAndSplitDatesWhileKeepingPrintedText() {
        val original = source("□ 자가 □ 임차 / 2026년    월    일")
        val target = editor.inspect(original, "hwp").targets.single { it.text.startsWith("□ 자가") }
        val facts = listOf(ApplicationDocumentFact("site", "사업장", "자가"), ApplicationDocumentFact("date", "신청일", "2026-10-01"))
        val month = target.text.indexOf("년") + 1
        val day = target.text.indexOf("월") + 1
        val operations = listOf(
            operation(target, 0, 1, fact = "site").copy(literal = "■"),
            operation(target, month, month + 4, fact = "date").copy(literal = " 10"),
            operation(target, day, day + 4, fact = "date").copy(literal = " 1"),
        )
        val bindings = listOf(ApplicationDocumentPlacement("site", target.id), ApplicationDocumentPlacement("date", target.id))
        val result = editor.applyHwpPlan(original, facts, plan(original, operations, listOf(target.id)), bindings, listOf(target.id))
        assertEquals("■ 자가 □ 임차 / 2026년 10월 1일", editor.inspect(result, "hwp").targets.single { it.id == target.id }.text)
        // 답에 없는 문구는 파생 문구로 쓸 수 없습니다.
        val invented = operations.toMutableList().also { it[1] = it[1].copy(literal = " 11") }
        assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, facts, plan(original, invented, listOf(target.id)), bindings, listOf(target.id)) }
    }

    @Test fun skippedAnswersAreLeftOutAndTheRestIsWritten() {
        val original = source("기업명: ____")
        val target = editor.inspect(original, "hwp").targets.single { it.text.startsWith("기업명:") }
        val facts = listOf(ApplicationDocumentFact("company", "기업명", "새봄"), ApplicationDocumentFact("site", "사업장", "전세"))
        val bindings = listOf(ApplicationDocumentPlacement("company", target.id), ApplicationDocumentPlacement("site", "s0-other"))
        val op = operation(target, target.text.indexOf("____"), target.text.length)
        val skipped = plan(original, listOf(op), listOf(target.id)).copy(skippedFacts = listOf(ApplicationDocumentSkippedFact("site", "s0-other", "SLOT_MISMATCH")))
        val result = editor.applyHwpPlan(original, facts, skipped, bindings, listOf(target.id))
        assertEquals("기업명: 새봄", editor.inspect(result, "hwp").targets.single { it.id == target.id }.text)
        // 남긴 답이 아닌데 계획에 없으면 여전히 거절합니다.
        assertThrows(ApplicationDocumentException::class.java) { editor.applyHwpPlan(original, facts, skipped.copy(skippedFacts = emptyList()), bindings, listOf(target.id)) }
        assertThrows(ApplicationDocumentException::class.java) {
            editor.applyHwpPlan(original, facts, skipped.copy(skippedFacts = listOf(ApplicationDocumentSkippedFact("site", reason = "UNKNOWN"))), bindings, listOf(target.id))
        }
    }

    /** "s0-p3-t0-r1-c2-p0" 주소의 셀 높이입니다. */
    private fun cellHeight(bytes: ByteArray, id: String): Long {
        val parts = Regex("^s(\\d+)-p(\\d+)-t(\\d+)-r(\\d+)-c(\\d+)-p\\d+$").find(id)!!.groupValues.drop(1).map(String::toInt)
        val file = HWPReader.fromInputStream(bytes.inputStream())
        val paragraph = file.bodyText.sectionList[parts[0]].getParagraph(parts[1])
        val table = paragraph.controlList.filterIsInstance<kr.dogfoot.hwplib.`object`.bodytext.control.ControlTable>()[parts[2]]
        return table.rowList[parts[3]].cellList[parts[4]].listHeader.height
    }

    @Test fun aOneLineAnswerKeepsTheRowHeightAndOnlyExtraLinesGrowIt() {
        val original = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val targets = editor.inspect(original, "hwp").targets
        val count = targets.single { it.text.contains("____명") }
        val before = cellHeight(original, count.id)
        fun write(value: String): ByteArray {
            val op = operation(count, count.text.indexOf("____"), count.text.indexOf("____") + 4)
            return editor.applyHwpPlan(original, listOf(ApplicationDocumentFact("company", "인원", value)), plan(original, listOf(op), listOf(count.id)),
                listOf(ApplicationDocumentPlacement("company", count.id)), listOf(count.id))
        }
        assertEquals(before, cellHeight(write("3"), count.id))
        assertTrue(cellHeight(write("매우 긴 인원 설명 문장입니다. ".repeat(20)), count.id) > before)
    }

    @Test fun anAnswerAsWideAsItsCellStaysOnOneLine() {
        // A phone number or e-mail that fills an empty cell must not double the row: Hancom's fonts are narrower than the
        // server's, and Hancom re-wraps on open anyway.
        val original = requireNotNull(javaClass.getResourceAsStream("/applicationpreparation/checkbox-form.hwp")).readBytes()
        val file = HWPReader.fromInputStream(original.inputStream())
        val address = Regex("^s(\\d+)-p(\\d+)-t(\\d+)-r(\\d+)-c(\\d+)-p0$")
        val (blank, cell, size) = editor.inspect(original, "hwp").targets.filter { it.text.isEmpty() && address.matches(it.id) }.firstNotNullOf { target ->
            val parts = address.find(target.id)!!.groupValues.drop(1).map(String::toInt)
            val cell = file.bodyText.sectionList[parts[0]].getParagraph(parts[1]).controlList
                .filterIsInstance<kr.dogfoot.hwplib.`object`.bodytext.control.ControlTable>()[parts[2]].rowList[parts[3]].cellList[parts[4]]
            val style = cell.paragraphList.first().charShape?.positonShapeIdPairList?.firstOrNull()?.shapeId?.toInt() ?: 0
            val size = file.docInfo.charShapeList[style].baseSize
            if (size >= 800 && cell.paragraphList.count() == 1) Triple(target, cell, size / 100f) else null
        }
        val available = cell.listHeader.width - cell.listHeader.leftMargin - cell.listHeader.rightMargin
        val font = requireNotNull(javaClass.getResourceAsStream("/fonts/NanumGothic-Regular.ttf")).use { java.awt.Font.createFont(java.awt.Font.TRUETYPE_FONT, it) }.deriveFont(size)
        fun width(char: Char) = font.getStringBounds(char.toString(), java.awt.font.FontRenderContext(null, true, true)).width * 100
        val value = StringBuilder()
        var used = 0.0
        for (char in listOf('0', '-')) while (used + width(char) <= available * 0.999) { value.append(char); used += width(char) }
        assertTrue(used > available * 0.95)
        val op = ApplicationDocumentEditOperation(blank.id, "input", "", 0, 0, "phone", reason = "빈 칸에 답 입력")
        fun written(answer: String) = editor.applyHwpPlan(original, listOf(ApplicationDocumentFact("phone", "연락처", answer)),
            plan(original, listOf(op), listOf(blank.id)), listOf(ApplicationDocumentPlacement("phone", blank.id)), listOf(blank.id))
        assertEquals(cellHeight(written("0"), blank.id), cellHeight(written(value.toString()), blank.id))
    }

    @Test fun answersAreWrittenInPlainBlackTextKeepingTheCellSpacingButChoiceMarksKeepThePrintedStyle() {
        val file = BlankFileMaker.make()
        val example = file.docInfo.charShapeList[0].clone().also {
            it.charColor.value = 0xFF0000L  // HWP stores colors as 0x00BBGGRR: blue
            it.property.isItalic = true
            it.charSpaces.setForAll(-5)
        }
        file.docInfo.charShapeList.add(example)
        val exampleId = (file.docInfo.charShapeList.size - 1).toLong()
        listOf("예) 홍길동" to exampleId, "□ 자가 □ 임차" to 0L).forEach { (value, style) -> file.bodyText.sectionList[0].addNewParagraph().apply {
            createText(); text.addString(value); createCharShape(); charShape.addParaCharShape(0, style)
        } }
        val original = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        val targets = editor.inspect(original, "hwp").targets
        val sample = targets.single { it.text == "예) 홍길동" }
        val choice = targets.single { it.text == "□ 자가 □ 임차" }
        val operations = listOf(operation(sample, 0, sample.text.length, fact = "name"), operation(choice, 0, 1, fact = "site").copy(literal = "■"))
        val facts = listOf(ApplicationDocumentFact("name", "성명", "김철수"), ApplicationDocumentFact("site", "사업장", "자가"))
        val bindings = listOf(ApplicationDocumentPlacement("name", sample.id), ApplicationDocumentPlacement("site", choice.id))
        val result = HWPReader.fromInputStream(editor.applyHwpPlan(original, facts, plan(original, operations, listOf(sample.id, choice.id)), bindings,
            listOf(sample.id, choice.id)).inputStream())
        fun shapeAt(text: String): kr.dogfoot.hwplib.`object`.docinfo.CharShape {
            val paragraph = result.bodyText.sectionList[0].paragraphs.single { it.normalString == text }
            return result.docInfo.charShapeList[paragraph.charShape.positonShapeIdPairList.first().shapeId.toInt()]
        }
        assertEquals(0L, shapeAt("김철수").charColor.value)
        assertFalse(shapeAt("김철수").property.isItalic)
        assertEquals(-5, shapeAt("김철수").charSpaces.hangul.toInt())  // spacing fitted to the cell stays
        assertEquals(file.docInfo.charShapeList[0].charColor.value, shapeAt("■ 자가 □ 임차").charColor.value)
    }

    @Test fun deletesOnlyTheSelectedExampleRangeWithoutRequiringBlueText() {
        val original = source("기업명: ____ / 예시: 테스트 / 필수")
        val target = editor.inspect(original, "hwp").targets.single { it.text.startsWith("기업명:") }
        val write = operation(target, target.text.indexOf("____"), target.text.indexOf("____") + 4)
        val start = target.text.indexOf("예시:")
        val delete = operation(target, start, start + "예시: 테스트".length, "delete_range", null)
        val result = editor.applyHwpPlan(original, listOf(ApplicationDocumentFact("company", "기업명", "새봄")), plan(original, listOf(write, delete), listOf(target.id)), listOf(ApplicationDocumentPlacement("company", target.id)), listOf(target.id))
        assertEquals("기업명: 새봄 /  / 필수", editor.inspect(result, "hwp").targets.single { it.id == target.id }.text)
    }
}
