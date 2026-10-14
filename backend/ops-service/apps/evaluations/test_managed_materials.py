from copy import deepcopy
from unittest import TestCase

from .managed_materials import build_snapshot, validate_content, validate_snapshot


def content():
    return {
        "title": "직접 등록 테스트",
        "description": "",
        "documents": [
            {
                "id": "doc-1",
                "title": "가상 공고",
                "source_url": "",
                "chunks": ["가상 공고: 중소기업이 신청할 수 있습니다."],
            }
        ],
        "cases": [
            {
                "id": "Q01",
                "document_id": "doc-1",
                "question": "누가 신청하나요?",
                "expected_status": "ANSWERED",
                "expected_citation_orders": [0],
                "reference_facts": ["중소기업"],
                "forbidden_claims": ["모든 기업"],
                "answer": {
                    "text": "중소기업이 신청할 수 있습니다.",
                    "status": "ANSWERED",
                    "citation_orders": [0],
                },
            }
        ],
    }


class ManagedMaterialValidationTests(TestCase):
    def test_snapshot_is_deterministic_and_discloses_manual_origin(self):
        identifier = "managed-" + "a" * 32 + "-v1"
        snapshot = build_snapshot(content(), identifier)
        self.assertEqual(snapshot, build_snapshot(content(), identifier))
        self.assertEqual(validate_snapshot(snapshot), snapshot)
        self.assertEqual(snapshot["fixture"]["referenceSource"], "admin-authored")
        self.assertEqual(snapshot["fixture"]["dataType"], "admin-provided")
        self.assertEqual(snapshot["capture"]["measurementKind"], "admin-entered-answer")
        self.assertEqual(snapshot["capture"]["modelApiCalls"], 0)
        self.assertIsNone(snapshot["capture"]["promptSha256"])

    def test_draft_can_be_incomplete_but_publish_cannot(self):
        value = {"title": "초안", "description": "", "documents": [], "cases": []}
        self.assertEqual(validate_content(value), value)
        with self.assertRaises(ValueError):
            validate_content(value, publish=True)
        value = content()
        value["cases"][0]["answer"] = None
        validate_content(value)
        with self.assertRaisesRegex(ValueError, "저장 답변"):
            validate_content(value, publish=True)

    def test_invalid_types_and_out_of_range_citations_are_not_accepted(self):
        for field, value in (
            ("document_id", []),
            ("expected_status", []),
            ("expected_citation_orders", [True]),
            ("expected_citation_orders", [1]),
            ("expected_citation_orders", [0, 0]),
            ("reference_facts", []),
        ):
            data = content()
            data["cases"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_content(data, publish=True)
        data = content()
        data["cases"][0]["answer"]["status"] = []
        with self.assertRaises(ValueError):
            validate_content(data, publish=True)

    def test_control_characters_unsafe_links_and_size_limits(self):
        for url in (
            "javascript:alert(1)",
            "https://user:secret@example.com/",
            "https://example.com/a b",
        ):
            data = content()
            data["documents"][0]["source_url"] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_content(data)
        for field, value in (("question", "x" * 501), ("question", "text\x00")):
            data = content()
            data["cases"][0][field] = value
            with self.assertRaises(ValueError):
                validate_content(data)
        data = content()
        data["documents"][0]["chunks"] = ["x" * 12001]
        with self.assertRaises(ValueError):
            validate_content(data)

    def test_duplicate_cases_documents_and_extra_keys_rejected(self):
        for field in ("cases", "documents"):
            data = content()
            data[field].append(deepcopy(data[field][0]))
            with self.assertRaises(ValueError):
                validate_content(data)
        data = content()
        data["file_path"] = "/etc/passwd"
        with self.assertRaises(ValueError):
            validate_content(data)

    def test_abstention_has_no_expected_or_answer_citations(self):
        data = content()
        data["cases"][0]["expected_status"] = "INSUFFICIENT_EVIDENCE"
        with self.assertRaises(ValueError):
            validate_content(data, publish=True)
        data["cases"][0]["expected_citation_orders"] = []
        data["cases"][0]["answer"]["status"] = "INSUFFICIENT_EVIDENCE"
        with self.assertRaises(ValueError):
            validate_content(data, publish=True)
        data["cases"][0]["answer"]["citation_orders"] = []
        validate_content(data, publish=True)
