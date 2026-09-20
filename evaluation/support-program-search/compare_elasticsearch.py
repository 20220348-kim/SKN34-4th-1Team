#!/usr/bin/env python3
"""Compare lexical candidates on a fixed snapshot; no model calls or production writes."""

import argparse
import hashlib
import json
import math
import statistics
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from evaluate import (
    _validate_capture_fixture,
    baseline_results,
    evaluate_results,
    label_reference_report,
    load_fixture,
    query_set_sha256,
    validate_results,
)


ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "elasticsearch" / "index.json"
VERSION = "9.5.3"
CLUSTER = "govbiz-es-lexical-experiment"
SCHEMA = "support-program-lexical-comparison-v1"
FIELDS = {"standard_bm25": "text", "nori_bm25": "text.nori"}
ANALYZE_TEXTS = ["서울에서 창업지원을 받고 싶어요", "중소기업의 사업화 지원", "AI 인공지능"]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Experiment HTTP redirects are not allowed")


class LocalElasticsearch:
    def __init__(self, endpoint):
        parsed = urllib.parse.urlsplit(endpoint)
        if (
            parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or parsed.port is None or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        ):
            raise ValueError("Use a literal http://127.0.0.1:PORT experiment endpoint without credentials")
        self.endpoint = endpoint.rstrip("/")
        # Never send local fixture text through environment-configured HTTP proxies.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, method, path, body=None):
        payload = body if isinstance(body, bytes) else (
            json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        )
        request = urllib.request.Request(
            self.endpoint + path, data=payload, method=method,
            headers={"Content-Type": "application/x-ndjson" if isinstance(body, bytes) else "application/json"},
        )
        with self.opener.open(request, timeout=30) as response:
            return json.load(response)

    def verify_cluster(self):
        info = self.request("GET", "/")
        if info.get("cluster_name") != CLUSTER or info.get("version", {}).get("number") != VERSION:
            raise ValueError(f"Only the isolated {CLUSTER} cluster at version {VERSION} is allowed")
        nodes = self.request("GET", "/_nodes/plugins")["nodes"].values()
        if not nodes or any(
            not any(plugin["name"] == "analysis-nori" and plugin["version"] == VERSION for plugin in node["plugins"])
            for node in nodes
        ):
            raise ValueError("Every experiment node must have the pinned analysis-nori plugin")
        return {"version": info["version"], "clusterName": info["cluster_name"]}


def load_snapshot(path):
    fixture = load_fixture(path)
    # Reuse the capture validator: all text hashes, composite IDs, reference date,
    # catalog count and whole-snapshot fingerprint must agree before HTTP writes.
    _validate_capture_fixture(fixture, fixture.get("catalog"))
    if not fixture["docs"] or not fixture["cases"]:
        raise ValueError("Experiment requires a nonempty fixed catalog and question set")
    return fixture


def check_shards(response):
    shards = response["_shards"]
    if response.get("timed_out", False) or shards["failed"] or shards["successful"] != shards["total"]:
        raise ValueError("Elasticsearch returned a timed-out or partial result")


def index_snapshot(client, index, docs, definition):
    created = client.request("PUT", f"/{index}", definition)
    if created.get("acknowledged") is not True or created.get("shards_acknowledged") is not True:
        raise ValueError("Experiment index creation was not fully acknowledged")
    for offset in range(0, len(docs), 250):
        batch = docs[offset:offset + 250]
        lines = []
        for doc in batch:
            # Elasticsearch's _id has a byte limit; preserve canonical source identity in payload.
            identity = hashlib.sha256(doc["id"].encode("utf-8")).hexdigest()
            lines.append(json.dumps({"create": {"_id": identity}}))
            lines.append(json.dumps({
                "id": doc["id"], "contentHash": doc["contentHash"],
                "sortTimestamp": doc["sortTimestamp"], "text": unicodedata.normalize("NFC", doc["text"]),
            }, ensure_ascii=False))
        result = client.request("POST", f"/{index}/_bulk", ("\n".join(lines) + "\n").encode("utf-8"))
        if result.get("errors") is not False or len(result["items"]) != len(batch) or any(
            item["create"].get("status") != 201 for item in result["items"]
        ):
            raise ValueError("Incomplete bulk indexing; do not evaluate partial catalogs")
    check_shards(client.request("POST", f"/{index}/_refresh"))
    count = client.request("GET", f"/{index}/_count")
    check_shards(count)
    if count["count"] != len(docs):
        raise ValueError("Indexed document count does not match the fixed catalog")


