import asyncio
import base64
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from zipfile import ZipFile
from xml.etree import ElementTree as ET

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.application_preparation.docx_adapter import DocxDocumentAdapter, W, W14
from app.application_preparation.agent import ApplicationPreparationAgent
from app.application_preparation.document_contract import (
    DocumentError, EditOperation, GenerateDocumentRequest, MapDocumentRequest, MappingSelection, PlanSelection,
    digest, validate_plan,
)


def docx(*, merged=False, control=False, checkbox=False, mixed=False, printed_choice=False, ignorable=False,
         unsafe_tag=None, multiple_paragraphs=False, signed=False, empty_styled=False):
    span = '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' if merged else ''
    answer = ('<w:r><w:rPr><w:b/></w:rPr><w:t>__</w:t></w:r>'
              '<w:r><w:rPr><w:i/></w:rPr><w:t>__</w:t></w:r>') if mixed else '<w:r><w:rPr><w:b/></w:rPr><w:t>____</w:t></w:r>'
    if unsafe_tag:
        answer += f'<w:r><w:{unsafe_tag}/></w:r>'
    paragraph_properties = ''
    if empty_styled:
        answer = ''
        paragraph_properties = '<w:pPr><w:rPr><w:rFonts w:ascii="Arial"/><w:sz w:val="18"/></w:rPr></w:pPr>'
    extra_paragraph = '<w:p/>' if multiple_paragraphs else ''
    sdt = ('<w:sdt><w:sdtPr><w:alias w:val="담당자"/><w:text/></w:sdtPr>'
           '<w:sdtContent><w:p><w:r><w:t>기존값</w:t></w:r></w:p></w:sdtContent></w:sdt>') if control else ''
    check = ('<w:sdt><w:sdtPr><w:alias w:val="동의"/><w14:checkbox><w14:checked w14:val="0"/>'
             '</w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>') if checkbox else ''
    compatibility = (' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"'
                     ' xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"'
                     ' mc:Ignorable="w16cid"') if ignorable else ''
    xml = (f'<w:document xmlns:w="{W[1:-1]}" xmlns:w14="{W14[1:-1]}"{compatibility}><w:body>'
           '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>신청서</w:t></w:r></w:p>'
           '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tr>'
           f'<w:tc><w:p><w:r><w:t>{"□ 동의 □ 거부" if printed_choice else "기업명"}</w:t></w:r></w:p></w:tc>'
           f'<w:tc>{span}<w:p>{paragraph_properties}{answer}</w:p>{extra_paragraph}</w:tc></w:tr></w:tbl>{sdt}{check}'
           '</w:body></w:document>')
    content_types = ('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                     '<Override PartName="/word/document.xml" '
                     'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                     '</Types>')
    data = BytesIO()
    with ZipFile(data, 'w') as archive:
        archive.writestr('[Content_Types].xml', content_types)
        archive.writestr('word/document.xml', xml)
        if signed:
            archive.writestr('_xmlsignatures/sig1.xml', '<Signature/>')
    return data.getvalue()


def request(data, value='테스트기업'):
    return GenerateDocumentRequest(sourceBase64=base64.b64encode(data).decode(), sourceSha256=digest(data),
        format='docx', answerRevision=1, facts=[{'id': 'company', 'label': '기업명', 'value': value}], scope='신청서')


def operation(target, kind='replace_range'):
    return EditOperation(targetId=target.targetId, operation=kind, expectedText=target.currentText,
        start=0, end=len(target.currentText), valueRef='company', box=None, reason='검증한 입력칸')


def test_docx_table_write_preserves_style_and_other_targets(tmp_path: Path):
    data = docx()
    path = tmp_path / 'source.docx'
    path.write_bytes(data)
    adapter = DocxDocumentAdapter()
    document = asyncio.run(adapter.inspect(path))
    target = next(t for t in document.targets if t.targetId == 'docx:t:1:r:1:c:2:p:1')
    assert target.editable and target.nativeLocator['fieldLabels'] == ['기업명']
    assert document.sourceSha256 == digest(data)
    plan = validate_plan(request(data), document, PlanSelection(operations=[operation(target)],
        unresolvedTargets=[], scopeTargetIds=[target.targetId]))
    output, verification = asyncio.run(adapter.apply(path, document, plan, {'company': '테스트기업'}))
    assert verification['verified'] == 1
    assert path.read_bytes() == data
    completed = tmp_path / 'completed.docx'
    completed.write_bytes(output)
    reopened = asyncio.run(adapter.inspect(completed))
    assert next(t for t in reopened.targets if t.targetId == target.targetId).currentText == '테스트기업'
    with ZipFile(BytesIO(output)) as archive:
        xml = archive.read('word/document.xml')
    assert b'TableGrid' in xml and b'<ns0:b' in xml


@pytest.mark.parametrize('variant,reason', [('merged', 'MERGED_OR_AMBIGUOUS_CELL'),
                                             ('mixed', 'MERGED_OR_AMBIGUOUS_CELL')])
def test_docx_unsafe_cell_is_not_editable(tmp_path: Path, variant, reason):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(**{variant: True}))
    target = next(t for t in asyncio.run(DocxDocumentAdapter().inspect(path)).targets
                  if t.targetId == 'docx:t:1:r:1:c:2:p:1')
    assert not target.editable and target.unsupportedReason == reason


