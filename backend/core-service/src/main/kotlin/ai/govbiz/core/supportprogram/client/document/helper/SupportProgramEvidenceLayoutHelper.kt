package ai.govbiz.core.supportprogram.client.document.helper

import kotlin.math.abs
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.text.PDFTextStripper
import org.apache.pdfbox.text.TextPosition
import org.w3c.dom.Element

/**
 * 중복 검토 근거용으로 원문의 줄 구조를 되살립니다. PDF는 글자 좌표로 화면 줄바꿈을 잇고 칸이 벌어진 줄을 표 행으로 나누며,
 * HWPX는 표를 행 단위("칸 | 칸")로 뽑습니다. 신청 문서 양식 분석이 쓰는 추출 결과와 재사용 키는 바꾸지 않습니다.
 */
object SupportProgramEvidenceLayoutHelper {
    /** trailingSpace는 원문에 낱말 뒤 공백 글자가 있었는지입니다. 줄 끝에서 이 공백이 있으면 낱말 사이에서 바뀐 줄입니다. */
    data class PdfWord(val text: String, val x0: Float, val x1: Float, val y: Float, val size: Float, val trailingSpace: Boolean = false)

    data class PdfLine(val words: List<PdfWord>) {
        val text: String get() = words.joinToString(" ") { it.text }
        val x0: Float get() = words.first().x0
        val x1: Float get() = words.last().x1
        val y: Float get() = words.first().y
        val size: Float get() = median(words.map { it.size })

        /** 한글 낱말의 글자 폭입니다. PDF마다 단위가 다른 글꼴 크기 값 대신 줄 간격을 잴 때 씁니다. */
        fun glyphWidth(fallback: Float): Float =
            words.filter { HANGUL_WORD.matches(it.text) }.map { (it.x1 - it.x0) / it.text.length }.let { if (it.isEmpty()) fallback else median(it) }
    }

    data class PdfPage(val lines: List<PdfLine>, val width: Float, val height: Float) {
        val text: String get() = lines.joinToString("\n") { it.text }
    }

    data class HwpxLine(val paragraph: Int, val text: String)

    /** PDFBox가 위치순으로 읽은 낱말을 쪽·줄 단위로 모읍니다. 글자 좌표와 크기를 함께 남깁니다. */
    class PdfLineStripper : PDFTextStripper() {
        val pages = mutableListOf<PdfPage>()
        private var lines = mutableListOf<PdfLine>()
        private var words = mutableListOf<PdfWord>()

        init { sortByPosition = true }

        override fun startPage(page: PDPage?) {
            lines = mutableListOf()
            words = mutableListOf()
            super.startPage(page)
        }

        override fun writeString(text: String, textPositions: MutableList<TextPosition>) {
            if (text.isBlank()) {
                if (text.isNotEmpty() && words.isNotEmpty()) words[words.lastIndex] = words.last().copy(trailingSpace = true)
            } else if (text.length == textPositions.size) {
                // 공백 글자가 든 덩어리는 공백 위치에서 낱말로 나눕니다. 내어쓰기 위치와 줄 끝 공백을 낱말마다 볼 수 있습니다.
                Regex("\\S+").findAll(text).forEach { match ->
                    add(match.value, textPositions.subList(match.range.first, match.range.last + 1), match.range.last + 1 < text.length)
                }
            } else {
                add(text.trim(), textPositions, text.last().isWhitespace() || textPositions.last().unicode.isNullOrBlank())
            }
            super.writeString(text, textPositions)
        }

        private fun add(text: String, positions: List<TextPosition>, trailingSpace: Boolean) {
            val visible = positions.filter { !it.unicode.isNullOrBlank() }
            if (visible.isEmpty() || text.isEmpty()) return
            val last = visible.last()
            words += PdfWord(text, visible.first().xDirAdj, last.xDirAdj + last.widthDirAdj, visible.first().yDirAdj,
                median(visible.map { if (it.fontSizeInPt >= 2f) it.fontSizeInPt else it.heightDir }), trailingSpace)
        }

        override fun writeLineSeparator() {
            flushLine()
            super.writeLineSeparator()
        }

        override fun endPage(page: PDPage?) {
            flushLine()
            val box = page?.cropBox
            val turned = (page?.rotation ?: 0) % 180 != 0
            val width = box?.let { if (turned) it.height else it.width } ?: 0f
            val height = box?.let { if (turned) it.width else it.height } ?: 0f
            pages += PdfPage(lines.toList(), width, height)
            super.endPage(page)
        }

        private fun flushLine() {
            if (words.isNotEmpty()) lines += PdfLine(words.toList())
            words = mutableListOf()
        }
    }

