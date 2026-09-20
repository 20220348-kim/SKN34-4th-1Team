"""Two explicit identical public-search probes, no retries or condition-interpretation calls."""
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
        print(json.dumps({"execute": False, "maximumSearchRequests": 2,
                          "maximumEmbeddingCalls": 2, "maximumRankingCalls": 2}))
        return 0
    import httpx2

    # This fixed directory is also the durable once-only reservation. Never remove it to retry.
    output = ROOT / "search"
    output.mkdir(exist_ok=False)
    capture = {"startedAt": datetime.now(timezone.utc).isoformat(), "request": BODY,
               "maximumOpenAiCalls": 4, "maximumSearchRequests": 2, "retries": 0,
               "observations": [], "limitation": "Current-date diagnostic, not fixed-catalog Recall or MRR."}

    def save():
        with (output / "capture.json").open("w", encoding="utf-8") as target:
            json.dump(capture, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())

    save()
    with httpx2.Client(trust_env=False, follow_redirects=False, timeout=90) as client:
        for repetition in (1, 2):
            item = {"repetition": repetition, "status": "started"}
            capture["observations"].append(item)
            save()  # Reserve the attempt before the only POST; failures consume it too.
            started = monotonic()
            try:
                response = client.post("http://127.0.0.1:8080/api/v1/support-programs/search", json=BODY)
                item["httpStatus"] = response.status_code
                response.raise_for_status()
                item["response"] = response.json()
                programs = item["response"]["programs"]
                ids = [program["sourceCode"] + ":" + program["id"] for program in programs]
                assert len(ids) == len(set(ids)) and len(ids) <= 5
                assert all(type(program["recommendationScore"]) is int
                           and 0 <= program["recommendationScore"] <= 100 for program in programs)
                item["targetedChecks"] = {
                    "knownSupportedProgramRetained": "BIZINFO:PBLN_000000000125611" in ids,
                    "knownUnrelatedOrRegionConflictsAbsent": not set(ids).intersection({
                        "BIZINFO:PBLN_000000000125900", "BIZINFO:PBLN_000000000124940",
                        "BIZINFO:PBLN_000000000125046", "BIZINFO:PBLN_000000000126004"}),
                }
                item["status"] = "completed"
            except Exception as error:
                item.pop("response", None)
                item.update(status="failed", errorType=type(error).__name__)
            finally:
                item["elapsedSeconds"] = round(monotonic() - started, 3)
                save()
            print(json.dumps({key: value for key, value in item.items() if key != "response"}), flush=True)
    capture["finishedAt"] = datetime.now(timezone.utc).isoformat()
    capture["identicalResponses"] = (
        all(item["status"] == "completed" for item in capture["observations"])
        and capture["observations"][0]["response"] == capture["observations"][1]["response"])
    save()
    return 0 if all(item["status"] == "completed" and all(item["targetedChecks"].values())
                    for item in capture["observations"]) and capture["identicalResponses"] else 2


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    raise SystemExit(run(args.execute))