def search_body(field, query, k):
    return {
        "size": k, "track_total_hits": True, "_source": ["id", "contentHash"],
        "query": {"match": {field: {
            "query": unicodedata.normalize("NFC", query), "operator": "or", "zero_terms_query": "none",
        }}},
        "sort": [{"_score": "desc"}, {"sortTimestamp": "desc"}, {"id": "asc"}],
    }


def search(client, index, field, query, k, known_hashes):
    started = time.perf_counter()
    result = client.request("POST", f"/{index}/_search?request_cache=false&allow_partial_search_results=false", search_body(field, query, k))
    elapsed = (time.perf_counter() - started) * 1000
    check_shards(result)
    hits = result["hits"]["hits"]
    ids = [hit["_source"]["id"] for hit in hits]
    total = result["hits"]["total"]
    if total["relation"] != "eq" or len(ids) != min(k, total["value"]) or len(set(ids)) != len(ids):
        raise ValueError("Incomplete or duplicate candidate results")
    for hit in hits:
        source, score = hit["_source"], hit["_score"]
        if source["id"] not in known_hashes or source["contentHash"] != known_hashes[source["id"]]:
            raise ValueError("Candidate identity/content hash does not match this snapshot")
        if not isinstance(score, (int, float)) or not math.isfinite(score) or score < 0:
            raise ValueError("Candidate score must be finite and nonnegative")
    return ids, {"httpMs": elapsed, "elasticsearchTookMs": result["took"]}


def metrics(fixture, candidates, k):
    if set(candidates) != {case["id"] for case in fixture["cases"]}:
        raise ValueError("Capture every question, including unlabeled questions")
    validate_results(candidates, fixture["docs"], fixture["cases"], fixture["cases"])
    if any(len(ids) > k for ids in candidates.values()):
        raise ValueError("Too many candidates")
    return {
        split: evaluate_results(
            [case for case in fixture["cases"] if split == "all" or case["split"] == split], candidates, k,
        ) for split in ("all", "dev", "heldout")
    }


def run_experiment(fixture_path, endpoint, k=20, repeats=3):
    if not 1 <= k <= 100 or not 1 <= repeats <= 10:
        raise ValueError("Require 1 <= k <= 100 and 1 <= repeats <= 10")
    fixture = load_snapshot(fixture_path)
    definition = json.loads(CONFIG.read_text(encoding="utf-8"))
    client = LocalElasticsearch(endpoint)
    engine = client.verify_cluster()
    # No user-selected index names, existing-index writes, aliases or DELETE calls.
    index = "govbiz-lexical-" + uuid.uuid4().hex
    index_snapshot(client, index, fixture["docs"], definition)
    known_hashes = {doc["id"]: doc["contentHash"] for doc in fixture["docs"]}
    _, keyword = baseline_results(fixture["docs"], fixture["cases"], k)
    variants = {"keyword": {"candidateIds": keyword, "metrics": metrics(fixture, keyword, k)}}
    for name in FIELDS:
        variants[name] = {"candidateIds": {}, "firstPassTimings": [], "repeatTimings": []}
    # One first pass, then repeated warm queries. Alternate engine order to reduce order bias.
    for repeat in range(repeats + 1):
        for number, case in enumerate(fixture["cases"]):
            names = list(FIELDS) if (repeat + number) % 2 == 0 else list(reversed(FIELDS))
            for name in names:
                ids, timing = search(client, index, FIELDS[name], case["query"], k, known_hashes)
                variant = variants[name]
                if repeat and ids != variant["candidateIds"][case["id"]]:
                    raise ValueError("Candidate ordering changed between identical repeated searches")
                variant["candidateIds"][case["id"]] = ids
                variant["firstPassTimings" if repeat == 0 else "repeatTimings"].append({
                    "queryId": case["id"], "repeat": repeat, **timing,
                })
    for name in FIELDS:
        variant = variants[name]
        variant["metrics"] = metrics(fixture, variant["candidateIds"], k)
        samples = [item["httpMs"] for item in variant["repeatTimings"]]
        variant["repeatHttpMs"] = {
            "samples": len(samples), "median": statistics.median(samples), "min": min(samples), "max": max(samples),
        }
    analysis = [{
        "text": text,
        **{analyzer: client.request("POST", f"/{index}/_analyze", {"analyzer": analyzer, "text": text})["tokens"]
           for analyzer in ("standard", "korean")},
    } for text in ANALYZE_TEXTS]
    return {
        "schemaVersion": SCHEMA, "status": "complete", "createdAt": datetime.now(timezone.utc).isoformat(),
        "fixture": fixture["name"], "fixtureSha256": hashlib.sha256(Path(fixture_path).read_bytes()).hexdigest(),
        "dataType": fixture["dataType"], "referenceDate": fixture["referenceDate"],
        "catalog": fixture["catalog"], "querySetSha256": query_set_sha256(fixture["cases"]),
        "labelReference": label_reference_report(fixture, fixture["cases"]),
        "engine": engine, "index": index, "indexDefinition": definition,
        "search": {"k": k, "repeats": repeats, "bodies": {
            name: search_body(field, "<query>", k) for name, field in FIELDS.items()
        }},
        "sourceSha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in (
            Path(__file__).resolve(), ROOT / "evaluate.py", CONFIG,
            ROOT / "elasticsearch" / "Dockerfile", ROOT / "elasticsearch" / "compose.yaml",
        )},
        "actualModelApiCalls": 0, "variants": variants, "analysisExamples": analysis,
        "limitations": [
            "Lexical candidates only; not Qdrant, RRF hybrid retrieval, final ranking or end-to-end application latency.",
            "One fixed historical snapshot; source text/eligibility are not refreshed to today's catalog.",
            "Labels are a frozen pooled reference; newly retrieved documents were not adjudicated. Unlabeled queries stay excluded.",
            "No synonym rules, field boosts or structured eligibility filters. Nori does not establish application eligibility.",
            "HTTP timings include local transport/JSON; repeated warm queries are not a load test or cold production latency.",
            "The Python keyword baseline precomputes tokens; no latency comparison against the production Kotlin path is claimed.",
            "Previously inspected dev/heldout split is retained for audit; it is not a fresh blind test set.",
        ],
    }


