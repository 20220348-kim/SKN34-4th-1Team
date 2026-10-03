package ai.govbiz.core.applicationpreparation.service

import ai.govbiz.core.applicationpreparation.domain.*
import ai.govbiz.core.applicationpreparation.service.exception.ApplicationDocumentException
import kr.dogfoot.hwplib.`object`.HWPFile
import kr.dogfoot.hwplib.`object`.bodytext.ParagraphListInterface
import kr.dogfoot.hwplib.`object`.bodytext.control.ControlTable
import kr.dogfoot.hwplib.`object`.bodytext.control.ControlForm
import kr.dogfoot.hwplib.`object`.bodytext.control.table.Cell
import kr.dogfoot.hwplib.`object`.bodytext.control.form.FormObjectType
import kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertySet
import kr.dogfoot.hwplib.`object`.bodytext.control.form.properties.PropertyNormal
import kr.dogfoot.hwplib.`object`.bodytext.control.gso.textbox.LineChange
import kr.dogfoot.hwplib.`object`.bodytext.paragraph.lineseg.LineSegItem
import kr.dogfoot.hwplib.`object`.docinfo.charshape.UnderLineSort
import kr.dogfoot.hwplib.`object`.bodytext.paragraph.Paragraph
import kr.dogfoot.hwplib.reader.HWPReader
import kr.dogfoot.hwplib.writer.HWPWriter
import org.apache.pdfbox.Loader
import org.apache.pdfbox.cos.COSName
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDResources
import org.apache.pdfbox.pdmodel.common.PDRectangle
import org.apache.pdfbox.pdmodel.font.PDType0Font
import org.apache.pdfbox.pdmodel.interactive.form.PDAcroForm
import org.apache.pdfbox.pdmodel.interactive.form.PDTextField
import org.apache.pdfbox.rendering.PDFRenderer
import org.apache.pdfbox.text.PDFTextStripper
import org.springframework.core.io.ClassPathResource
import org.springframework.stereotype.Component
import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.imageio.ImageIO
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.transform.TransformerFactory
import javax.xml.transform.dom.DOMSource
import javax.xml.transform.stream.StreamResult

/** 원본의 표·문단 또는 PDF 입력란에만 기입한다. 다른 형식으로 변환하거나 본문을 재구성하지 않는다. */
@Component
class ApplicationDocumentEditor {
    fun inspect(bytes: ByteArray, format: String): ApplicationDocumentInspection = safely {
        require(bytes.size in 1..MAX_BYTES)
        when (format.lowercase()) {
            "hwp" -> {
                val file = HWPReader.fromInputStream(bytes.inputStream())
                ApplicationDocumentInspection(inspectHwp(file))
            }
            "hwpx" -> {
                val archive = readZip(bytes)
                val entries = hwpxTargets(archive)
                val blueStyles = hwpxBlueStyles(archive)
                val texts = entries.map { paragraphText(it.third) }
                ApplicationDocumentInspection(entries.mapIndexed { i, entry ->
                    val row = generateSequence(entry.third.parentNode) { it.parentNode }.filterIsInstance<Element>().firstOrNull { it.localName == "tr" }
                    ApplicationDocumentTarget(entry.first, texts[i].take(2000), ((row?.let { "Table row: ${it.textContent.take(700)} | " } ?: "") + context(texts, i)).take(1000), hwpxExample(entry.third, blueStyles).take(2000))
                })
            }
            "pdf" -> Loader.loadPDF(bytes).use { doc ->
                checkPdf(doc)
                val renderer = PDFRenderer(doc)
                val stripper = PDFTextStripper()
                val images = mutableListOf<String>()
                val targets = (0 until doc.numberOfPages).map { index ->
                    val page = doc.getPage(index)
                    val longest = maxOf(page.cropBox.width, page.cropBox.height)
                    val image = renderer.renderImage(index, minOf(1.5f, 1200f / longest))
                    images += ByteArrayOutputStream().use { out -> ImageIO.write(image, "png", out); Base64.getEncoder().encodeToString(out.toByteArray()) }
                    stripper.startPage = index + 1
                    stripper.endPage = index + 1
                    ApplicationDocumentTarget("page-$index", stripper.getText(doc).take(6000), "PDF page ${index + 1}; coordinates relative to the supplied page image")
                }
                require(images.sumOf { it.length } <= 32 * 1024 * 1024)
                val form = doc.documentCatalog.acroForm
                require(form?.hasXFA() != true)
                val fields = form?.fieldTree?.toList().orEmpty()
                require(fields.size <= 3000)
                val fieldMetadata = mutableListOf<Map<String, Any?>>()
                val fieldTargets = fields.filterIsInstance<org.apache.pdfbox.pdmodel.interactive.form.PDTerminalField>().map { field ->
                    val choices = when (field) {
                        is org.apache.pdfbox.pdmodel.interactive.form.PDChoice -> field.optionsExportValues
                        is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton ->
                            if (field.exportValues.size != field.exportValues.distinct().size)
                                field.exportValues.indices.map(Int::toString)
                            else (field.onValues + "Off").toList()
                        is org.apache.pdfbox.pdmodel.interactive.form.PDButton -> (field.onValues + "Off").toList()
                        else -> emptyList()
                    }
                    val id = "pdf-field:${field.fullyQualifiedName}"
                    val widgets = field.widgets.map { widget ->
                        val index = (0 until doc.numberOfPages).firstOrNull { n -> doc.getPage(n).annotations.any { it.cosObject === widget.cosObject } }
                        val page = index?.let(doc::getPage)
                        val rect = widget.rectangle
                        mapOf<String, Any?>("page" to index, "x" to rect?.lowerLeftX, "y" to rect?.lowerLeftY,
                            "width" to rect?.width, "height" to rect?.height, "rotation" to page?.rotation,
                            "cropX" to page?.cropBox?.lowerLeftX, "cropY" to page?.cropBox?.lowerLeftY,
                            "cropWidth" to page?.cropBox?.width, "cropHeight" to page?.cropBox?.height,
                            "visible" to (!widget.isHidden && !widget.isInvisible))
                    }
                    val supported = field is PDTextField || field is org.apache.pdfbox.pdmodel.interactive.form.PDChoice || field is org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox || field is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton
                    fieldMetadata += mapOf("targetId" to id, "fieldType" to field.javaClass.simpleName,
                        "editable" to (!field.isReadOnly && supported && widgets.any { it["page"] != null && it["visible"] == true && (it["width"] as? Float ?: 0f) > 0 && (it["height"] as? Float ?: 0f) > 0 }),
                        "options" to choices, "optionMappings" to pdfOptionMappings(field).map { (label, native) ->
                            mapOf("displayLabel" to label, "nativeValue" to native) }, "widgets" to widgets)
                    val currentValue = if (field is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton &&
                        field.exportValues.size != field.exportValues.distinct().size)
                        field.cosObject.getNameAsString(org.apache.pdfbox.cos.COSName.V).orEmpty()
                    else field.valueAsString
                    require(currentValue.length <= 6000)
                    ApplicationDocumentTarget(id, currentValue, "${field.alternateFieldName.orEmpty()} | type=${field.fieldType}".take(1000))
                }
                ApplicationDocumentInspection(if (fieldTargets.isEmpty()) targets else fieldTargets, images, fieldMetadata)
            }
            else -> fail("지원하지 않는 원본 파일 형식입니다.")
        }.also { require(it.targets.isNotEmpty() && it.targets.size <= 3000 && it.targets.sumOf { t -> t.text.length + t.context.length + t.exampleText.length } <= 400_000) }
    }

