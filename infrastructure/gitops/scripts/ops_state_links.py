"""Match completed restored Ops rows to their archived requests and result files."""

import base64
import hashlib
import json
import re
from uuid import UUID

import ops_db_snapshot as database

# These columns exist in the legacy 0017 schema as well as the current schema.
COMPLETED = """
SELECT JSON_OBJECT(
  'id', id, 'flow_id', prefect_flow_run_id, 'evaluation_run_id', evaluation_run_id,
  'dataset_id', dataset_id, 'execution_mode', execution_mode,
  'execution_spec', execution_spec, 'execution_spec_sha256', execution_spec_sha256,
  'summary', summary
) FROM evaluations_evaluationrun WHERE status='COMPLETED' ORDER BY id LIMIT 10001;
"""


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
        flows.add(flow)
    return expected
