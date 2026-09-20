"""One explicit full-search probe. No retries; at most one embedding and one ranking call."""
import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

BODY = {"query": "사업화 지원금", "acceptingOnly": True, "companyConditions": {
    "region": "서울", "industry": "SW", "establishedOn": None, "supportPurpose": "지원금"}}


def run(output, execute):
    if not execute:
        print(json.dumps({"execute": False, "maximumEmbeddingCalls": 1, "maximumRankingCalls": 1}))
        return 0
    import httpx

    output.mkdir(parents=True, exist_ok=False)
    record = {"caseId": "V5_SOL_FINAL_SEOUL", "request": BODY,
              "startedAt": datetime.now(timezone.utc).isoformat(), "status": "started",
              "requestSha256": hashlib.sha256(json.dumps(BODY, ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
              "retries": 0, "maximumOpenAiCalls": 2,
              "limitation": "Current-date public search diagnostic, not a frozen-candidate comparison or full-catalog metric."}

    def save():
        (output / "capture.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    save()
    start = time.monotonic()
    code = 1
    try:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=90) as client:
            response = client.post("http://127.0.0.1:8080/api/v1/support-programs/search", json=BODY)
        record.update(httpStatus=response.status_code, elapsedSeconds=round(time.monotonic() - start, 3))
        record["response"] = response.json()
        save()
        response.raise_for_status()
        programs = record["response"]["programs"]
        ids = [item["sourceCode"] + ":" + item["id"] for item in programs]
        assert len(ids) == len(set(ids)) and len(ids) <= 5
        assert all(type(item["recommendationScore"]) is int and 0 <= item["recommendationScore"] <= 100 for item in programs)
        expected = "BIZINFO:PBLN_000000000125611"
        excluded = {"BIZINFO:PBLN_000000000125900", "BIZINFO:PBLN_000000000124940", "BIZINFO:PBLN_000000000125046", "BIZINFO:PBLN_000000000126004"}
        record["targetedChecks"] = {"knownSupportedProgramRetained": expected in ids,
                                     "knownUnrelatedOrRegionConflictingProgramsAbsent": not (set(ids) & excluded)}
        record["status"] = "completed"
        code = 0 if all(record["targetedChecks"].values()) else 2
    except Exception as error:
        record.update(status="failed", errorType=type(error).__name__)
    finally:
        record["finishedAt"] = datetime.now(timezone.utc).isoformat()
        save()
    print(json.dumps({"status": record["status"], "httpStatus": record.get("httpStatus"),
                      "elapsedSeconds": record.get("elapsedSeconds"), "targetedChecks": record.get("targetedChecks")}))
    return code


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raise SystemExit(run(args.output, args.execute))
