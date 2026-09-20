import contextlib
import csv
import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


REVIEW_DIR = Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, REVIEW_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


POOL = load_module("review_pool_tool", "build-review-pool.py")
LABELS = load_module("review_label_tool", "apply-labels.py")


def hash_text(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return str(path)


def call_main(module, args):
    original = module.parse_args
    module.parse_args = lambda: args
    try:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            module.main()
        return output.getvalue()
    finally:
        module.parse_args = original


def create_scenario(root):
    texts = {
        "SYNTHETIC:1": "제목: 알파 지원 1\n기관: 기관1\n지원대상: 기업\n분야: 기술\n지역: 전국\n신청기간: 상시\n내용: 알파 사업",
        "SYNTHETIC:2": "제목: 알파 지원 2\n기관: 기관2\n지원대상: 기업\n분야: 경영\n지역: 전국\n신청기간: 상시\n내용: 알파 대체 사업",
        "SYNTHETIC:3": "제목: 감마 지원\n기관: 기관3\n지원대상: 기업\n분야: 수출\n지역: 전국\n신청기간: 상시\n내용: 감마 사업",
    }
    docs = [
        {
            "id": identifier,
            "text": text,
            "contentHash": hash_text(text),
            "sortTimestamp": f"2026-09-0{index}T00:00:00Z",
        }
        for index, (identifier, text) in enumerate(texts.items(), start=1)
    ]
    catalog = {
        "presentProgramCount": len(docs),
        "eligibleProgramCount": len(docs),
        "eligibleCatalogFingerprint": hash_text(
            "\n".join(sorted(f"{doc['id']}:{doc['contentHash']}" for doc in docs))
        ),
    }
    queries = [
        {"id": "Q01", "query": "알파", "split": "dev"},
        {"id": "Q02", "query": "베타", "split": "dev"},
        {"id": "Q03", "query": "감마", "split": "heldout"},
    ]
    fixture = {
        "name": "synthetic-review",
        "dataType": "synthetic",
        "referenceDate": "2026-09-06",
        "catalog": catalog,
        "docs": docs,
        "cases": [],
    }
    query_set = {
        "schemaVersion": "support-program-search-query-set-v1",
        "name": fixture["name"],
        "queries": queries,
    }
    config = {
        "schemaVersion": "support-program-review-pool-config-v1",
        "querySetName": fixture["name"],
        "keywordLimit": 10,
        "broadLimit": 10,
        "broadTieLimit": 20,
        "queries": [
            {
                "id": "Q01",
                "expectedOutcome": "match",
                "expectedExampleIds": ["SYNTHETIC:1"],
                "regionTerms": [],
                "targetTerms": [],
                "intentGroups": [["알파"]],
            },
            {
                "id": "Q02",
                "expectedOutcome": "no_match",
                "expectedExampleIds": [],
                "regionTerms": [],
                "targetTerms": [],
                "intentGroups": [["베타"]],
            },
            {
                "id": "Q03",
                "expectedOutcome": "match",
                "expectedExampleIds": ["SYNTHETIC:3"],
                "regionTerms": [],
                "targetTerms": [],
                "intentGroups": [["감마"]],
            },
        ],
    }
    capture = {
        "schemaVersion": "support-program-search-capture-v2",
        "querySet": {"name": fixture["name"], "sha256": POOL.query_set_sha256(queries)},
        "capturedAt": "2026-09-06T00:00:00Z",
        "referenceDate": fixture["referenceDate"],
        "acceptingOnly": True,
        "catalog": catalog,
        "search": {
            "candidateLimit": 20,
            "finalResultLimit": 5,
            "scoringVersion": "synthetic-test",
        },
        "observations": [
            {**queries[0], "candidateIds": ["SYNTHETIC:1", "SYNTHETIC:2"], "finalProgramIds": ["SYNTHETIC:2"]},
            {**queries[1], "candidateIds": ["SYNTHETIC:2"], "finalProgramIds": []},
            {**queries[2], "candidateIds": ["SYNTHETIC:3"], "finalProgramIds": []},
        ],
    }
    paths = {
        "fixture": write_json(root / "fixture.json", fixture),
        "query_set": write_json(root / "query-set.json", query_set),
        "config": write_json(root / "config.json", config),
        "capture": write_json(root / "capture.json", capture),
    }
    return SimpleNamespace(root=root, capture=capture, paths=paths)


def build_pool(scenario, name="pool", previous_review=None, capture=None):
    root = scenario.root / name
    args = SimpleNamespace(
        fixture=scenario.paths["fixture"],
        query_set=scenario.paths["query_set"],
        config=scenario.paths["config"],
        capture=capture if capture is not None else scenario.paths["capture"],
        previous_review=previous_review,
        review_pool=str(root / "review.csv"),
        provenance=str(root / "provenance.csv"),
        pool_manifest=str(root / "manifest.json"),
    )
    call_main(POOL, args)
    return args


def read_rows(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as file:
        return list(csv.DictReader(file))


def write_rows(path, rows):
    with Path(path).open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=POOL.REVIEW_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def fill_review(path, decisions, leave_blank=()):
    rows = read_rows(path)
    for row in rows:
        if row["query_id"] in leave_blank:
            continue
        decision = decisions.get((row["query_id"], row["program_id"]), "irrelevant")
        row["decision"] = decision
        row["reason"] = "판정 근거" if decision in {"relevant", "unclear"} else ""
        row["reviewer"] = "검토자"
    write_rows(path, rows)


def label_args(scenario, pool_args, output, exclusions=()):
    return SimpleNamespace(
        fixture=scenario.paths["fixture"],
        query_set=scenario.paths["query_set"],
        config=scenario.paths["config"],
        capture=scenario.paths["capture"],
        pool_manifest=pool_args.pool_manifest,
        review_pool=pool_args.review_pool,
        exclude_query=list(exclusions),
        output=str(output),
    )


class ReviewToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.scenario = create_scenario(Path(self.temp_directory.name))

    def tearDown(self):
        self.temp_directory.cleanup()

    def test_human_judgment_warnings_and_explicit_exclusion(self):
        pool_args = build_pool(self.scenario)
        fill_review(
            pool_args.review_pool,
            {
                ("Q01", "SYNTHETIC:2"): "relevant",
                ("Q02", "SYNTHETIC:2"): "relevant",
            },
            leave_blank={"Q03"},
        )
        output = self.scenario.root / "labeled.json"
        stdout = call_main(
            LABELS,
            label_args(self.scenario, pool_args, output, ["Q03=공고 내용만으로 판정 불가"]),
        )
        labeled = json.loads(output.read_text(encoding="utf-8"))
        cases = {case["id"]: case for case in labeled["cases"]}
        self.assertEqual(["SYNTHETIC:2"], cases["Q01"]["relevantIds"])
        self.assertEqual(["SYNTHETIC:2"], cases["Q02"]["relevantIds"])
        self.assertIsNone(cases["Q03"]["relevantIds"])
        self.assertEqual(
            [{"id": "Q03", "reason": "공고 내용만으로 판정 불가"}],
            labeled["labelReview"]["excludedQueries"],
        )
        self.assertEqual(
            {"EXPECTED_EXAMPLES_NOT_RELEVANT", "EXPECTED_NO_MATCH_WITH_RELEVANT"},
            {item["code"] for item in labeled["labelReview"]["warnings"]},
        )
        self.assertEqual(
            LABELS.sha256_path(self.scenario.paths["capture"]),
            labeled["labelReview"]["sourceHashes"]["captureSha256"],
        )
        summary = json.loads(stdout)
        self.assertEqual((2, 1, 2, 2), (
            summary["labeledQueryCount"],
            summary["excludedQueryCount"],
            summary["relevantLabelCount"],
            summary["warningCount"],
        ))

    def test_unexcluded_unclear_still_fails(self):
        pool_args = build_pool(self.scenario)
        fill_review(
            pool_args.review_pool,
            {
                ("Q01", "SYNTHETIC:1"): "unclear",
                ("Q03", "SYNTHETIC:3"): "relevant",
            },
        )
        with self.assertRaisesRegex(ValueError, "explicitly exclude"):
            call_main(LABELS, label_args(self.scenario, pool_args, self.scenario.root / "labeled.json"))

    def test_invalid_exclusions_are_rejected(self):
        cases = [
            (["UNKNOWN=이유"], "Unknown"),
            (["Q01=이유", "Q01=다른 이유"], "Duplicate"),
            (["Q01="], "nonempty reason"),
            (["Q01=이유", "Q02=이유", "Q03=이유"], "At least one"),
        ]
        for values, message in cases:
            with self.subTest(values=values):
                with self.assertRaisesRegex(ValueError, message):
                    LABELS.parse_exclusions(values, {"Q01", "Q02", "Q03"})

    def test_existing_and_duplicate_output_paths_are_rejected_before_writing(self):
        existing = self.scenario.root / "existing.csv"
        existing.write_text("keep", encoding="utf-8")
        args = SimpleNamespace(
            fixture=self.scenario.paths["fixture"],
            query_set=self.scenario.paths["query_set"],
            config=self.scenario.paths["config"],
            capture=self.scenario.paths["capture"],
            previous_review=None,
            review_pool=str(existing),
            provenance=str(self.scenario.root / "new-provenance.csv"),
            pool_manifest=str(self.scenario.root / "new-manifest.json"),
        )
        with self.assertRaises(FileExistsError):
            call_main(POOL, args)
        self.assertEqual("keep", existing.read_text(encoding="utf-8"))
        self.assertFalse(Path(args.provenance).exists())
        args.review_pool = str(self.scenario.root / "duplicate.csv")
        args.provenance = args.review_pool
        with self.assertRaisesRegex(ValueError, "distinct"):
            call_main(POOL, args)

    def test_apply_labels_never_overwrites_output(self):
        pool_args = build_pool(self.scenario)
        output = self.scenario.root / "labeled.json"
        output.write_text("keep", encoding="utf-8")
        with self.assertRaises(FileExistsError):
            call_main(LABELS, label_args(self.scenario, pool_args, output))
        self.assertEqual("keep", output.read_text(encoding="utf-8"))

    def test_matching_previous_review_is_carried_to_new_output(self):
        first = build_pool(self.scenario, "first")
        fill_review(first.review_pool, {("Q01", "SYNTHETIC:1"): "relevant"})
        second = build_pool(self.scenario, "second", previous_review=first.review_pool)
        carried = {(row["query_id"], row["program_id"]): row for row in read_rows(second.review_pool)}
        self.assertEqual("relevant", carried[("Q01", "SYNTHETIC:1")]["decision"])
        self.assertEqual("검토자", carried[("Q01", "SYNTHETIC:1")]["reviewer"])

    def test_changed_or_vanished_previous_judgment_is_rejected(self):
        first = build_pool(self.scenario, "first")
        rows = read_rows(first.review_pool)
        changed = [dict(row) for row in rows]
        changed[0]["title"] = "변경된 제목"
        changed_path = self.scenario.root / "changed.csv"
        write_rows(changed_path, changed)
        with self.assertRaisesRegex(ValueError, "does not match"):
            build_pool(self.scenario, "changed-output", previous_review=str(changed_path))

        vanished = [dict(row) for row in rows]
        extra = dict(next(row for row in rows if row["query_id"] == "Q03"))
        extra.update(query_id="Q02", query="베타", decision="irrelevant", reviewer="검토자")
        vanished.append(extra)
        vanished_path = self.scenario.root / "vanished.csv"
        write_rows(vanished_path, vanished)
        with self.assertRaisesRegex(ValueError, "disappeared"):
            build_pool(self.scenario, "vanished-output", previous_review=str(vanished_path))

    def test_full_capture_validation_and_capture_hash_are_enforced(self):
        invalid_capture = dict(self.scenario.capture)
        invalid_capture["search"] = {"candidateLimit": 20, "finalResultLimit": 5}
        invalid_path = write_json(self.scenario.root / "invalid-capture.json", invalid_capture)
        with self.assertRaisesRegex(ValueError, "scoringVersion"):
            build_pool(self.scenario, "invalid", capture=invalid_path)

        pool_args = build_pool(self.scenario, "valid")
        fill_review(
            pool_args.review_pool,
            {("Q01", "SYNTHETIC:1"): "relevant", ("Q03", "SYNTHETIC:3"): "relevant"},
        )
        self.scenario.capture["capturedAt"] = "2026-09-07T00:00:00Z"
        write_json(Path(self.scenario.paths["capture"]), self.scenario.capture)
        with self.assertRaisesRegex(ValueError, "hash does not match"):
            call_main(LABELS, label_args(self.scenario, pool_args, self.scenario.root / "labeled.json"))

    def test_deleted_review_row_is_rejected(self):
        pool_args = build_pool(self.scenario)
        rows = read_rows(pool_args.review_pool)
        write_rows(pool_args.review_pool, rows[1:])
        with self.assertRaisesRegex(ValueError, "added or deleted"):
            call_main(LABELS, label_args(self.scenario, pool_args, self.scenario.root / "labeled.json"))


if __name__ == "__main__":
    unittest.main()