    fun fill(bytes: ByteArray, format: String, facts: List<ApplicationDocumentFact>, placements: List<ApplicationDocumentPlacement>, clearExampleTargetIds: List<String> = emptyList()): ByteArray = safely {
        require(bytes.size in 1..MAX_BYTES)
        require(placements.map { it.factId }.toSet() == facts.map { it.id }.toSet() && placements.size >= facts.size && placements.size <= 600)
        val values = facts.associateBy { it.id }
        fun value(group: List<ApplicationDocumentPlacement>) = group.joinToString("\n") { placement ->
            val fact = values.getValue(placement.factId)
            if (group.size == 1) fact.value else "${fact.label}: ${fact.value}"
        }
        val output = when (format.lowercase()) {
            "hwp" -> {
                val file = HWPReader.fromInputStream(bytes.inputStream())
                val targets = hwpTargets(file).toMap()
                val locations = hwpLocations(file)
                val choices = hwpChoices(file)
                val changed = mutableSetOf<Paragraph>()
                val selected = placements.filter { placement -> choices.any { it.id == placement.targetId } }
                selected.groupBy { placement -> choices.single { it.id == placement.targetId }.group }.forEach { (group, selections) ->
                    require(selections.size == 1 && selections.single().box == null)
                    val selectedChoice = choices.single { it.id == selections.single().targetId }
                    require(selectedChoice.caption.filterNot(Char::isWhitespace) == values.getValue(selections.single().factId).value.filterNot(Char::isWhitespace))
                    choices.filter { it.group == group }.forEach { choice -> choice.value.value = if (choice.id == selectedChoice.id) "1" else "0" }
                }
                clearExampleTargetIds.forEach { id ->
                    val paragraph = requireNotNull(targets[id])
                    require(hwpExample(file, paragraph).isNotBlank())
                    removeHwpExample(file, paragraph)
                    changed += paragraph
                }
                placements.filterNot { it in selected }.groupBy { it.targetId }.forEach { (id, group) ->
                    require(group.size == 1)
                    require(group.all { it.box == null })
                    val paragraph = requireNotNull(targets[id])
                    require(hwpExample(file, paragraph).isBlank())
                    val old = paragraph.normalString
                    val location = locations.single { it.id == id }
                    require(old.isNotBlank() || location.cell != null || locations.none {
                        it.cell != null && it.id.substringBefore("-p") == id.substringBefore("-p")
                    }) { "Blank paragraphs outside a table are not answer cells" }
                    if (paragraph.text == null) paragraph.createText()
                    // insertString uses UTF-16 incorrectly for supplementary characters; reject instead of corrupting them.
                    val replacement = answerRange(old)
                    val addition = (if (replacement.first == old.length && old.isNotBlank() && !old.last().isWhitespace()) " " else "") + value(group)
                    require(addition.none { Character.isSurrogate(it) })
                    val text = paragraph.text
                    require(text.charList.all { (it.code and 0xffff) >= 32 || it.code in listOf(10, 13) })
                    val end = replacement.first
                    val position = end.toLong()
                    val originalStyle = paragraph.charShape?.positonShapeIdPairList?.lastOrNull { it.position <= position }?.shapeId?.toInt() ?: 0
                    val blackStyle = answerShape(file, originalStyle.toLong(), resetSpacing = true)
                    val blackStyleId = file.docInfo.charShapeList.size.toLong()
                    file.docInfo.charShapeList.add(blackStyle)
                    if (paragraph.charShape == null) paragraph.createCharShape()
                    val resumeStyle = paragraph.charShape.positonShapeIdPairList.lastOrNull { it.position <= replacement.last + 1 }?.shapeId ?: originalStyle.toLong()
                    paragraph.charShape.positonShapeIdPairList.removeIf { it.position >= position }
                    paragraph.charShape.addParaCharShape(position, blackStyleId)
                    val removed = (replacement.last - replacement.first + 1).coerceAtLeast(0)
                    repeat(removed) { text.charList.removeAt(end) }
                    text.insertString(end, addition)
                    if (end + removed < old.length) paragraph.charShape.addParaCharShape(position + addition.length, resumeStyle)
                    changed += paragraph
                }
                reflowHwp(file, locations, changed)
                ByteArrayOutputStream().use { out -> HWPWriter.toStream(file, out); out.toByteArray() }
            }
            "hwpx" -> {
                val archive = readZip(bytes)
                val targets = hwpxTargets(archive)
                val blueStyles = hwpxBlueStyles(archive)
                val changed = mutableMapOf<String, Document>()
                val headerName = "Contents/header.xml"
                val header = parseXml(requireNotNull(archive[headerName]))
                val charProperties = header.getElementsByTagNameNS("*", "charPr")
                var nextStyleId = (0 until charProperties.length).maxOfOrNull { (charProperties.item(it) as Element).getAttribute("id").toInt() }?.plus(1) ?: 0
                clearExampleTargetIds.forEach { id ->
                    val (_, name, paragraph) = requireNotNull(targets.find { it.first == id })
                    require(hwpxExample(paragraph, blueStyles).isNotBlank())
                    val runs = paragraph.getElementsByTagNameNS("*", "run")
                    (0 until runs.length).map { runs.item(it) as Element }.filter { it.getAttribute("charPrIDRef") in blueStyles }.forEach { run ->
                        val texts = run.getElementsByTagNameNS("*", "t")
                        (0 until texts.length).map { texts.item(it) }.forEach { it.textContent = "" }
                    }
                    invalidateHwpxLines(paragraph)
                    changed[name] = paragraph.ownerDocument
                }
                placements.groupBy { it.targetId }.forEach { (id, group) ->
                    require(group.size == 1)
                    require(group.all { it.box == null })
                    val (_, name, paragraph) = requireNotNull(targets.find { it.first == id })
                    val doc = paragraph.ownerDocument
                    require(hwpxExample(paragraph, blueStyles).isBlank())
                    val namespace = paragraph.namespaceURI
                    val run = doc.createElementNS(namespace, "${paragraph.prefix ?: "hp"}:run")
                    val priorRun = paragraph.getElementsByTagNameNS(namespace, "run").item(0) as? Element
                    val originalStyleId = priorRun?.getAttribute("charPrIDRef")?.ifBlank { "0" } ?: "0"
                    val originalStyle = (0 until charProperties.length).map { charProperties.item(it) as Element }.first { it.getAttribute("id") == originalStyleId }
                    val blackStyle = originalStyle.cloneNode(true) as Element
                    val blackId = (nextStyleId++).toString()
                    blackStyle.setAttribute("id", blackId)
                    blackStyle.setAttribute("textColor", "#000000")
                    listOf("italic", "bold", "underline", "strikeout", "outline", "shadow").forEach { name ->
                        val decorations = blackStyle.getElementsByTagNameNS("*", name)
                        while (decorations.length > 0) decorations.item(0).let { it.parentNode.removeChild(it) }
                    }
                    originalStyle.parentNode.appendChild(blackStyle)
                    (originalStyle.parentNode as Element).setAttribute("itemCnt", charProperties.length.toString())
                    run.setAttribute("charPrIDRef", blackId)
                    val text = doc.createElementNS(namespace, "${paragraph.prefix ?: "hp"}:t")
                    val oldText = paragraphText(paragraph)
                    val range = answerRange(oldText)
                    val addition = (if (range.first == oldText.length && oldText.isNotBlank() && !oldText.last().isWhitespace()) " " else "") + value(group)
                    val newText = oldText.replaceRange(range.first, range.last + 1, addition)
                    val oldRuns = paragraph.getElementsByTagNameNS(namespace, "run")
                    val runsToRemove = (0 until oldRuns.length).map { oldRuns.item(it) as Element }
                    require(runsToRemove.all { candidate -> (0 until candidate.childNodes.length).map { candidate.childNodes.item(it) }.filterIsInstance<Element>().all { it.localName == "t" } })
                    runsToRemove.forEach { it.parentNode.removeChild(it) }
                    newText.split('\n').forEachIndexed { index, line ->
                        if (index > 0) text.appendChild(doc.createElementNS(namespace, "${paragraph.prefix ?: "hp"}:lineBreak"))
                        text.appendChild(doc.createTextNode(line))
                    }
                    run.appendChild(text)
                    invalidateHwpxLines(paragraph)
                    paragraph.appendChild(run)
                    changed[name] = doc
                }
                changed[headerName] = header
                changed.forEach { (name, doc) ->
                    archive[name] = ByteArrayOutputStream().use { out ->
                        val factory = TransformerFactory.newInstance()
                        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "")
                        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_STYLESHEET, "")
                        factory.newTransformer().transform(DOMSource(doc), StreamResult(out)); out.toByteArray()
                    }
                }
                ByteArrayOutputStream().use { out ->
                    ZipOutputStream(out).use { zip -> archive.forEach { (name, data) ->
                        val entry = ZipEntry(name)
                        if (name == "mimetype") {
                            entry.method = ZipEntry.STORED; entry.size = data.size.toLong()
                            entry.crc = java.util.zip.CRC32().apply { update(data) }.value
                        }
                        zip.putNextEntry(entry); zip.write(data); zip.closeEntry()
                    } }
                    out.toByteArray()
                }
            }
            "pdf" -> { require(clearExampleTargetIds.isEmpty()); fillPdf(bytes, facts, placements) }
            else -> fail("지원하지 않는 원본 파일 형식입니다.")
        }
        require(output.size in 1..MAX_BYTES)
        if (clearExampleTargetIds.isNotEmpty()) {
            val written = inspect(output, format).targets.associateBy { it.id }
            require(clearExampleTargetIds.all { written[it]?.exampleText?.isBlank() == true })
        }
        output
    }

    /** Applies only a validated, question-bound plan to an in-memory copy; never uses COM or a host process. */
    fun applyHwpPlan(bytes: ByteArray, facts: List<ApplicationDocumentFact>, plan: ApplicationDocumentWritePlan,
                     bindings: List<ApplicationDocumentPlacement>, scopeTargetIds: List<String>): ByteArray = safely {
        require(bytes.size in 1..MAX_BYTES && facts.size in 1..200 && plan.operations.size in 1..600)
        require(plan.unresolvedTargets.isEmpty())
        val sourceHash = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        require(sourceHash == plan.sourceSha256)
        val file = HWPReader.fromInputStream(bytes.inputStream())
        val locations = hwpLocations(file)
        val originalText = locations.associate { it.id to hwpText(it.paragraph) }
        val binaryData = file.binData.embeddedBinaryDataList.associate { it.name to it.data.copyOf() }
        val cellLayout = locations.map { location -> location.id to location.cell?.listHeader?.let {
            listOf(it.rowIndex.toLong(), it.colIndex.toLong(), it.rowSpan.toLong(), it.colSpan.toLong(), it.width)
        } }
        val targets = inspectHwp(file).associateBy { it.id }
        val paragraphs = hwpTargets(file).toMap()
        val choices = hwpChoices(file)
        val expectedChecks = choices.associate { it.id to it.value.value }.toMutableMap()
        val expectedText = originalText.toMutableMap()
        val values = facts.associateBy { it.id }
        require(values.size == facts.size && facts.all { it.value.isNotEmpty() && it.value.length <= 2000 })
        // 칸에 맞지 않거나 위치를 정할 수 없어 남긴 답은 쓰지 않고, 나머지 답만 저장된 위치에 씁니다.
        val skipped = plan.skippedFacts.map { it.factId }.toSet()
        require(skipped.size == plan.skippedFacts.size && skipped.all { it in values } &&
            plan.skippedFacts.all { it.reason in ApplicationDocumentSkippedFact.REASONS })
        require(plan.scopeTargetIds.distinct().size == plan.scopeTargetIds.size && plan.scopeTargetIds.all { it in scopeTargetIds && it in targets })
        val expectedBindings = bindings.filter { it.factId in values && it.factId !in skipped }.map { it.factId to it.targetId }
        val actualBindings = plan.operations.filter { it.valueRef != null }.map { it.valueRef!! to it.targetId }
        require(expectedBindings.isNotEmpty() && expectedBindings.distinct().size == expectedBindings.size)
        // 나눠 쓴 날짜·선택 표시는 한 답을 한 문단의 여러 범위에 씁니다. 답을 그대로 쓰는 편집은 위치마다 하나입니다.
        val plain = plan.operations.filter { it.valueRef != null && it.literal == null }.map { it.valueRef!! to it.targetId }
        require(plain.distinct().size == plain.size && actualBindings.toSet() == expectedBindings.toSet())
        require(actualBindings.map { it.first }.toSet() == values.keys - skipped && bindings.all { it.box == null })
        plan.operations.forEach { op ->
            val target = requireNotNull(targets[op.targetId])
            require(target.editable && op.targetId in plan.scopeTargetIds && op.expectedText == target.text)
            require(op.box == null && op.stylePolicy == "preserve" && op.reason.isNotBlank())
            require(op.start >= 0 && op.end >= op.start && op.end <= target.text.length)
            if (op.operation == "delete_range") require(op.valueRef == null && op.end > op.start)
            else require(op.valueRef in values)
            op.literal?.let { literal ->
                // 파생 문구는 선택 표시이거나 답의 일부(날짜 조각, 띄어쓰기를 붙인 답)여야 합니다.
                require(op.operation == "replace_range" && target.kind != "CHECKBOX" && literal.length <= 2100)
                require(literal in CHOICE_MARKS || literal.isNotBlank() && values.getValue(op.valueRef!!).value.contains(literal.trim()))
            }
            if (target.kind == "CHECKBOX") {
                require(op.operation == "set_check" && op.start == 0 && op.end == target.text.length)
                require(values.getValue(op.valueRef!!).value.trim() == target.text.trim())
            } else {
                require(op.operation in setOf("input", "replace_range", "delete_range"))
                if (op.operation == "input") require(target.text.isBlank() && op.start == op.end)
            }
        }
        val selected = plan.operations.filter { targets.getValue(it.targetId).kind == "CHECKBOX" }
        selected.groupBy { op -> choices.single { it.id == op.targetId }.group }.forEach { (group, operations) ->
            require(operations.size == 1)
            val members = choices.filter { it.group == group }
            require(members.all { it.id in plan.scopeTargetIds })
            members.forEach { choice ->
                val value = if (choice.id == operations.single().targetId) "1" else "0"
                choice.value.value = value
                expectedChecks[choice.id] = value
            }
        }
        val changed = mutableSetOf<Paragraph>()
        plan.operations.filterNot { it in selected }.groupBy { it.targetId }.forEach { (id, operations) ->
            val paragraph = requireNotNull(paragraphs[id])
            val ordered = operations.sortedBy { it.start }
            require(ordered.zipWithNext().all { (a, b) -> a.start != b.start && a.end <= b.start })
            var text = originalText.getValue(id)
            operations.sortedByDescending { it.start }.forEach { op ->
                val value = if (op.operation == "delete_range") "" else (op.literal ?: values.getValue(op.valueRef!!).value).replace("\r\n", "\n")
                require(value.none { Character.isSurrogate(it) || (it.code < 32 && it != '\n') })
                replaceHwpRange(file, paragraph, op.start, op.end, value, plain = op.literal !in CHOICE_MARKS)
                text = text.substring(0, op.start) + value + text.substring(op.end)
            }
            require(hwpText(paragraph) == text)
            expectedText[id] = text
            changed += paragraph
        }
        reflowHwp(file, locations, changed)
        val output = ByteArrayOutputStream().also { HWPWriter.toStream(file, it) }.toByteArray()
        require(output.size in 1..MAX_BYTES)
        val reopened = HWPReader.fromInputStream(output.inputStream())
        // Verify every visited paragraph and choice, including those outside the selected form.
        require(hwpLocations(reopened).associate { it.id to hwpText(it.paragraph) } == expectedText)
        require(hwpChoices(reopened).associate { it.id to it.value.value } == expectedChecks)
        require(reopened.bodyText.sectionList.size == file.bodyText.sectionList.size)
        require(reopened.docInfo.paraShapeList.size == file.docInfo.paraShapeList.size)
        require(hwpLocations(reopened).map { location -> location.id to location.cell?.listHeader?.let {
            listOf(it.rowIndex.toLong(), it.colIndex.toLong(), it.rowSpan.toLong(), it.colSpan.toLong(), it.width)
        } } == cellLayout)
        val reopenedBinary = reopened.binData.embeddedBinaryDataList.associate { it.name to it.data }
        require(reopenedBinary.keys == binaryData.keys && binaryData.all { (name, data) -> data.contentEquals(reopenedBinary[name]) })
        output
    }

    private fun hwpText(paragraph: Paragraph): String = paragraph.text?.charList?.joinToString("") { char ->
        val code = char.code and 0xffff
        when { code == 10 -> "\n"; code >= 32 -> code.toChar().toString(); else -> "" }
    }.orEmpty()

    private fun inspectHwp(file: HWPFile): List<ApplicationDocumentTarget> {
        val entries = hwpTargets(file)
        val contexts = entries.map { it.first to hwpText(it.second) }
        return entries.mapIndexed { i, (id, paragraph) ->
            val text = hwpText(paragraph)
            val chars = paragraph.text?.charList.orEmpty()
            val supported = text.length <= 6000 && text.none { Character.isSurrogate(it) } &&
                paragraph.rangeTag?.rangeTagItemList.isNullOrEmpty() &&
                chars.withIndex().all { (index, char) -> char.charSize == 1 &&
                    ((char.code and 0xffff) >= 32 || char.code == 10 || (char.code == 13 && index == chars.lastIndex)) }
            ApplicationDocumentTarget(id, text.take(6000), locatedContext(contexts, i), hwpExample(file, paragraph).take(2000),
                editable = supported, unsupportedReason = if (supported) null else "UNSUPPORTED_TEXT_CONTROLS_OR_OFFSETS")
        } + hwpChoices(file).map { ApplicationDocumentTarget(it.id, it.caption, it.context.take(1000), kind = "CHECKBOX", groupId = it.group) }
    }

    /**
     * 답을 쓸 글자 모양입니다. 앞 글자의 글꼴·크기·장평·자간은 칸에 맞춘 값이라 그대로 두고, 파란·기울임 예시나 굵은 라벨
     * 서식을 따라가지 않도록 검은색·꾸밈 없음으로 맞춥니다. [resetSpacing]이면 이전 기입 방식대로 장평 100·자간 0으로도 맞춥니다.
     */
    private fun answerShape(file: HWPFile, styleId: Long, resetSpacing: Boolean = false) = file.docInfo.charShapeList[styleId.toInt()].clone().also {
        it.charColor.value = 0
        it.property.isItalic = false; it.property.isBold = false; it.property.isStrikeLine = false
        it.property.underLineSort = UnderLineSort.None
        if (resetSpacing) { it.ratios.setForAll(100); it.charSpaces.setForAll(0) }
    }

    /** [plain]이면 [value]를 답 글자 모양으로 쓰고, 아니면(인쇄된 □를 바꾼 ■ 같은 선택 표시) 원래 모양을 유지합니다. */
    private fun replaceHwpRange(file: HWPFile, paragraph: Paragraph, start: Int, end: Int, value: String, plain: Boolean = true) {
        if (paragraph.text == null) paragraph.createText()
        if (paragraph.charShape == null) paragraph.createCharShape()
        val pairs = paragraph.charShape.positonShapeIdPairList
        val styles = paragraph.text.charList.indices.map { offset -> pairs.lastOrNull { it.position <= offset }?.shapeId ?: 0L }.toMutableList()
        val priorStyle = pairs.lastOrNull { it.position <= start }?.shapeId ?: 0L
        val answerStyle = if (value.isEmpty() || !plain) priorStyle else file.docInfo.charShapeList.size.toLong().also {
            file.docInfo.charShapeList.add(answerShape(file, priorStyle))
        }
        repeat(end - start) { paragraph.text.charList.removeAt(start); styles.removeAt(start) }
        if (value.isNotEmpty()) {
            paragraph.text.insertString(start, value)
            styles.addAll(start, List(value.length) { answerStyle })
        }
        while (styles.size < paragraph.text.charList.size) styles.add(priorStyle)
        pairs.clear()
        styles.forEachIndexed { offset, style -> if (offset == 0 || style != styles[offset - 1]) paragraph.charShape.addParaCharShape(offset.toLong(), style) }
    }

    private data class HwpLocation(val id: String, val paragraph: Paragraph, val cell: Cell?, val table: ControlTable?, val tableId: String)
    private data class HwpChoice(val id: String, val caption: String, val group: String, val context: String, val value: PropertyNormal)

    private fun hwpTargets(file: HWPFile): List<Pair<String, Paragraph>> {
        val locations = hwpLocations(file)
        val tableSections = locations.filter { it.cell != null }.map { it.id.substringBefore("-p") }.toSet()
        return locations.filter {
            it.paragraph.controlList.isNullOrEmpty() &&
                (it.cell != null || it.paragraph.normalString.isNotBlank() || it.id.substringBefore("-p") !in tableSections)
        }.map { it.id to it.paragraph }
    }

    private fun hwpLocations(file: HWPFile): List<HwpLocation> {
        require(!file.fileHeader.hasPassword() && !file.fileHeader.isDistribution)
        val result = mutableListOf<HwpLocation>()
        fun walk(list: ParagraphListInterface, path: String, depth: Int, cell: Cell? = null, owner: ControlTable? = null, tableId: String = "") {
            require(depth <= 20)
            list.forEachIndexed { i, paragraph ->
                val id = "$path-p$i"
                result += HwpLocation(id, paragraph, cell, owner, tableId)
                paragraph.controlList?.filterIsInstance<ControlTable>()?.forEachIndexed { t, table ->
                    table.rowList.forEachIndexed { r, row -> row.cellList.forEachIndexed { c, child -> walk(child.paragraphList, "$id-t$t-r$r-c$c", depth + 1, child, table, "$id-t$t") } }
                }
            }
        }
        file.bodyText.sectionList.forEachIndexed { i, section -> walk(section, "s$i", 0) }
        return result
    }

    private fun hwpChoices(file: HWPFile): List<HwpChoice> = hwpLocations(file).flatMap { location ->
        location.paragraph.controlList?.filterIsInstance<ControlForm>()?.mapIndexedNotNull { index, control ->
            if (control.formObject.type !in setOf(FormObjectType.CheckBox, FormObjectType.RadioButton)) return@mapIndexedNotNull null
            val buttons = control.formObject.properties.getProperty("ButtonSet") as? PropertySet ?: return@mapIndexedNotNull null
            val caption = (buttons.getProperty("Caption") as? PropertyNormal)?.value?.trim().orEmpty()
            val value = buttons.getProperty("Value") as? PropertyNormal ?: return@mapIndexedNotNull null
            if (caption.isBlank()) return@mapIndexedNotNull null
            val header = location.cell?.listHeader
            val labelCell = location.table?.rowList?.flatMap { it.cellList }?.filter { cell ->
                val h = cell.listHeader
                header != null && h.colIndex + h.colSpan <= header.colIndex && h.rowIndex <= header.rowIndex && h.rowIndex + h.rowSpan > header.rowIndex && cell.paragraphList.any { it.normalString.isNotBlank() && it.controlList.isNullOrEmpty() }
            }?.maxByOrNull { it.listHeader.colIndex }
            val label = labelCell?.paragraphList?.joinToString(" ") { it.normalString }.orEmpty()
            val group = if (labelCell != null) "${location.tableId}-r${labelCell.listHeader.rowIndex}-c${labelCell.listHeader.colIndex}" else location.id.substringBeforeLast("-c", location.id)
            HwpChoice("${location.id}-f$index", caption, group, "$label | 선택 항목: $caption | ${location.id}", value)
        }.orEmpty()
    }

    /** Replace a real placeholder, or fill an empty/label-only paragraph. Never append to substantive text. */
    private fun answerRange(text: String): IntRange {
        if (text.isBlank()) return 0 until text.length
        val blanks = Regex("[_＿]{2,}").findAll(text).toList()
        if (blanks.size == 1) return blanks.single().range
        require(blanks.isEmpty() && (text.trimEnd().endsWith(":") || text.trimEnd().endsWith("：")))
        return text.length until text.length
    }

    private fun reflowHwp(file: HWPFile, locations: List<HwpLocation>, changed: Set<Paragraph>) {
        val font = ClassPathResource("fonts/NanumGothic-Regular.ttf").inputStream.use { java.awt.Font.createFont(java.awt.Font.TRUETYPE_FONT, it) }
        val metrics = java.awt.font.FontRenderContext(null, true, true)
        fun layout(paragraph: Paragraph, available: Int, vertical: Int): Int {
            require(available > 1000)
            val stored = paragraph.lineSeg?.lineSegItemList?.firstOrNull()
            val prototype = stored?.clone() ?: LineSegItem()
            val styles = paragraph.charShape?.positonShapeIdPairList.orEmpty()
            val fontSize = styles.maxOfOrNull { file.docInfo.charShapeList[it.shapeId.toInt()].baseSize }?.coerceAtLeast(800) ?: 1000
            val fontAtSize = font.deriveFont(fontSize / 100f)
            // 한/글이 이 문단에 저장해 둔 줄 높이·간격을 그대로 씁니다. 서버 글꼴로 잰 값은 조금씩 커서 한 줄 답에도 행이
            // 높아지고 꽉 찬 1쪽 서식이 2쪽으로 넘어갔습니다. 저장된 값이 없을 때만 글꼴로 잽니다.
            val measured = kotlin.math.ceil(fontAtSize.getLineMetrics("가Ag", metrics).height * 100.0).toInt().coerceAtLeast(fontSize)
            val lineHeight = stored?.lineHeight?.takeIf { it > 0 } ?: measured
            val spacing = if (stored != null && stored.lineHeight > 0) stored.lineSpace else maxOf(150, fontSize / 5)
            val textHeight = stored?.textPartHeight?.takeIf { it > 0 } ?: lineHeight
            val baseline = stored?.distanceBaseLineToLineVerticalPosition?.takeIf { it > 0 } ?: (lineHeight * .8).toInt()
            val starts = mutableListOf(0L)
            var width = 0.0
            var offset = 0L
            paragraph.text?.charList?.forEach { char ->
                val code = char.code and 0xffff
                if (code == 10) { starts += offset + char.charSize; width = 0.0 }
                else if (code >= 32) {
                    val advance = maxOf(fontAtSize.getStringBounds(code.toChar().toString(), metrics).width * 100, if (code >= 0x2e80) fontSize.toDouble() else 0.0)
                    // 서버 글꼴(나눔고딕)은 한/글 글꼴보다 넓어 여유까지 두면 한 줄 답(전화번호·이메일)도 두 줄로 잡아 행을 키웠습니다.
                    // 한/글은 열 때 줄을 다시 나누고 모자란 높이는 늘리므로, 칸 폭을 넘을 때만 줄을 나눕니다.
                    if (width > 0 && width + advance > available) { starts += offset; width = 0.0 }
                    width += advance
                }
                offset += char.charSize
            }
            paragraph.deleteLineSeg(); paragraph.createLineSeg()
            starts.distinct().forEachIndexed { index, start ->
                val line = prototype.clone()
                line.textStartPosition = start
                line.lineVerticalPosition = vertical + index * (lineHeight + spacing)
                line.lineHeight = lineHeight; line.textPartHeight = textHeight
                line.distanceBaseLineToLineVerticalPosition = baseline
                line.lineSpace = spacing; line.segmentWidth = available
                line.startPositionFromColumn = 0
                line.tag.setFirstSegmentAtLine(true)
                line.tag.setLastSegmentAtLine(true)
                line.tag.isEmptySegment = paragraph.normalString.isBlank()
                paragraph.lineSeg.lineSegItemList.add(line)
            }
            return starts.distinct().size * (lineHeight + spacing)
        }
        val changedCells = locations.filter { it.paragraph in changed }.mapNotNull { it.cell }.distinct()
        changedCells.forEach { cell ->
            val h = cell.listHeader
            if (cell.paragraphList.any { !it.controlList.isNullOrEmpty() }) {
                // 셀 안에 표·그림 같은 컨트롤 문단이 있으면 셀 높이를 다시 계산할 수 없습니다(컨트롤 높이를 모름).
                // 실제 공고 신청서(강원 모빌리티)의 표 안 표가 이 경우라, 생성을 거절하는 대신 바뀐 문단의 줄 나눔만 다시 잡고
                // 셀·표 높이는 그대로 둡니다. 한/글은 열 때 높이를 다시 계산합니다.
                val width = (h.width - h.leftMargin - h.rightMargin).toInt()
                cell.paragraphList.filter { it in changed }.forEach { paragraph ->
                    val line = paragraph.lineSeg?.lineSegItemList?.firstOrNull()
                    layout(paragraph, width, line?.lineVerticalPosition ?: 0)
                }
                return@forEach
            }
            h.property.lineChange = LineChange.Normal
            val width = (h.width - h.leftMargin - h.rightMargin).toInt()
            fun bottom(): Int = cell.paragraphList.mapNotNull { it.lineSeg?.lineSegItemList?.lastOrNull() }
                .maxOfOrNull { it.lineVerticalPosition + it.lineHeight + it.lineSpace } ?: 0
            val before = bottom()
            // 한/글이 잡아 둔 위치에서 시작해, 바뀐 문단만 다시 나누고 그 아래 문단은 늘어난 만큼만 내립니다.
            var cursor = cell.paragraphList.firstOrNull()?.lineSeg?.lineSegItemList?.firstOrNull()?.lineVerticalPosition ?: 0
            cell.paragraphList.forEach { paragraph ->
                val lines = paragraph.lineSeg?.lineSegItemList.orEmpty()
                if (paragraph in changed || lines.isEmpty()) cursor += layout(paragraph, width, cursor)
                else {
                    val shift = cursor - lines.first().lineVerticalPosition
                    lines.forEach { it.lineVerticalPosition += shift }
                    cursor = lines.last().let { it.lineVerticalPosition + it.lineHeight + it.lineSpace }
                }
            }
            // 답 때문에 내용이 원래보다 길어지고 셀 높이도 넘을 때만, 넘친 만큼 행을 키웁니다.
            val grown = minOf(cursor - before, cursor + h.topMargin + h.bottomMargin - h.height.toInt())
            if (grown > 0) {
                val delta = grown
                val table = requireNotNull(locations.first { it.cell === cell }.table)
                val row = h.rowIndex + h.rowSpan - 1
                table.rowList.flatMap { it.cellList }.filter { it.listHeader.rowIndex <= row && it.listHeader.rowIndex + it.listHeader.rowSpan > row }.forEach { it.listHeader.height += delta }
                table.header.height += delta
                table.header.property.isProtectSize = false
            }
        }
        locations.filter { it.paragraph in changed && it.cell == null }.forEach { location ->
            val line = location.paragraph.lineSeg?.lineSegItemList?.firstOrNull()
            layout(location.paragraph, line?.segmentWidth?.takeIf { it > 1000 } ?: 42000, line?.lineVerticalPosition ?: 0)
        }
    }

    private fun readZip(bytes: ByteArray): LinkedHashMap<String, ByteArray> {
        val result = linkedMapOf<String, ByteArray>()
        var total = 0
        ZipInputStream(bytes.inputStream()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                require(result.size < 256 && !result.containsKey(entry.name))
                val data = zip.readNBytes(MAX_BYTES - total + 1)
                total += data.size
                require(total <= MAX_BYTES)
                result[entry.name] = data
            }
        }
        return result
    }

    private fun parseXml(bytes: ByteArray): Document {
        val factory = DocumentBuilderFactory.newInstance()
        factory.isNamespaceAware = true
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        factory.setFeature("http://xml.org/sax/features/external-general-entities", false)
        factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false)
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "")
        factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "")
        return factory.newDocumentBuilder().parse(bytes.inputStream())
    }

    private fun hwpxTargets(archive: Map<String, ByteArray>): List<Triple<String, String, Element>> {
        return archive.filterKeys { Regex("Contents/section[0-9]+\\.xml").matches(it) }.flatMap { (name, data) ->
            val doc = parseXml(data)
            val paragraphs = doc.getElementsByTagNameNS("*", "p")
            (0 until paragraphs.length).mapNotNull { i ->
                val paragraph = paragraphs.item(i) as Element
                // Container paragraphs with tables/shapes must remain untouched; their leaf paragraphs are visited separately.
                if (paragraph.getElementsByTagNameNS("*", "p").length > 0 || paragraph.getElementsByTagNameNS("*", "ctrl").length > 0) null
                else Triple("${name.substringAfter('/').substringBefore('.')}-p$i", name, paragraph)
            }
        }
    }

    private fun paragraphText(paragraph: Element): String {
        val texts = paragraph.getElementsByTagNameNS("*", "t")
        fun content(node: org.w3c.dom.Node): String = if (node.localName == "lineBreak") "\n" else if (node.nodeType == org.w3c.dom.Node.TEXT_NODE) node.nodeValue else (0 until node.childNodes.length).joinToString("") { content(node.childNodes.item(it)) }
        return (0 until texts.length).joinToString("") { content(texts.item(it)) }
    }

    private fun context(texts: List<String>, i: Int) = texts.subList(maxOf(0, i - 2), minOf(texts.size, i + 3)).joinToString(" | ").take(300)

    private fun locatedContext(entries: List<Pair<String, String>>, index: Int): String {
        val id = entries[index].first
        val row = id.substringBeforeLast("-c", "")
        val neighbors = entries.subList(maxOf(0, index - 3), minOf(entries.size, index + 4))
        val sameRow = if (row.isEmpty()) emptyList() else entries.filter { it.first.startsWith("$row-c") }
        return (sameRow + neighbors).distinctBy { it.first }.joinToString(" | ") { "${it.first}: ${it.second.take(160)}" }.take(1000)
    }

    private fun isBlue(red: Int, green: Int, blue: Int) = blue >= 128 && blue > red + 40 && blue > green + 40

    /** 작성 예시·안내 글자색입니다: 파란색, 또는 본문(검정·진회색)보다 옅은 회색. */
    private fun isExample(red: Int, green: Int, blue: Int) =
        isBlue(red, green, blue) || maxOf(red, green, blue) - minOf(red, green, blue) <= 24 && (red + green + blue) / 3 in 110..210

    private fun hwpExample(file: HWPFile, paragraph: Paragraph): String {
        var offset = 0L
        return paragraph.text?.charList?.joinToString("") { char ->
            val style = paragraph.charShape?.positonShapeIdPairList?.lastOrNull { it.position <= offset }?.shapeId?.toInt() ?: 0
            offset += char.charSize
            val color = file.docInfo.charShapeList[style].charColor
            if (char.code.toInt() >= 32 && isExample(color.r.toInt(), color.g.toInt(), color.b.toInt())) char.code.toInt().toChar().toString() else ""
        } ?: ""
    }

    private fun removeHwpExample(file: HWPFile, paragraph: Paragraph) {
        var offset = 0L
        val kept = paragraph.text.charList.mapNotNull { char ->
            val style = paragraph.charShape?.positonShapeIdPairList?.lastOrNull { it.position <= offset }?.shapeId ?: 0L
            offset += char.charSize
            val color = file.docInfo.charShapeList[style.toInt()].charColor
            if (char.code.toInt() >= 32 && isExample(color.r.toInt(), color.g.toInt(), color.b.toInt())) null else char to style
        }
        // Offsets in range annotations cannot safely be reused after deleting characters.
        require(paragraph.rangeTag?.rangeTagItemList.isNullOrEmpty())
        paragraph.text.charList.clear()
        if (paragraph.charShape == null) paragraph.createCharShape()
        paragraph.charShape.positonShapeIdPairList.clear()
        offset = 0L
        var lastStyle: Long? = null
        kept.forEach { (char, style) ->
            paragraph.text.charList.add(char)
            if (style != lastStyle) paragraph.charShape.addParaCharShape(offset, style)
            offset += char.charSize
            lastStyle = style
        }
        // Keep the original line prototype until reflowHwp rebuilds all affected lines.
    }

    private fun hwpxBlueStyles(archive: Map<String, ByteArray>): Set<String> {
        val properties = parseXml(requireNotNull(archive["Contents/header.xml"])).getElementsByTagNameNS("*", "charPr")
        return (0 until properties.length).map { properties.item(it) as Element }.filter {
            val rgb = it.getAttribute("textColor").removePrefix("#").toIntOrNull(16) ?: 0
            isBlue((rgb shr 16) and 255, (rgb shr 8) and 255, rgb and 255)
        }.map { it.getAttribute("id") }.toSet()
    }

    private fun hwpxExample(paragraph: Element, styles: Set<String>): String {
        val runs = paragraph.getElementsByTagNameNS("*", "run")
        return (0 until runs.length).map { runs.item(it) as Element }.filter { it.getAttribute("charPrIDRef") in styles }.joinToString("") { paragraphText(it) }
    }

    private fun invalidateHwpxLines(paragraph: Element) {
        val lines = paragraph.getElementsByTagNameNS("*", "linesegarray")
        while (lines.length > 0) lines.item(0).let { it.parentNode.removeChild(it) }
    }

    private fun checkPdf(doc: PDDocument) {
        require(!doc.isEncrypted && doc.currentAccessPermission.canModify() && doc.numberOfPages in 1..50)
        require(doc.signatureDictionaries.isEmpty())
    }

    /**
     * PDF에 답을 채우되 칸에 다 들어가지 않는 답은 빼고 나머지를 씁니다. 뺀 답은 그 칸에 들어가는 대략의 글자 수와 함께
     * 돌려줍니다. 한 답이 여러 칸에 걸리면 한 칸이라도 넘칠 때 그 답 전체를 빼고, 넣을 답이 하나도 남지 않으면 OVERFLOW입니다.
     */
    fun fillPdfFitting(bytes: ByteArray, facts: List<ApplicationDocumentFact>, placements: List<ApplicationDocumentPlacement>): Pair<ByteArray, Map<String, Int>> = safely {
        require(bytes.size in 1..MAX_BYTES)
        require(placements.map { it.factId }.toSet() == facts.map { it.id }.toSet() && placements.size >= facts.size && placements.size <= 600)
        val overflow = linkedMapOf<String, Int>()
        val first = fillPdf(bytes, facts, placements, overflow)
        val output = if (overflow.isEmpty()) first else {
            val kept = placements.filter { it.factId !in overflow }
            if (kept.isEmpty()) throw ApplicationDocumentException("APPLICATION_DOCUMENT_OVERFLOW", "입력란에 답변 전체가 들어가지 않습니다. 답변을 확인해 주세요.")
            fillPdf(bytes, facts.filter { it.id !in overflow }, kept)
        }
        require(output.size in 1..MAX_BYTES)
        output to overflow
    }

    private fun fillPdf(bytes: ByteArray, facts: List<ApplicationDocumentFact>, placements: List<ApplicationDocumentPlacement>,
                        overflow: MutableMap<String, Int>? = null): ByteArray = Loader.loadPDF(bytes).use { doc ->
        checkPdf(doc)
        // overflow가 있으면 넘치는 답을 거기에 적고 건너뜁니다. 없으면 지금처럼 문서 전체를 실패시킵니다.
        fun overflowed(placement: ApplicationDocumentPlacement, capacity: Int, message: String) {
            if (overflow == null) throw ApplicationDocumentException("APPLICATION_DOCUMENT_OVERFLOW", message)
            overflow.merge(placement.factId, capacity) { a, b -> minOf(a, b) }
        }
        val form = doc.documentCatalog.acroForm ?: PDAcroForm(doc).also { doc.documentCatalog.acroForm = it }
        require(!form.hasXFA())
        val resources = form.defaultResources ?: PDResources().also { form.defaultResources = it }
        val font = ClassPathResource("fonts/NanumGothic-Regular.ttf").inputStream.use { PDType0Font.load(doc, it, false) }
        resources.put(COSName.getPDFName("GovBizKorean"), font)
        val byId = facts.associateBy { it.id }
        placements.filter { it.box != null }.forEachIndexed { i, placement ->
            val a = requireNotNull(placement.box)
            placements.filter { it.box != null }.drop(i + 1).filter { it.targetId == placement.targetId }.forEach { other ->
                val b = requireNotNull(other.box)
                require(maxOf(a.x, b.x) >= minOf(a.x + a.width, b.x + b.width) || maxOf(a.y, b.y) >= minOf(a.y + a.height, b.y + b.height))
            }
        }
        val expected = mutableMapOf<String, String>()
        val existingFields = form.fieldTree.toList()
        placements.forEachIndexed { i, placement ->
            if (placement.targetId.startsWith("pdf-field:")) {
                require(placement.box == null)
                val name = placement.targetId.removePrefix("pdf-field:")
                require(name !in expected)
                val field = requireNotNull(form.getField(name))
                require(!field.isReadOnly && field !is org.apache.pdfbox.pdmodel.interactive.form.PDSignatureField)
                val fact = byId.getValue(placement.factId)
                val value = if (field is org.apache.pdfbox.pdmodel.interactive.form.PDButton ||
                    field is org.apache.pdfbox.pdmodel.interactive.form.PDChoice)
                    pdfNativeOption(field, fact.value, fact.label)
                else fact.value
                when (field) {
                    is PDTextField -> {
                        if (field.maxLen > 0 && value.length > field.maxLen) {
                            overflowed(placement, field.maxLen, "입력란의 글자 수 제한을 초과했습니다. 답변을 확인해 주세요.")
                            return@forEachIndexed
                        }
                        val appearance = field.defaultAppearance ?: form.defaultAppearance.orEmpty()
                        val fontCommand = Regex("/[^\\s]+\\s+([0-9]+(?:\\.[0-9]+)?)\\s+Tf")
                        val requestedSize = fontCommand.find(appearance)?.groupValues?.get(1)?.toFloatOrNull()?.takeIf { it > 0 } ?: 10f
                        require(field.widgets.isNotEmpty())
                        val size = minOf(requestedSize, field.widgets.minOf { (it.rectangle.height - 1f) / 1.15f } - .1f)
                        if (size < 8f) {
                            overflowed(placement, 0, "입력란에 답변 전체가 들어가지 않습니다. 답변을 확인해 주세요.")
                            return@forEachIndexed
                        }
                        val capacity = field.widgets.mapNotNull { widget ->
                            pdfOverflowCapacity(font, value, widget.rectangle.width - 4, widget.rectangle.height - 1, size, 1.15f)
                        }.minOrNull()
                        if (capacity != null) {
                            overflowed(placement, capacity, "입력란에 답변 전체가 들어가지 않습니다. 문안을 확인해 주세요.")
                            return@forEachIndexed
                        }
                        field.defaultAppearance = if (fontCommand.containsMatchIn(appearance)) fontCommand.replace(appearance, "/GovBizKorean $size Tf") else "/GovBizKorean $size Tf 0 g"
                        field.value = value
                    }
                    is org.apache.pdfbox.pdmodel.interactive.form.PDChoice -> { field.setValue(value) }
                    is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton -> {
                        if (field.exportValues.size != field.exportValues.distinct().size) {
                            val index = value.toIntOrNull()
                            require(index != null && index in field.exportValues.indices)
                            field.setValue(index)
                        } else {
                            field.value = value
                        }
                    }
                    is org.apache.pdfbox.pdmodel.interactive.form.PDButton -> { field.value = value }
                    else -> fail("지원하지 않는 PDF 입력란입니다.")
                }
                expected[name] = value
                return@forEachIndexed
            }
            require(existingFields.isEmpty())
            val index = placement.targetId.removePrefix("page-").toInt()
            require(placement.targetId == "page-$index" && index in 0 until doc.numberOfPages)
            val page = doc.getPage(index)
            val box = requireNotNull(placement.box)
            require(listOf(box.x, box.y, box.width, box.height).all { it.isFinite() } && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 && box.x + box.width <= 1 && box.y + box.height <= 1)
            val crop = page.cropBox
            val rotation = ((page.rotation % 360) + 360) % 360
            require(rotation in setOf(0, 90, 180, 270))
            val rect = when (rotation) {
                0 -> PDRectangle(crop.lowerLeftX + box.x * crop.width, crop.lowerLeftY + (1 - box.y - box.height) * crop.height, box.width * crop.width, box.height * crop.height)
                90 -> PDRectangle(crop.lowerLeftX + box.y * crop.width, crop.lowerLeftY + box.x * crop.height, box.height * crop.width, box.width * crop.height)
                180 -> PDRectangle(crop.lowerLeftX + (1 - box.x - box.width) * crop.width, crop.lowerLeftY + box.y * crop.height, box.width * crop.width, box.height * crop.height)
                else -> PDRectangle(crop.lowerLeftX + (1 - box.y - box.height) * crop.width, crop.lowerLeftY + (1 - box.x - box.width) * crop.height, box.height * crop.width, box.width * crop.height)
            }
            val area = org.apache.pdfbox.text.PDFTextStripperByArea()
            val displayWidth = if (rotation in setOf(90, 270)) crop.height else crop.width
            val displayHeight = if (rotation in setOf(90, 270)) crop.width else crop.height
            area.addRegion("input", java.awt.geom.Rectangle2D.Float(box.x * displayWidth, box.y * displayHeight, box.width * displayWidth, box.height * displayHeight))
            area.extractRegions(page)
            if (area.getTextForRegion("input").isNotBlank()) throw ApplicationDocumentException("APPLICATION_DOCUMENT_MAPPING_FAILED", "PDF 입력 영역에 기존 문구가 남아 있어 작성을 중단했습니다.")
            val value = byId.getValue(placement.factId).value
            val width = (if (rotation == 90 || rotation == 270) rect.height else rect.width) - 4
            val height = (if (rotation == 90 || rotation == 270) rect.width else rect.height) - 4
            // Answers that would be clipped even at the minimum readable size are not written.
            pdfOverflowCapacity(font, value, width, height)?.let { capacity ->
                overflowed(placement, capacity, "입력란에 답변 전체가 들어가지 않습니다. 문안을 확인해 주세요.")
                return@forEachIndexed
            }
            val field = PDTextField(form)
            field.partialName = "govbiz_${i}_${java.util.UUID.randomUUID()}"
            field.alternateFieldName = byId.getValue(placement.factId).label
            field.isMultiline = true
            field.defaultAppearance = "/GovBizKorean 8 Tf 0 g"
            field.widgets[0].apply {
                rectangle = rect; this.page = page; isPrinted = true
                appearanceCharacteristics = org.apache.pdfbox.pdmodel.interactive.annotation.PDAppearanceCharacteristicsDictionary(org.apache.pdfbox.cos.COSDictionary()).also { it.rotation = rotation }
            }
            form.fields.add(field)
            page.annotations.add(field.widgets[0])
            field.value = value
            expected[field.fullyQualifiedName] = value
        }
        form.needAppearances = false
        val output = ByteArrayOutputStream().use { out -> doc.save(out); out.toByteArray() }
        Loader.loadPDF(output).use { reopened ->
            val savedForm = requireNotNull(reopened.documentCatalog.acroForm)
            expected.forEach { (name, value) ->
                val field = requireNotNull(savedForm.getField(name))
                val savedValue = if (field is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton &&
                    field.exportValues.size != field.exportValues.distinct().size)
                    field.cosObject.getNameAsString(org.apache.pdfbox.cos.COSName.V).orEmpty()
                else if (field is org.apache.pdfbox.pdmodel.interactive.form.PDChoice)
                    field.cosObject.getString(org.apache.pdfbox.cos.COSName.V).orEmpty()
                else field.valueAsString
                require(savedValue == value)
                field.widgets.forEach { require(it.appearance?.normalAppearance != null) }
            }
            val renderer = PDFRenderer(reopened)
            for (index in 0 until reopened.numberOfPages) renderer.renderImage(index, .5f)
        }
        output
    }

    private fun pdfOptionMappings(field: org.apache.pdfbox.pdmodel.interactive.form.PDField): List<Pair<String, String>> = when (field) {
        is org.apache.pdfbox.pdmodel.interactive.form.PDChoice ->
            field.optionsDisplayValues.zip(field.optionsExportValues)
                .filter { (label, native) -> label.isNotBlank() && native.isNotBlank() }
        is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton -> {
            val exports = field.exportValues
            val native = if (exports.size == field.widgets.size && exports.size != exports.distinct().size)
                exports.indices.map(Int::toString)
            else if (exports.size == field.widgets.size) exports
            else field.widgets.map { widget -> widget.appearance?.normalAppearance?.subDictionary?.keys
                ?.singleOrNull { it != org.apache.pdfbox.cos.COSName.Off }?.name.orEmpty() }
            field.widgets.map { it.cosObject.getString(org.apache.pdfbox.cos.COSName.TU).orEmpty().trim() }
                .zip(native).filter { (label, value) -> label.isNotBlank() && value.isNotBlank() }
        }
        is org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox -> {
            val caption = field.widgets.singleOrNull()?.cosObject?.getString(org.apache.pdfbox.cos.COSName.TU).orEmpty().trim()
            if (caption.isNotBlank() && field.onValues.size == 1) listOf(caption to field.onValues.single()) else emptyList()
        }
        else -> emptyList()
    }

    private fun pdfNativeOption(field: org.apache.pdfbox.pdmodel.interactive.form.PDField,
                                userValue: String, factLabel: String): String {
        val options = when (field) {
            is org.apache.pdfbox.pdmodel.interactive.form.PDChoice -> field.optionsExportValues
            is org.apache.pdfbox.pdmodel.interactive.form.PDRadioButton ->
                if (field.exportValues.size != field.exportValues.distinct().size)
                    field.exportValues.indices.map(Int::toString)
                else field.onValues.toList() + "Off"
            is org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox -> field.onValues.toList() + "Off"
            else -> emptyList()
        }
        if (options.count { it == userValue } == 1) return userValue
        fun key(value: String) = java.text.Normalizer.normalize(value.trim(), java.text.Normalizer.Form.NFKC).lowercase(java.util.Locale.ROOT)
        val matching = pdfOptionMappings(field).filter { (label, _) -> key(label) == key(userValue) }
        if (matching.size == 1 && options.count { it == matching.single().second } == 1) return matching.single().second
        if (field is org.apache.pdfbox.pdmodel.interactive.form.PDCheckBox && field.onValues.size == 1 &&
            pdfOptionMappings(field).size == 1 &&
            listOf(field.fullyQualifiedName, field.alternateFieldName.orEmpty()).any { key(it) == key(factLabel) }) {
            if (key(userValue) == "true") return field.onValues.single()
            if (key(userValue) == "false") return "Off"
        }
        throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNRESOLVED_OPTION", "선택값과 원본 PDF 입력란의 선택지를 확인할 수 없습니다.")
    }

    /** 답이 칸에 다 들어가면 null, 아니면 그 칸에 들어가는 대략의 글자 수입니다(한글 한 글자를 글자 크기만큼의 폭으로 봅니다). */
    private fun pdfOverflowCapacity(font: PDType0Font, value: String, width: Float, height: Float,
                                    size: Float = 8f, lineHeight: Float = 1.25f): Int? {
        if (width <= size) return 0
        val lines = value.lines().sumOf { line -> maxOf(1, kotlin.math.ceil(font.getStringWidth(line) / 1000 * size / width).toInt()) }
        if (height >= lines * size * lineHeight) return null
        return (height / (size * lineHeight)).toInt() * (width / size).toInt()
    }

    private fun fail(message: String): Nothing = throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNSUPPORTED", message)
    private fun <T> safely(block: () -> T): T = try { block() } catch (error: ApplicationDocumentException) { throw error } catch (error: Exception) {
        // 어느 검증에서 걸렸는지 운영 로그로 남깁니다. 답변 값은 예외 메시지에 넣지 않으므로 클래스·메시지·발생 위치만 기록합니다.
        val origin = error.stackTrace.firstOrNull { it.className.startsWith("ai.govbiz") }?.let { "${it.fileName}:${it.lineNumber}" }
        org.slf4j.LoggerFactory.getLogger(javaClass).warn("application_document_editor_unsupported rootException={} rootMessage={} origin={}",
            error.javaClass.name, error.message?.take(300), origin)
        throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNSUPPORTED", "원본의 구조 또는 편집 제한으로 문서를 생성하지 못했습니다. 원본 파일을 확인해 주세요.", error)
    }
    private companion object {
        const val MAX_BYTES = 32 * 1024 * 1024
        /** 인쇄된 선택지에 쓰는 표시: □→■, [ ]→√, ( )→○ */
        val CHOICE_MARKS = setOf("■", "√", "○")
    }
}