    /**
     * 쪽마다 근거용 글을 만듭니다. 쪽 머리·꼬리 띠 안의 쪽 번호와, 절반 이상의 쪽에 같은 글로 반복되는 줄만 지웁니다.
     * 반복 줄은 붙임 제목이나 안내 각주일 수 있어 처음 나온 쪽에서는 남깁니다.
     */
    fun pdfPages(pages: List<PdfPage>): List<String> {
        val repeated = repeatedEdgeLines(pages)
        return pages.mapIndexed { index, page -> layoutPage(page, index, repeated) }
    }

    /**
     * HWPX 구역의 문단·표·글상자·각주를 문서 순서대로 줄로 바꿉니다. 각 줄에는 원본 문단 번호(구역 안 1부터)를 붙입니다.
     * 여러 칸 표는 행마다 한 줄로 잇고, 1칸 상자·1열 표는 본문처럼, 긴 행이나 문단이 많은 칸은 칸마다 따로 씁니다. 중첩 표는 그 행 뒤에 따로 씁니다.
     */
    fun hwpxLines(root: Element): List<HwpxLine> {
        val paragraphs = root.getElementsByTagNameNS(HP, "p")
        val index = HashMap<Element, Int>(paragraphs.length * 2)
        for (i in 0 until paragraphs.length) index[paragraphs.item(i) as Element] = i + 1
        val lines = mutableListOf<HwpxLine>()
        HwpxWalker(index).visit(root, lines, lines)
        return lines
    }

    /**
     * 칸 목록을 정리합니다. 자간을 벌린 한 글자 칸("업 | 태")은 한 낱말로, 기호만 든 칸 · 붙임 표시 칸 · 쌍점(:)으로 이어지는 칸은
     * 다음 칸과 합치고, "한 자리 번호 칸 + 짧은 제목 칸"은 제목 한 줄로 만듭니다.
     */
    fun mergeCells(cells: List<String>): List<String> {
        val spaced = mutableListOf<Pair<String, Boolean>>()
        for (cell in cells.map { it.trim() }.filter { it.isNotEmpty() }) {
            val last = spaced.lastOrNull()
            if (last != null && last.second && SYLLABLE.matches(cell)) spaced[spaced.lastIndex] = last.first + cell to true
            else spaced += cell to SYLLABLE.matches(cell)
        }
        val merged = mutableListOf<String>()
        for ((cell, _) in spaced) {
            val last = merged.lastOrNull()
            val joins = last != null && (SYMBOL_ONLY.matches(last) || ATTACHMENT_LABEL.matches(last) || last.endsWith(":") || cell.startsWith(":") || cell.startsWith("："))
            if (joins) merged[merged.lastIndex] = "$last $cell" else merged += cell
        }
        if (merged.size == 2 && NUMBER_BOX.matches(merged[0]) && SHORT_TITLE.matches(merged[1])) return listOf("${merged[0].trimEnd('.')}. ${merged[1]}")
        return merged
    }

    /**
     * PDF 앞줄과 다음 줄을 이을 때 사이에 넣을 글자입니다. 줄 끝 공백 신호가 있는 쪽(trailingSpace가 null이 아님)에서는
     * 공백 없이 바뀐 한글 사이를 낱말 중간으로 보고 붙이되, 홀로 쓰는 낱말("및", "또는")이나 흔한 토씨·어미("에게", "으로")로
     * 끝나면 띄웁니다. 신호가 없으면 한 글자만 남은 낱말 중간에서 끊긴 것이 분명할 때만 붙입니다.
     */
    fun glue(previous: String, next: String, trailingSpace: Boolean? = null): String {
        if (Regex("^(?:니다|습니다|입니다)").containsMatchIn(next)) return ""
        val inWord = previous.lastOrNull()?.let { isHangulSyllable(it) || it.isDigit() } == true && next.firstOrNull()?.let(::isHangulSyllable) == true
        if (!inWord) return " "
        val lastWord = previous.substringAfterLast(' ')
        val nextWord = next.substringBefore(' ')
        if (lastWord in STANDALONE_WORDS || nextWord in STANDALONE_WORDS) return " "
        if (trailingSpace != null) return if (trailingSpace || (lastWord.length >= 3 && WORD_END.containsMatchIn(lastWord))) " " else ""
        return if (lastWord.length == 1 && lastWord !in STANDALONE_SYLLABLES) "" else " "
    }

