"""One explicit current-catalog search, at most one embedding and one Fast ranking."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic


ROOT = Path(__file__).resolve().parent
BODY = {"query": "사업화 지원금", "acceptingOnly": True, "companyConditions": {
    "region": "서울", "industry": "SW", "establishedOn": None, "supportPurpose": "지원금"}}


def run(execute=False):
    if not execute:
        print(json.dumps({"execute": False, "maximumEmbeddingCalls": 1, "maximumRankingCalls": 1}))
        return 0
    import httpx2

    output = ROOT / "search"
    output.mkdir(exist_ok=False)  # A durable once-only reservation, including failed attempts.
    record = {"status": "started", "startedAt": datetime.now(timezone.utc).isoformat(),
              "request": BODY, "maximumOpenAiCalls": 2, "retries": 0, "requestedRankingTier": "priority"}

    def save():
        with (output / "capture.json").open("w", encoding="utf-8") as target:
            json.dump(record, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())

    save()
    started = monotonic()
    try:
        with httpx2.Client(trust_env=False, follow_redirects=False, timeout=90) as client:
            response = client.post("http://127.0.0.1:8080/api/v1/support-programs/search", json=BODY)
        record["httpStatus"] = response.status_code
        response.raise_for_status()
        body = response.json()
        programs = body["programs"]
        ids = [program["sourceCode"] + ":" + program["id"] for program in programs]
        assert len(ids) == len(set(ids)) and len(ids) <= 5
        assert all(type(program["recommendationScore"]) is int
                   and 0 <= program["recommendationScore"] <= 100 for program in programs)
        record.update(status="completed", response=body, checks={
            "ansanOnlyExcluded": "BIZINFO:PBLN_000000000125900" not in ids,
            "knownNationalProgramRetained": "BIZINFO:PBLN_000000000125611" in ids,
            "personalRegionUnknownProgramRetained": "BIZINFO:PBLN_000000000125748" in ids,
        })
    except Exception as error:
        record.update(status="failed", errorType=type(error).__name__)
    finally:
        record.update(elapsedSeconds=round(monotonic() - started, 3),
                      finishedAt=datetime.now(timezone.utc).isoformat())
        save()
    print(json.dumps({key: record[key] for key in ("status", "httpStatus", "elapsedSeconds", "checks")
                      if key in record}), flush=True)
    return 0 if record["status"] == "completed" and all(record["checks"].values()) else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    raise SystemExit(run(args.execute))
