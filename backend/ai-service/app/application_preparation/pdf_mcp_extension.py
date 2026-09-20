"""Pinned pdf-edit-mcp with the optional embedded cmap lookup corrected.

Some valid PDF font subsets omit a TrueType cmap and provide /ToUnicode in
the PDF instead. Engine 0.2.0 raises KeyError during OPTIONAL cmap recovery,
discarding its already decoded /ToUnicode. No replacement mapping is invented.
"""
import hashlib
from pathlib import Path


def pdf_blank_regions(segments: list, words: list, width: float, height: float) -> list:
    """Identify bounded empty table cells/bands from real ruled edges and printed words."""
    from itertools import combinations
    horizontal, vertical = {}, {}
    for x0, y0, x1, y1 in segments:
        if abs(y0-y1) < 0.01/height and abs(x0-x1) > 3/width:
            horizontal.setdefault(round(y0, 6), []).append(sorted((x0, x1)))
        elif abs(x0-x1) < 0.01/width and abs(y0-y1) > 3/height:
            vertical.setdefault(round(x0, 6), []).append(sorted((y0, y1)))
    if len(horizontal) > 150 or len(vertical) > 100:
        raise ValueError("PDF_TABLE_GEOMETRY_LIMIT")
    def covered(intervals, start, end, tolerance):
        cursor = start
        for a, b in sorted(intervals):
            if b < cursor-tolerance: continue
            if a > cursor+tolerance: return False
            cursor = max(cursor, b)
            if cursor >= end-tolerance: return True
        return False
    def intersects(a, b):
        return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])
    def bounds(word):
        b = word['box']; return b['x'], b['y'], b['x']+b['width'], b['y']+b['height']
    cells = []
    xs = sorted(x for x in vertical if 0 <= x <= 1)
    for left, right in combinations(xs, 2):
        ys = sorted(y for y in horizontal if 0 <= y <= 1 and covered(horizontal[y], left, right, .8/width))
        for top, bottom in zip(ys, ys[1:]):
            if not (covered(vertical[left], top, bottom, .8/height) and covered(vertical[right], top, bottom, .8/height)): continue
            if any(left < x < right and covered(vertical[x], top, bottom, .8/height) for x in xs): continue
            cell = (left, top, right, bottom)
            contents = [w for w in words if intersects(cell, bounds(w))]
            cells.append((cell, contents))
    cells.sort(key=lambda item: (item[0][1], item[0][0], item[0][3], item[0][2]))
    result = []
    for index, (cell, contents) in enumerate(cells):
        left, top, right, bottom = cell
        candidates = []
        if not contents:
            neighbors = [ws for (a,b,c,d),ws in cells if abs(c-left)<1/width and abs(b-top)<1/height and abs(d-bottom)<1/height]
            labels = [' '.join(w['text'] for w in ws) for ws in neighbors if ws]
            if not labels:
                above = [w for w in words if top-24/height <= bounds(w)[3] <= top and left <= (bounds(w)[0]+bounds(w)[2])/2 <= right]
                labels = [' '.join(w['text'] for w in sorted(above, key=lambda w:(round(bounds(w)[1],2),bounds(w)[0])))] if above else []
            candidates.append(((left+2/width, top+.5/height, right-2/width, bottom-.5/height), labels))
        else:
            lines = []
            for word in sorted(contents, key=lambda w:(bounds(w)[1],bounds(w)[0])):
                box = bounds(word)
                row = next((r for r in lines if abs(bounds(r[0])[1]-box[1]) < 3/height), None)
                if row is None: lines.append([word])
                else: row.append(word)
            if 2 <= len(lines) <= 4:
                centers = [(min(bounds(w)[1] for w in row)+max(bounds(w)[3] for w in row))/2 for row in lines]
                edges = [top]+[(a+b)/2 for a,b in zip(centers,centers[1:])]+[bottom]
                for i,row in enumerate(lines):
                    label = ' '.join(w['text'] for w in sorted(row,key=lambda w:bounds(w)[0]))
                    candidates.append(((max(bounds(w)[2] for w in row)+2/width, edges[i]+.5/height, right-2/width, edges[i+1]-.5/height), [label]))
        for band,(box,labels) in enumerate(candidates):
            a,b,c,d = box
            if not labels or c-a < 18/width or d-b < 10/height: continue
            if any(intersects(box,bounds(word)) for word in words): continue
            result.append({'id':f'cell-{index}-band-{band}', 'labels':labels,
                'box':{'x':a,'y':b,'width':c-a,'height':d-b}})
    return result


