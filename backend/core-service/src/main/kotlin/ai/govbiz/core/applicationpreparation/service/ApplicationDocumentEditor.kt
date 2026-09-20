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
                        "options" to choices, "widgets" to widgets)
                    val currentValue = field.valueAsString
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
                    val blackStyle = file.docInfo.charShapeList[originalStyle].clone().also {
                        it.charColor.value = 0
                        it.property.isItalic = false; it.property.isBold = false; it.property.isStrikeLine = false
                        it.property.underLineSort = UnderLineSort.None
                        it.ratios.setForAll(100); it.charSpaces.setForAll(0)
                    }
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
        require(plan.scopeTargetIds.distinct().size == plan.scopeTargetIds.size && plan.scopeTargetIds.all { it in scopeTargetIds && it in targets })
        val expectedBindings = bindings.filter { it.factId in values }.map { it.factId to it.targetId }
        val actualBindings = plan.operations.filter { it.valueRef != null }.map { it.valueRef!! to it.targetId }
        require(expectedBindings.isNotEmpty() && expectedBindings.distinct().size == expectedBindings.size)
        require(actualBindings.distinct().size == actualBindings.size && actualBindings.toSet() == expectedBindings.toSet())
        require(actualBindings.map { it.first }.toSet() == values.keys && bindings.all { it.box == null })
        plan.operations.forEach { op ->
            val target = requireNotNull(targets[op.targetId])
            require(target.editable && op.targetId in plan.scopeTargetIds && op.expectedText == target.text)
            require(op.box == null && op.stylePolicy == "preserve" && op.reason.isNotBlank())
            require(op.start >= 0 && op.end >= op.start && op.end <= target.text.length)
            if (op.operation == "delete_range") require(op.valueRef == null && op.end > op.start)
            else require(op.valueRef in values)
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
                val value = if (op.operation == "delete_range") "" else values.getValue(op.valueRef!!).value.replace("\r\n", "\n")
                require(value.none { Character.isSurrogate(it) || (it.code < 32 && it != '\n') })
                replaceHwpRange(file, paragraph, op.start, op.end, value)
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

    private fun replaceHwpRange(file: HWPFile, paragraph: Paragraph, start: Int, end: Int, value: String) {
        if (paragraph.text == null) paragraph.createText()
        if (paragraph.charShape == null) paragraph.createCharShape()
        val pairs = paragraph.charShape.positonShapeIdPairList
        val styles = paragraph.text.charList.indices.map { offset -> pairs.lastOrNull { it.position <= offset }?.shapeId ?: 0L }.toMutableList()
        val priorStyle = pairs.lastOrNull { it.position <= start }?.shapeId ?: 0L
        val answerStyle = if (value.isEmpty()) priorStyle else file.docInfo.charShapeList.size.toLong().also {
            file.docInfo.charShapeList.add(file.docInfo.charShapeList[priorStyle.toInt()].clone().also { shape -> shape.charColor.value = 0 })
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
            val prototype = paragraph.lineSeg?.lineSegItemList?.firstOrNull()?.clone() ?: LineSegItem()
            val styles = paragraph.charShape?.positonShapeIdPairList.orEmpty()
            val fontSize = styles.maxOfOrNull { file.docInfo.charShapeList[it.shapeId.toInt()].baseSize }?.coerceAtLeast(800) ?: 1000
            val fontAtSize = font.deriveFont(fontSize / 100f)
            val lineHeight = kotlin.math.ceil(fontAtSize.getLineMetrics("가Ag", metrics).height * 100.0).toInt().coerceAtLeast(fontSize)
            val spacing = maxOf(150, fontSize / 5)
            val starts = mutableListOf(0L)
            var width = 0.0
            var offset = 0L
            paragraph.text?.charList?.forEach { char ->
                val code = char.code and 0xffff
                if (code == 10) { starts += offset + char.charSize; width = 0.0 }
                else if (code >= 32) {
                    val advance = maxOf(fontAtSize.getStringBounds(code.toChar().toString(), metrics).width * 100, if (code >= 0x2e80) fontSize.toDouble() else 0.0)
                    if (width > 0 && width + advance > available * 0.94) { starts += offset; width = 0.0 }
                    width += advance
                }
                offset += char.charSize
            }
            paragraph.deleteLineSeg(); paragraph.createLineSeg()
            starts.distinct().forEachIndexed { index, start ->
                val line = prototype.clone()
                line.textStartPosition = start
                line.lineVerticalPosition = vertical + index * (lineHeight + spacing)
                line.lineHeight = lineHeight; line.textPartHeight = lineHeight
                line.distanceBaseLineToLineVerticalPosition = (lineHeight * .8).toInt()
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
            require(cell.paragraphList.all { it.controlList.isNullOrEmpty() })
            val h = cell.listHeader
            h.property.lineChange = LineChange.Normal
            val width = (h.width - h.leftMargin - h.rightMargin).toInt()
            var cursor = 0
            cell.paragraphList.forEach { cursor += layout(it, width, cursor) }
            val required = cursor + h.topMargin + h.bottomMargin
            if (required > h.height) {
                val delta = required - h.height
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

    private fun hwpExample(file: HWPFile, paragraph: Paragraph): String {
        var offset = 0L
        return paragraph.text?.charList?.joinToString("") { char ->
            val style = paragraph.charShape?.positonShapeIdPairList?.lastOrNull { it.position <= offset }?.shapeId?.toInt() ?: 0
            offset += char.charSize
            val color = file.docInfo.charShapeList[style].charColor
            if (char.code.toInt() >= 32 && isBlue(color.r.toInt(), color.g.toInt(), color.b.toInt())) char.code.toInt().toChar().toString() else ""
        } ?: ""
    }

    private fun removeHwpExample(file: HWPFile, paragraph: Paragraph) {
        var offset = 0L
        val kept = paragraph.text.charList.mapNotNull { char ->
            val style = paragraph.charShape?.positonShapeIdPairList?.lastOrNull { it.position <= offset }?.shapeId ?: 0L
            offset += char.charSize
            val color = file.docInfo.charShapeList[style.toInt()].charColor
            if (char.code.toInt() >= 32 && isBlue(color.r.toInt(), color.g.toInt(), color.b.toInt())) null else char to style
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

    private fun fillPdf(bytes: ByteArray, facts: List<ApplicationDocumentFact>, placements: List<ApplicationDocumentPlacement>): ByteArray = Loader.loadPDF(bytes).use { doc ->
        checkPdf(doc)
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
                val value = byId.getValue(placement.factId).value
                when (field) {
                    is PDTextField -> {
                        if (field.maxLen > 0 && value.length > field.maxLen) throw ApplicationDocumentException("APPLICATION_DOCUMENT_OVERFLOW", "입력란의 글자 수 제한을 초과했습니다. 답변을 확인해 주세요.")
                        val appearance = field.defaultAppearance ?: form.defaultAppearance.orEmpty()
                        val fontCommand = Regex("/[^\\s]+\\s+([0-9]+(?:\\.[0-9]+)?)\\s+Tf")
                        val size = fontCommand.find(appearance)?.groupValues?.get(1)?.toFloatOrNull()?.takeIf { it > 0 } ?: 10f
                        field.defaultAppearance = if (fontCommand.containsMatchIn(appearance)) fontCommand.replace(appearance, "/GovBizKorean $size Tf") else "/GovBizKorean $size Tf 0 g"
                        field.widgets.forEach { widget -> ensurePdfFits(font, value, widget.rectangle.width - 4, widget.rectangle.height - 4, size) }
                        field.value = value
                    }
                    is org.apache.pdfbox.pdmodel.interactive.form.PDChoice -> { require(value in field.optionsExportValues); field.setValue(value) }
                    is org.apache.pdfbox.pdmodel.interactive.form.PDButton -> { require(value in field.onValues || value == "Off"); field.value = value }
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
            val field = PDTextField(form)
            field.partialName = "govbiz_${i}_${java.util.UUID.randomUUID()}"
            field.alternateFieldName = byId.getValue(placement.factId).label
            field.isMultiline = true
            val value = byId.getValue(placement.factId).value
            val width = (if (rotation == 90 || rotation == 270) rect.height else rect.width) - 4
            val height = (if (rotation == 90 || rotation == 270) rect.width else rect.height) - 4
            // Reject answers that would be clipped even at the minimum readable size.
            ensurePdfFits(font, value, width, height)
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
                require(field.valueAsString == value)
                field.widgets.forEach { require(it.appearance?.normalAppearance != null) }
            }
            val renderer = PDFRenderer(reopened)
            for (index in 0 until reopened.numberOfPages) renderer.renderImage(index, .5f)
        }
        output
    }

    private fun ensurePdfFits(font: PDType0Font, value: String, width: Float, height: Float, size: Float = 8f) {
        val lines = value.lines().sumOf { line -> maxOf(1, kotlin.math.ceil(font.getStringWidth(line) / 1000 * size / width).toInt()) }
        if (width <= size || height < lines * size * 1.25f) throw ApplicationDocumentException("APPLICATION_DOCUMENT_OVERFLOW", "입력란에 답변 전체가 들어가지 않습니다. 문안을 확인해 주세요.")
    }

    private fun fail(message: String): Nothing = throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNSUPPORTED", message)
    private fun <T> safely(block: () -> T): T = try { block() } catch (error: ApplicationDocumentException) { throw error } catch (error: Exception) {
        throw ApplicationDocumentException("APPLICATION_DOCUMENT_UNSUPPORTED", "원본의 구조 또는 편집 제한으로 문서를 생성하지 못했습니다. 원본 파일을 확인해 주세요.", error)
    }
    private companion object { const val MAX_BYTES = 32 * 1024 * 1024 }
}