    /** 반복 줄과 그 줄이 처음 나온 쪽 번호(0부터)입니다. */
    private fun repeatedEdgeLines(pages: List<PdfPage>): Map<String, Int> {
        if (pages.size < 3) return emptyMap()
        val occurrences = pages.flatMapIndexed { index, page ->
            page.lines.filter { inEdgeBand(page, it) && cells(it, charWidth(page)).size == 1 }.map(::compact).distinct().map { it to index }
        }
        val threshold = (pages.size + 1) / 2
        return occurrences.groupBy({ it.first }, { it.second })
            .filter { (key, found) -> found.size >= threshold && key.length in 1..60 }
            .mapValues { (_, found) -> found.min() }
    }

    private fun inEdgeBand(page: PdfPage, line: PdfLine) = page.height > 0f && (line.y <= page.height * 0.1f || line.y >= page.height * 0.92f)

    private fun dropped(page: PdfPage, pageIndex: Int, line: PdfLine, repeated: Map<String, Int>): Boolean {
        if (!inEdgeBand(page, line)) return false
        val text = line.text.trim()
        if (PAGE_NUMBER.matches(text)) return true
        if (line.y >= page.height * 0.92f && BARE_PAGE_NUMBER.matches(text)) return true
        val first = repeated[compact(line)] ?: return false
        return first != pageIndex
    }

    private fun layoutPage(page: PdfPage, pageIndex: Int, repeated: Map<String, Int>): String {
        val lines = page.lines.filterNot { dropped(page, pageIndex, it, repeated) }
        if (lines.isEmpty()) return ""
        val charWidth = charWidth(page)
        val rows = lines.map { it to cells(it, charWidth) }
        val single = rows.filter { it.second.size == 1 }.map { it.first }
        val half = page.width * 0.45f
        val rightColumn = single.count { it.x0 > half }
        val twoColumns = page.width > 0f && rightColumn >= 5 && rightColumn >= single.size * 0.2
        fun column(line: PdfLine) = if (twoColumns && line.x0 > half) 1 else 0
        val edges = single.groupBy(::column).mapValues { (_, members) ->
            percentile(members.map { it.x0 }, 0.1) to percentile(members.map { it.x1 }, 0.9)
        }
        // 줄 끝에 공백 글자를 남기는 PDF는 낱말 사이에서만 남깁니다. 그런 쪽에서는 공백 없이 바뀐 줄을 낱말 중간으로 봅니다.
        val spaceSignal = lines.any { it.words.last().trailingSpace }

        fun joins(previous: PdfLine, line: PdfLine, next: String, joined: String): Boolean {
            if (column(previous) != column(line)) return false
            val (left, right) = edges[column(previous)] ?: return false
            val width = right - left
            if (width <= charWidth * 10 || previous.x1 < right - charWidth * 2 || previous.x1 - previous.x0 < width * 0.6f) return false
            if (endsSentence(joined) || startsItem(next) || joined.length + next.length > 500) return false
            // 같은 문단은 글꼴 크기가 15% 안에서 같고, 줄 간격이 한글 글자 폭의 2.5배 이하입니다.
            if (abs(previous.size - line.size) > maxOf(previous.size, line.size) * 0.15f) return false
            val gap = line.y - previous.y
            if (gap <= 0f || gap > maxOf(previous.glyphWidth(charWidth), line.glyphWidth(charWidth)) * 2.5f) return false
            // 다음 줄은 앞줄 첫머리 근처에서 시작하거나, 앞줄 안 낱말 위치(글머리 · 쌍점 뒤 내어쓰기)에 맞춰 시작합니다.
            val shift = line.x0 - previous.x0
            if (shift >= -charWidth * 3 && shift <= charWidth * 4) return true
            return shift > 0f && previous.words.drop(1).any { abs(it.x0 - line.x0) <= charWidth * 1.5f }
        }

        val output = mutableListOf<String>()
        var current: StringBuilder? = null
        var previous: PdfLine? = null
        for ((line, cells) in rows) {
            if (cells.size >= 2) {
                current?.let { output += it.toString() }
                current = null
                previous = null
                output += cells.joinToString(" | ")
                continue
            }
            val text = cells.singleOrNull() ?: continue
            val before = previous
            val building = current
            if (before != null && building != null && joins(before, line, text, building.toString())) {
                building.append(glue(building.toString(), text, if (spaceSignal) before.words.last().trailingSpace else null)).append(text)
            } else {
                current?.let { output += it.toString() }
                current = StringBuilder(text)
            }
            previous = line
        }
        current?.let { output += it.toString() }
        return output.joinToString("\n")
    }