def test_docx_text_control_and_checkbox_are_addressed(tmp_path: Path):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(control=True, checkbox=True))
    targets = asyncio.run(DocxDocumentAdapter().inspect(path)).targets
    control = next(t for t in targets if t.kind == 'DOCX_CONTROL')
    check = next(t for t in targets if t.kind == 'CHECKBOX')
    assert control.editable and control.nativeLocator['fieldLabels'] == ['담당자']
    assert check.editable and check.currentText == '동의'
    data = path.read_bytes()
    adapter = DocxDocumentAdapter()
    document = asyncio.run(adapter.inspect(path))
    controls = {target.kind: target for target in document.targets if target.kind in {'DOCX_CONTROL', 'CHECKBOX'}}
    text_request = request(data, '홍길동')
    text_op = operation(controls['DOCX_CONTROL'], 'set_field')
    text_plan = validate_plan(text_request, document, PlanSelection(operations=[text_op],
        unresolvedTargets=[], scopeTargetIds=[text_op.targetId]))
    output, result = asyncio.run(adapter.apply(path, document, text_plan, {'company': '홍길동'}))
    assert result['verified'] == 1
    with ZipFile(BytesIO(output)) as archive:
        assert '홍길동' in ''.join(ET.fromstring(archive.read('word/document.xml')).itertext())
    check_request = request(data, '동의')
    check_op = operation(controls['CHECKBOX'], 'set_check')
    check_plan = validate_plan(check_request, document, PlanSelection(operations=[check_op],
        unresolvedTargets=[], scopeTargetIds=[check_op.targetId]))
    checked_output, result = asyncio.run(adapter.apply(path, document, check_plan, {'company': '동의'}))
    assert result['verified'] == 1
    with ZipFile(BytesIO(checked_output)) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
    assert root.find('.//' + W14 + 'checked').get(W14 + 'val') == '1'


def test_docx_rejects_duplicate_zip_entries(tmp_path: Path):
    path = tmp_path / 'source.docx'
    data = BytesIO()
    with ZipFile(data, 'w') as archive:
        archive.writestr('[Content_Types].xml', b'<Types/>')
        archive.writestr('word/document.xml', b'<x/>')
        archive.writestr('word/document.xml', b'<x/>')
    path.write_bytes(data.getvalue())
    with pytest.raises(DocumentError):
        asyncio.run(DocxDocumentAdapter().inspect(path))


def test_printed_checkbox_is_not_a_native_input(tmp_path: Path):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(printed_choice=True))
    target = next(t for t in asyncio.run(DocxDocumentAdapter().inspect(path)).targets
                  if t.targetId == 'docx:t:1:r:1:c:2:p:1')
    assert not target.editable
    assert target.unsupportedReason == 'PRINTED_CHECKBOX_NOT_NATIVE'


def test_docx_write_keeps_namespace_aliases_used_by_compatibility_markup(tmp_path: Path):
    data = docx(ignorable=True)
    path = tmp_path / 'source.docx'
    path.write_bytes(data)
    adapter = DocxDocumentAdapter()
    document = asyncio.run(adapter.inspect(path))
    target = next(t for t in document.targets if t.editable)
    plan = validate_plan(request(data), document, PlanSelection(operations=[operation(target)],
        unresolvedTargets=[], scopeTargetIds=[target.targetId]))
    output, _ = asyncio.run(adapter.apply(path, document, plan, {'company': '테스트기업'}))
    with ZipFile(BytesIO(output)) as archive:
        xml = archive.read('word/document.xml')
    assert b'Ignorable="w16cid"' in xml
    assert b'xmlns:w16cid="http://schemas.microsoft.com/office/word/2016/wordml/cid"' in xml


def test_docx_mapping_context_contains_only_editable_native_leaves(tmp_path: Path):
    data = docx()
    path = tmp_path / 'source.docx'
    path.write_bytes(data)
    document = asyncio.run(DocxDocumentAdapter().inspect(path))
    target = next(t for t in document.targets if t.editable)
    mapping = MapDocumentRequest(sourceBase64=base64.b64encode(data).decode(), sourceSha256=digest(data),
        format='docx', scope='신청서', fields=[{'id': 'company', 'label': '기업명',
        'guidance': '기업명을 입력합니다.', 'required': False}])
    agent = ApplicationPreparationAgent(model=None, run_timeout_seconds=3)
    agent._invoke = AsyncMock(return_value=SimpleNamespace(model_dump=lambda: {
        'bindings': [{'factId': 'company', 'targetId': target.targetId, 'box': None}],
        'scopeTargetIds': [target.targetId], 'unmappedFieldIds': []}))
    asyncio.run(agent.map_document(mapping, document))
    content = agent._invoke.call_args.args[2]
    transmitted = json.loads(content[0]['text'])['documentMap']['targets']
    assert [item['targetId'] for item in transmitted] == [target.targetId]