def read_pdf_text_regions(pdf_path: str) -> dict:
    """Read printed word bounds in the same cropped, rotated page image coordinates."""
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTChar, LTTextLine, LTCurve, LTRect
    from pdfminer.pdfpage import PDFPage
    path = Path(pdf_path)
    if path.is_symlink() or not 0 < path.stat().st_size <= 32 * 1024 * 1024:
        raise ValueError("PDF_GEOMETRY_SOURCE_LIMIT")
    with path.open("rb") as stream:
        pages = list(PDFPage.get_pages(stream))
    if not 1 <= len(pages) <= 50:
        raise ValueError("PDF_GEOMETRY_PAGE_LIMIT")
    result, count = [], 0
    def lines(node):
        if isinstance(node, LTTextLine):
            yield node
        else:
            for child in getattr(node, "_objs", []):
                yield from lines(child)
    for index, layout in enumerate(extract_pages(path)):
        page = pages[index]
        x0, y0, x1, y1 = page.mediabox
        rotation = page.rotate % 360
        if rotation not in (0, 90, 180, 270):
            raise ValueError("PDF_GEOMETRY_ROTATION")
        def transform(x, y):
            if rotation == 90: return y - y0, x1 - x
            if rotation == 180: return x1 - x, y1 - y
            if rotation == 270: return y1 - y, x - x0
            return x - x0, y - y0
        cx0, cy0, cx1, cy1 = page.cropbox
        corners = [transform(x, y) for x in (cx0, cx1) for y in (cy0, cy1)]
        left, bottom = min(x for x, y in corners), min(y for x, y in corners)
        right, top = max(x for x, y in corners), max(y for x, y in corners)
        if right <= left or top <= bottom:
            raise ValueError("PDF_GEOMETRY_CROP")
        regions = []
        def append(chars):
            if not chars: return
            a, b = max(left, min(c.x0 for c in chars)), max(bottom, min(c.y0 for c in chars))
            c, d = min(right, max(c.x1 for c in chars)), min(top, max(c.y1 for c in chars))
            if c > a and d > b:
                regions.append({"text": "".join(c.get_text() for c in chars), "box": {
                    "x": (a-left)/(right-left), "y": (top-d)/(top-bottom),
                    "width": (c-a)/(right-left), "height": (d-b)/(top-bottom)}})
        for line in lines(layout):
            word = []
            for char in line:
                if not isinstance(char, LTChar) or not char.get_text().strip():
                    append(word); word = []; continue
                if word and (char.x0-word[-1].x1 > max(char.height, word[-1].height)*0.35 or
                             abs(char.y0-word[-1].y0) > max(char.height, word[-1].height)*0.2):
                    append(word); word = []
                word.append(char)
            append(word)
        count += len(regions)
        if count > 10000:
            raise ValueError("PDF_GEOMETRY_REGION_LIMIT")
        segments = []
        def curves(node):
            if isinstance(node, LTCurve):
                points = list(node.pts)
                if isinstance(node, LTRect): points += points[:1]
                for (a,b),(c,d) in zip(points,points[1:]):
                    segments.append(((a-left)/(right-left),(top-b)/(top-bottom),(c-left)/(right-left),(top-d)/(top-bottom)))
            for child in getattr(node, '_objs', []): curves(child)
        curves(layout)
        result.append({"page": index, "regions": regions,
            "blankRegions": pdf_blank_regions(segments, regions, right-left, top-bottom)})
    if len(result) != len(pages):
        raise ValueError("PDF_GEOMETRY_PAGE_MISMATCH")
    return {"page_count": len(pages), "pages": result}