    /** 낱말 사이가 글자 폭의 2.5배보다 넓게 벌어진 곳을 칸 경계로 봅니다. */
    private fun cells(line: PdfLine, charWidth: Float): List<String> {
        val groups = mutableListOf(mutableListOf(line.words.first()))
        line.words.zipWithNext().forEach { (a, b) -> if (b.x0 - a.x1 > charWidth * 2.5f) groups += mutableListOf(b) else groups.last() += b }
        return mergeCells(groups.map { group -> group.joinToString(" ") { it.text } })
    }

    private fun charWidth(page: PdfPage): Float {
        val widths = page.lines.flatMap { line -> line.words.map { (it.x1 - it.x0) / it.text.length.coerceAtLeast(1) } }.filter { it > 0f }
        return if (widths.isEmpty()) 2f else median(widths).coerceAtLeast(2f)
    }

    private fun startsItem(text: String): Boolean {
        val first = text.firstOrNull() ?: return false
        // 글자 · 숫자가 아닌 기호 하나 뒤에 공백이 오면 글머리입니다("‐ 선택항목"). 따옴표 · 말줄임표는 빼고 봅니다.
        val symbol = first.code in 0x2010..0x2BFF && first.code !in 0x2018..0x201F && first.code != 0x2026 && text.getOrNull(1)?.isWhitespace() == true
        return first.code in 0xE000..0xF8FF || symbol || ITEM_START.containsMatchIn(text)
    }

    /** 문장이 끝난 줄인지 봅니다. 괄호가 덜 닫혔거나 한 글자 조각으로 끝나면 끝나지 않은 것으로 봅니다(웹 화면 정리와 같은 규칙). */
    private fun endsSentence(text: String): Boolean {
        val value = text.trimEnd()
        if (!SENTENCE_END.containsMatchIn(value) || Regex("\\s[가-힣]$").containsMatchIn(value)) return false
        return value.count { it == '(' } <= value.count { it == ')' }
    }

    private fun compact(line: PdfLine) = line.text.replace(Regex("\\s+"), "")
    private fun isHangulSyllable(character: Char) = character in '가'..'힣'
    private fun median(values: List<Float>): Float = values.sorted().let { it[it.size / 2] }
    private fun percentile(values: List<Float>, ratio: Double): Float = values.sorted().let { it[(it.size * ratio).toInt().coerceIn(0, it.lastIndex)] }

    private class HwpxCell(val paragraphs: List<HwpxLine>, val nested: List<HwpxLine>)

    private class HwpxWalker(private val index: Map<Element, Int>) {
        /** paragraphs에는 이 노드에 속한 문단 글을, nested에는 그 안의 표가 만든 줄을 담습니다. 본문에서는 둘이 같은 목록입니다. */
        fun visit(node: Element, paragraphs: MutableList<HwpxLine>, nested: MutableList<HwpxLine>) {
            when {
                node.isHp("tbl") -> table(node, nested)
                node.isHp("p") -> {
                    val text = ownText(node)
                    if (text.isNotBlank()) paragraphs += HwpxLine(index[node] ?: 0, text)
                    // 문단 안의 표·글상자·각주는 run 아래에 있습니다. 문단 글 뒤에 이어서 씁니다.
                    for (run in node.children("run")) for (child in run.children()) if (!child.isHp("t")) visit(child, paragraphs, nested)
                }
                else -> for (child in node.children()) visit(child, paragraphs, nested)
            }
        }

        private fun table(table: Element, sink: MutableList<HwpxLine>) {
            // 표 제목(hp:caption) 같은 행 밖의 글은 행보다 먼저 씁니다. 공용 추출처럼 글자를 빠뜨리지 않습니다.
            for (child in table.children()) if (!child.isHp("tr")) visit(child, sink, sink)
            val rows = table.children("tr").map { row -> row.children("tc").map(::cell) }
            val singleColumn = rows.all { it.size <= 1 }
            for (row in rows) {
                val filled = row.filter { it.paragraphs.isNotEmpty() }
                val texts = mergeCells(filled.map { cell -> cell.paragraphs.joinToString(" ") { it.text } })
                val first = filled.firstOrNull()?.paragraphs?.first()?.paragraph ?: 0
                when {
                    filled.isEmpty() -> Unit
                    singleColumn || (filled.size == 1 && texts.size == 1) -> filled.forEach { sink += it.paragraphs }
                    texts.size == 1 -> sink += HwpxLine(first, texts.single())
                    texts.sumOf { it.length } + 3 * (texts.size - 1) > LONG_ROW || filled.any { it.paragraphs.size > 3 } ->
                        filled.forEach { cell ->
                            sink += if (cell.paragraphs.size > 1) cell.paragraphs else listOf(cell.paragraphs.single())
                        }
                    else -> sink += HwpxLine(first, texts.joinToString(" | "))
                }
                row.forEach { sink += it.nested }
            }
        }