def verify_report(fixture_path, report):
    """Recompute saved IDs/metrics offline, without asserting that an HTTP capture is authentic."""
    fixture = load_snapshot(fixture_path)
    if report.get("schemaVersion") != SCHEMA or report.get("status") != "complete":
        raise ValueError("Expected a completed lexical comparison report")
    expected = {
        "fixtureSha256": hashlib.sha256(Path(fixture_path).read_bytes()).hexdigest(),
        "catalog": fixture["catalog"], "referenceDate": fixture["referenceDate"],
        "querySetSha256": query_set_sha256(fixture["cases"]),
        "labelReference": label_reference_report(fixture, fixture["cases"]), "actualModelApiCalls": 0,
    }
    if any(report.get(key) != value for key, value in expected.items()):
        raise ValueError("Report snapshot, question or provenance metadata mismatch")
    k = report["search"]["k"]
    if type(k) is not int or not 1 <= k <= 100 or set(report["variants"]) != {"keyword", *FIELDS}:
        raise ValueError("Invalid report search configuration")
    _, keyword = baseline_results(fixture["docs"], fixture["cases"], k)
    if report["variants"]["keyword"]["candidateIds"] != keyword:
        raise ValueError("Saved keyword baseline is not reproducible")
    for variant in report["variants"].values():
        if variant["metrics"] != metrics(fixture, variant["candidateIds"], k):
            raise ValueError("Saved candidate metrics are not reproducible")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:19200")
    parser.add_argument("--k", type=int, default=20)
    parser.add_argument("--repeats", type=int, default=3)
    output = parser.add_mutually_exclusive_group(required=True)
    output.add_argument("--output", type=Path, help="New report path; never overwrite a previous run")
    output.add_argument("--verify-report", type=Path, help="Offline metric recheck; no HTTP calls")
    args = parser.parse_args()
    try:
        if args.verify_report:
            verify_report(args.fixture, json.loads(args.verify_report.read_text(encoding="utf-8")))
            print("Saved candidate metrics verified offline; capture authenticity and label accuracy are not certified.")
            return
        # Reserve before any network operation. A failed run is explicitly marked, never a success report.
        with args.output.open("x", encoding="utf-8") as target:
            try:
                report = run_experiment(args.fixture, args.endpoint, args.k, args.repeats)
            except Exception:
                json.dump({"schemaVersion": SCHEMA, "status": "failed"}, target)
                raise
            json.dump(report, target, ensure_ascii=False, indent=2)
            target.write("\n")
        print(f"Saved lexical candidate comparison: {args.output}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
