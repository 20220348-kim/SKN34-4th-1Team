"""Check that evaluation context remains observed evidence and scoring favors safety."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import sys


EVALUATION_DIR = Path(__file__).resolve().parents[4] / "evaluation/application-document"
sys.path.insert(0, str(EVALUATION_DIR))
spec = importlib.util.spec_from_file_location("evaluate_agent_mapping", EVALUATION_DIR / "evaluate_agent_mapping.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


def test_context_groups_observed_evidence_without_ground_truth():
    target = SimpleNamespace(
        targetId="t1.r1.c2.p2", editable=True,
        nativeLocator={"parent": "t1.r1.c2", "table": 1, "bindingEligible": True,
                       "fieldLabels": ["대표자성명"], "rowLabels": ["대표자성명"],
                       "columnLabels": ["신청서"], "tableHeadings": ["융자신청서"]},
        analysis=SimpleNamespace(sectionPath=["신청서"], semanticSection="신청서",
                                 tableClassification="FORM_TABLE"),
    )
    request = SimpleNamespace(scope="융자신청서", fields=[SimpleNamespace(
        id="representative", label="대표자성명", guidance="")])
    context = evaluation.evidence_for(request, SimpleNamespace(targets=[target]))

    assert context["sectionsAndTables"][0]["table"] == 1
    assert context["sectionsAndTables"][0]["fieldCandidates"][0]["targetId"] == target.targetId
    assert "expectedTargetId" not in str(context)
    assert "sourceCellId" not in str(context)


def test_wrong_increase_blocks_structured_evidence_candidate():
    runs = {"a": {"correct": 6, "wrong": 0, "wrongTargetRate": 0, "productionValidation": "PASS"},
            "b": {"correct": 7, "wrong": 1, "wrongTargetRate": 0.1, "productionValidation": "PASS"}}
    assert evaluation.interpret(runs)["outcome"] == "HOLD_WRONG_TARGET_INCREASE"