        private fun cell(cell: Element): HwpxCell {
            val paragraphs = mutableListOf<HwpxLine>()
            val nested = mutableListOf<HwpxLine>()
            for (child in cell.children()) visit(child, paragraphs, nested)
            return HwpxCell(paragraphs, nested)
        }

        private fun ownText(paragraph: Element): String = buildString {
            for (run in paragraph.children("run")) for (text in run.children("t")) append(text.textContent)
        }.trim()

        private fun Element.isHp(name: String) = namespaceURI == HP && localName == name
        private fun Element.children(name: String? = null): List<Element> = buildList {
            for (i in 0 until childNodes.length) {
                val child = childNodes.item(i) as? Element ?: continue
                if (name == null || child.isHp(name)) add(child)
            }
        }
    }

    private const val HP = "http://www.hancom.co.kr/hwpml/2011/paragraph"
    /** 이 길이를 넘는 표 행은 칸마다 한 줄로 씁니다. 긴 칸 여러 개를 한 줄로 이으면 읽기 어려워집니다. */
    private const val LONG_ROW = 250
    private val SYMBOL_ONLY = Regex("^[^\\p{L}\\p{N}]{1,2}$")
    private val NUMBER_BOX = Regex("^(?:[1-9]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ])\\.?$")
    private val SHORT_TITLE = Regex("^[가-힣A-Za-z][가-힣A-Za-z·,()\\s]{0,11}$")
    private val SYLLABLE = Regex("^[가-힣]$")
    /** 줄 끝에 홀로 남아도 낱말이 끝난 것으로 보는 흔한 토씨·어미입니다. */
    private val WORD_END = Regex("(?:에게|에서|으로|로서|로써|부터|까지|에는|에도|하여|하고|하며|하는|되는|있는|없는|이며|이고|따라|위해|위한|대한|관한|통해|의한)$")
    private val STANDALONE_WORDS = setOf("및", "또는", "혹은", "그리고", "또한", "단", "다만")
    private val HANGUL_WORD = Regex("^[가-힣]{2,}$")
    private val ATTACHMENT_LABEL = Regex("^[\\[【<〔(]?(?:붙임|별첨|별지|참고|서식|첨부)\\s?(?:제?\\s?\\d{1,2}(?:-\\d{1,2})?\\s?호?)?[\\]】>〕)]?$")
    private val PAGE_NUMBER = Regex("^(?:(?:[-–]\\s*\\d{1,3}\\s*[-–]\\s*){1,2}|\\d{1,3}\\s*/\\s*\\d{1,3}|\\(?\\d{1,3}\\s*쪽\\s*중\\s*\\d{1,3}\\s*쪽\\)?|[-–]\\s*[ivxIVX]{1,5}\\s*[-–])$")
    private val BARE_PAGE_NUMBER = Regex("^(?:\\d{1,3}|[ivxIVX]{1,5})$")
    private val ITEM_START = Regex(
        "^(?:[□▢■❏☑◦○〇❍●•⦁∘￭▸▶▪ㆍ·\\-–※*✽＊♣➡↓☞➜⇨‣․◆◇▷▶►]|[①-⑳❶-❿➀-➓㉑-㉟]|\\d{1,2}[.)](?!\\d)|[가-하][.)]|\\(\\d{1,2}\\)|[ㅇo]\\s|[lmnquv§]\\s+[가-힣(「]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|제\\s?\\d{1,2}\\s?장)",
    )
    private val SENTENCE_END = Regex("(?:다|함|음|임|됨|요|것|람|니다|시오|까|기재|작성|제출|참고|요망|가능|불가|필수|금지|제외|처리|예정)[.)\\]」』]?$|[:;!?。]$|(?<!\\d)\\.$")
    /** 줄 끝에 홀로 남아도 낱말인 한 음절입니다. 이 글자로 끝난 줄은 낱말 중간에서 끊긴 것으로 보지 않습니다. */
    private val STANDALONE_SYLLABLES = setOf(
        "및", "등", "시", "수", "중", "단", "각", "총", "약", "또", "더", "안", "내", "외", "후", "전", "간", "위", "것", "분", "때", "곳", "점",
        "개", "명", "원", "건", "년", "월", "일", "회", "차", "장", "호", "조", "항", "그", "이", "저", "본", "해", "동", "타", "당", "만", "즉",
        "할", "될", "한", "된", "의", "를", "을", "은", "는", "가", "와", "과", "에", "로", "도", "곧", "다", "못", "잘", "꼭", "참", "제", "급",
    )
}