def verify_whole_text_object_deletion(source_path: str, output_path: str, expected_text: str) -> dict:
    import pikepdf
    import pdf_edit_engine as engine
    from pdf_edit_engine.locator import ContentStreamInterpreter
    from pdf_edit_engine._pathutil import read_stream_bounded

    source, output = Path(source_path), Path(output_path)
    if source.is_symlink() or output.is_symlink() or source.resolve().parent != output.resolve().parent or source.resolve() == output.resolve():
        return {"verified": False, "reason": "PATH"}
    if any(not 0 < p.stat().st_size <= 32 * 1024 * 1024 for p in (source, output)):
        return {"verified": False, "reason": "SIZE"}

    def empty_show(instruction):
        if str(instruction.operator) == "Tj":
            return len(instruction.operands) == 1 and bytes(instruction.operands[0]) == b""
        if str(instruction.operator) == "TJ":
            return not any(bytes(item) for item in instruction.operands[0] if isinstance(item, pikepdf.String))
        return False

    matches = engine.find(str(source), expected_text)
    if len(matches) != 1:
        return {"verified": False, "reason": "SOURCE_SELECTION"}
    def character_id(page, char):
        return (page, char.operator_index, char.byte_position, char.tj_fragment_index, char.unicode_char)
    selected = {character_id(matches[0].page_number, char) for char in matches[0].characters}
    deleted = set()
    changed_blocks, retained_blocks = set(), set()
    with pikepdf.open(source) as before, pikepdf.open(output) as after:
        if len(before.pages) != len(after.pages):
            return {"verified": False, "reason": "PAGE_COUNT"}

        def inherited(page, key):
            node = page.obj
            for _ in range(64):
                value = node.get(key)
                if value is not None:
                    return value.unparse()
                node = node.get("/Parent")
                if node is None:
                    return None
            raise ValueError("Page tree limit")

        def resource_streams(pdf):
            contents = set()
            for page in pdf.pages:
                value = page.obj.get("/Contents")
                if isinstance(value, pikepdf.Stream):
                    contents.add(value.objgen)
                elif isinstance(value, pikepdf.Array):
                    contents.update(item.objgen for item in value)
            return sorted(hashlib.sha256(read_stream_bounded(obj, max_decoded=32 * 1024 * 1024, label="verification-resource")).hexdigest() for obj in pdf.objects
                          if isinstance(obj, pikepdf.Stream) and obj.objgen not in contents and str(obj.get("/Type")) not in {"/Metadata", "/ObjStm", "/XRef"})

        if resource_streams(before) != resource_streams(after):
            return {"verified": False, "reason": "RESOURCE_STREAMS"}
        for page_index, (a_page, b_page) in enumerate(zip(before.pages, after.pages)):
            if any(inherited(a_page, key) != inherited(b_page, key) for key in ("/MediaBox", "/CropBox", "/Rotate", "/UserUnit")):
                return {"verified": False, "reason": "PAGE_GEOMETRY"}
            a_ops, b_ops = list(pikepdf.parse_content_stream(a_page)), list(pikepdf.parse_content_stream(b_page))
            if len(a_ops) != len(b_ops):
                return {"verified": False, "reason": "OPERATOR_COUNT"}
            block = None
            changed_operators = set()
            for index, (a, b) in enumerate(zip(a_ops, b_ops)):
                op = str(a.operator)
                if op == "BT":
                    block = (page_index, index)
                changed = pikepdf.unparse_content_stream([a]) != pikepdf.unparse_content_stream([b])
                if changed:
                    if op not in {"TJ", "Tj"} or str(b.operator) not in {"TJ", "Tj"} or block is None or not empty_show(b):
                        return {"verified": False, "reason": "TEXT_OBJECT_CHANGE"}
                    changed_blocks.add(block)
                    changed_operators.add(index)
                if str(b.operator) in {"TJ", "Tj", "'", '"'} and not empty_show(b):
                    retained_blocks.add(block)
                if op == "ET":
                    block = None
            if changed_operators:
                for element in ContentStreamInterpreter(a_page, page_index).interpret():
                    for char in element.characters or []:
                        if char.operator_index in changed_operators:
                            deleted.add(character_id(page_index, char))
        # No retained glyph shares a text object with a deletion, and all
        # positioning/graphics operators are byte-equivalent after parsing.
        verified = bool(changed_blocks) and not (changed_blocks & retained_blocks) and deleted == selected
    return {"verified": verified, "changedTextObjects": len(changed_blocks),
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "outputSha256": hashlib.sha256(output.read_bytes()).hexdigest()}


def main():
    import pikepdf
    import pdf_edit_engine.fonts as fonts
    import pdf_edit_engine.locator as locator
    from pdf_edit_mcp.app import mcp
    from pdf_edit_mcp.server import main as serve

    original = fonts.reverse_embedded_cmap

    def reverse(font):
        # The upstream contract defines an empty map when no usable cmap exists.
        # The caller keeps the authoritative PDF /ToUnicode mapping unchanged.
        if "cmap" not in font:
            return {}
        return original(font)

    fonts.reverse_embedded_cmap = reverse
    original_info = locator._build_font_info

    def font_info(font, name):
        base_name = font.get("/BaseFont")
        if base_name is not None:
            try:
                str(base_name)
            except UnicodeDecodeError:
                # Legacy Korean PDF Name bytes need not be UTF-8. Use their
                # lossless PDF lexical escape in DISPLAY metadata only.
                # The source font dictionaries and embedded fonts stay untouched.
                metadata = pikepdf.Dictionary(font)
                metadata["/BaseFont"] = pikepdf.Name(base_name.unparse().decode("ascii"))
                return original_info(metadata, name)
        return original_info(font, name)

    locator._build_font_info = font_info
    def detect_form_inputs(image_paths: list[str]) -> dict:
        import contextlib
        import os
        import sys
        from pdf_form_detection import detect_inputs
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
        # Third-party model status messages must not corrupt the stdio MCP stream.
        with contextlib.redirect_stdout(sys.stderr):
            return detect_inputs(image_paths)

    mcp.tool(name="govbiz_pdf_detect_inputs")(detect_form_inputs)
    mcp.tool(name="govbiz_pdf_text_regions")(read_pdf_text_regions)
    mcp.tool(name="govbiz_verify_pdf_deletion")(verify_whole_text_object_deletion)
    serve()


if __name__ == "__main__":
    main()
