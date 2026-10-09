"""Match completed restored Ops rows to their archived requests and result files."""

import base64
import hashlib
import json
import re
from pathlib import Path
from uuid import UUID

import ops_db_snapshot as database

# These columns exist in the legacy 0017 schema as well as the current schema.
COMPLETED = """
SELECT JSON_OBJECT(
  'id', r.id, 'flow_id', prefect_flow_run_id, 'evaluation_run_id', evaluation_run_id,
  'dataset_id', dataset_id, 'execution_mode', execution_mode,
  'execution_spec', execution_spec, 'execution_spec_sha256', execution_spec_sha256,
  'summary', summary, 'requester_username', u.username, 'requester_active', u.is_active
) FROM evaluations_evaluationrun r LEFT JOIN auth_user u ON u.id=r.requested_by_id
WHERE status='COMPLETED' ORDER BY r.id LIMIT 10001;
"""

SEED = (
    Path(__file__).resolve().parents[3]
    / "backend/ops-service/apps/evaluations/seed/official-v3/seed.json"
)


def shared_review_copy(row, entries):
    """Recognize only the repository's exact, inactive-attributed review copies.

    A missing Prefect run alone is never evidence of an import. The checked-in
    seed excludes Prefect history; authenticate every declared artifact and the
    execution identity before marking that specific external-history scope.
    """
    raw = SEED.read_bytes()
    seed = json.loads(raw)
    if seed["schema_version"] != 2:
        raise ValueError("Unsupported shared review seed")
    if row.get("requester_username") != seed["reviewer"] or row.get("requester_active") != 0:
        return None
    request = str(UUID(row["id"]))
    records = [
        item["fields"]
        for item in seed["records"]
        if item["model"] == "evaluations.evaluationrun" and item["pk"] == request
    ]
    if not records:
        return None
    if len(records) != 1:
        raise ValueError("Repeated shared review identity")
    fields = records[0]
    if (
        fields["status"] != "COMPLETED"
        or str(UUID(fields["prefect_flow_run_id"])) != str(UUID(row["flow_id"]))
        or any(
            fields[key] != row[key]
            for key in (
                "evaluation_run_id",
                "dataset_id",
                "execution_mode",
                "execution_spec",
                "execution_spec_sha256",
                "summary",
            )
        )
    ):
        raise ValueError("Shared review execution differs from its source seed")
    artifacts = [item for item in seed["artifacts"] if item["path"].startswith(request + "/")]
    names = {item["path"] for item in artifacts}
    required = {
        request + "/" + name
        for name in (
            "request.json",
            "evaluation/manifest.json",
            "evaluation/comparison.json",
            "evaluation/report.html",
            "evaluation/results.json",
            "evaluation/evidently.json",
        )
    }
    if len(names) != len(artifacts) or not required.issubset(names):
        raise ValueError("Incomplete shared review artifact manifest")
    for item in artifacts:
        archived = entries[item["path"]]
        content = base64.b64decode(archived["data"], validate=True)
        if (
            archived["kind"] != "file"
            or archived["size"] != len(content)
            or len(content) != item["size"]
            or archived["sha256"] != item["sha256"]
            or hashlib.sha256(content).hexdigest() != item["sha256"]
        ):
            raise ValueError("Shared review artifact differs from its source seed")
    return {
        "seed_id": seed["seed_id"],
        "seed_sha256": hashlib.sha256(raw).hexdigest(),
        "artifacts_verified": len(artifacts),
    }


def completed_evidence(command, entries):
    """Private in-memory evidence from the restored MySQL, never from caller IDs."""
    rows = [json.loads(line) for line in database.query(command, COMPLETED).splitlines()]
    if not rows or len(rows) > 10000:
        raise ValueError("Require 1 to 10000 completed evaluations for linkage verification")
    expected = {}
    flows = set()

    def artifact(request, name):
        row = entries[request + "/" + name]
        if row["kind"] != "file" or not 0 < row["size"] <= 8 * 1024 * 1024:
            raise ValueError("Missing or oversized completed evaluation artifact")
        raw = base64.b64decode(row["data"], validate=True)
        if len(raw) != row["size"] or hashlib.sha256(raw).hexdigest() != row["sha256"]:
            raise ValueError("Completed evaluation artifact integrity differs")
        return raw

    for row in rows:
        request, flow = str(UUID(row["id"])), str(UUID(row["flow_id"]))
        if request in expected or flow in flows:
            raise ValueError("Repeated completed evaluation identity")
        spec = row["execution_spec"]
        spec_hash = row["execution_spec_sha256"]
        evaluation = row["evaluation_run_id"]
        if (
            not isinstance(spec, dict)
            or not spec
            or hashlib.sha256(
                json.dumps(spec, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
            != spec_hash
            or not isinstance(evaluation, str)
            or not re.fullmatch(r"[a-f0-9]{32}", evaluation)
        ):
            raise ValueError("Completed evaluation has no verifiable execution identity")
        marker = json.loads(artifact(request, "request.json"))
        manifest = json.loads(artifact(request, "evaluation/manifest.json"))
        raw = artifact(request, "evaluation/comparison.json")
        comparison = json.loads(raw)
        report = artifact(request, "evaluation/report.html")
        report_hash = hashlib.sha256(report).hexdigest()
        if (
            marker["request_id"] != request
            or marker["prefect_flow_run_id"] != flow
            or marker["dataset_id"] != row["dataset_id"]
            or marker["execution_mode"] != row["execution_mode"]
            or marker["execution_spec"] != spec
            or marker["execution_spec_sha256"] != spec_hash
            or manifest["status"] != "completed"
            or manifest["execution_spec_sha256"] != spec_hash
            or manifest["evaluation_run_id"] != evaluation
            or comparison["evaluation_run_id"] != evaluation
            or comparison["current"]["completed"] is not True
            or comparison["current"] != row["summary"]
            or manifest["artifact_sha256"]["comparison.json"] != hashlib.sha256(raw).hexdigest()
            or manifest["artifact_sha256"]["report.html"] != report_hash
        ):
            raise ValueError("Restored DB and completed result artifacts do not match")
        expected[request] = {"flow_id": flow, "report_sha256": report_hash}
        copy = shared_review_copy(row, entries)
        if copy is not None:
            expected[request]["shared_review_copy"] = copy
        flows.add(flow)
    return expected
