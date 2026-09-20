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