@pytest.mark.parametrize('tag', ['drawing', 'pict', 'fldChar'])
def test_docx_drawing_and_legacy_field_are_not_editable(tmp_path: Path, tag):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(unsafe_tag=tag))
    target = next(t for t in asyncio.run(DocxDocumentAdapter().inspect(path)).targets
                  if t.targetId == 'docx:t:1:r:1:c:2:p:1')
    assert not target.editable


def test_docx_same_cell_multiple_paragraphs_are_not_input_candidates(tmp_path: Path):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(multiple_paragraphs=True))
    targets = asyncio.run(DocxDocumentAdapter().inspect(path)).targets
    children = [t for t in targets if t.nativeLocator.get('parent') == 'docx:t:1:r:1:c:2']
    assert len(children) == 2 and all(not target.editable for target in children)


def test_docx_signed_package_is_rejected(tmp_path: Path):
    path = tmp_path / 'source.docx'
    path.write_bytes(docx(signed=True))
    with pytest.raises(DocumentError):
        asyncio.run(DocxDocumentAdapter().inspect(path))


def test_docx_http_map_generate_and_output_base64_contract(tmp_path: Path, monkeypatch):
    from app.application_preparation.router import get_service, router

    class Agent:
        async def map_document(self, mapping_request, document):
            target = next(t for t in document.targets if t.editable)
            return MappingSelection(bindings=[{'factId': 'company', 'targetId': target.targetId, 'box': None}],
                scopeTargetIds=[target.targetId], unmappedFieldIds=[])

        async def plan_document(self, generation_request, document):
            target = next(t for t in document.targets if t.editable)
            return PlanSelection(operations=[operation(target)], unresolvedTargets=[], scopeTargetIds=[target.targetId])

    monkeypatch.setenv('DOCUMENT_INTERNAL_TOKEN', 't' * 32)
    application = FastAPI()
    application.include_router(router)
    application.dependency_overrides[get_service] = lambda: SimpleNamespace(agent=Agent())
    data = docx(ignorable=True)
    generation = request(data).model_dump()
    mapping = {**generation, 'facts': [], 'fields': [{'id': 'company', 'label': '기업명',
        'guidance': '기업명을 입력합니다.', 'required': False}]}
    headers = {'Authorization': 'Bearer ' + 't' * 32}
    with TestClient(application) as client:
        configuration = client.get('/internal/v1/application-preparations/document/configuration').json()
        assert configuration['engineVersions']['docx'] == 'govbiz/ooxml-native@2'
        mapped = client.post('/internal/v1/application-preparations/document/map', json=mapping, headers=headers)
        assert mapped.status_code == 200
        generation.update(bindings=mapped.json()['bindings'], scopeTargetIds=mapped.json()['scopeTargetIds'])
        response = client.post('/internal/v1/application-preparations/document/generate', json=generation, headers=headers)
    assert response.status_code == 200
    result = response.json()
    output = base64.b64decode(result['outputBase64'], validate=True)
    assert result['sourceSha256'] == digest(data) and result['outputSha256'] == digest(output)
    path = tmp_path / 'completed.docx'
    path.write_bytes(output)
    assert any(target.currentText == '테스트기업' for target in asyncio.run(DocxDocumentAdapter().inspect(path)).targets)


def test_empty_docx_input_inherits_its_paragraph_character_style(tmp_path: Path):
    data = docx(empty_styled=True)
    path = tmp_path / 'source.docx'
    path.write_bytes(data)
    adapter = DocxDocumentAdapter()
    document = asyncio.run(adapter.inspect(path))
    target = next(t for t in document.targets if t.editable)
    plan = validate_plan(request(data), document, PlanSelection(operations=[operation(target, 'input')],
        unresolvedTargets=[], scopeTargetIds=[target.targetId]))
    output, _ = asyncio.run(adapter.apply(path, document, plan, {'company': '테스트기업'}))
    with ZipFile(BytesIO(output)) as archive:
        root = ET.fromstring(archive.read('word/document.xml'))
    paragraph = list(root.iter(W + 'tc'))[1].find(W + 'p')
    properties = paragraph.find('./' + W + 'r/' + W + 'rPr')
    assert properties.find(W + 'rFonts').get(W + 'ascii') == 'Arial'
    assert properties.find(W + 'sz').get(W + 'val') == '18'
