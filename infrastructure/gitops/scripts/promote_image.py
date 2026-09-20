"""Preview/apply one reviewed image receipt to an existing non-local Helm values file.

This edits configuration only: it never commits, pushes, authenticates or contacts a cluster.
The caller must verify the successful source workflow and receipt before promotion.
"""

import argparse
import copy
import difflib
import json
from pathlib import Path
import re
import sys

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "release"))
from repository import from_origin  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")


class UniqueLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if key in result:
            raise ValueError("Duplicate YAML keys are not allowed")
        result[key] = loader.construct_object(value_node)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def validate_receipt(receipt, fork):
    keys = {"schemaVersion", "service", "repository", "digest", "tag", "platform",
            "verifiedRevision", "sourceTree", "inputKey"}
    if set(receipt) != keys or type(receipt["schemaVersion"]) is not int or receipt["schemaVersion"] != 1:
        raise ValueError("Unsupported or unexpected image receipt fields")
    service = receipt["service"]
    if service not in SERVICES or receipt["platform"] != "linux/amd64":
        raise ValueError("Unexpected service or platform")
    patterns = {
        "repository": re.escape(fork.image(service)),
        "digest": r"sha256:[0-9a-f]{64}", "verifiedRevision": r"[0-9a-f]{40}",
        "sourceTree": r"[0-9a-f]{40}", "inputKey": r"[0-9a-f]{64}",
    }
    for key, pattern in patterns.items():
        if not isinstance(receipt[key], str) or not re.fullmatch(pattern, receipt[key]):
            raise ValueError("Invalid receipt field: " + key)
    if receipt["tag"] != "src-" + receipt["inputKey"]:
        raise ValueError("Receipt tag differs from build input identity")


def updated_values(values, receipt, expected_digest, fork):
    validate_receipt(receipt, fork)
    if values.get("localMode") is not False or values.get("serviceName") != receipt["service"]:
        raise ValueError("Promotion requires the same service and explicit localMode: false")
    current = values.get("image", {})
    if current.get("repository") != receipt["repository"]:
        raise ValueError("Configure/review the exact registry repository separately before promotion")
    if current.get("digest", "") != expected_digest:
        raise ValueError("Image changed since review; refusing stale digest replacement")
    if expected_digest and not re.fullmatch(r"sha256:[0-9a-f]{64}", expected_digest):
        raise ValueError("Invalid expected digest")
    if current.get("pullPolicy") not in ("IfNotPresent", "Always") or current.get("tag"):
        raise ValueError("Non-local values must use digest, no tag, and a registry pull policy")
    updated = copy.deepcopy(values)
    updated["image"]["digest"] = receipt["digest"]
    return updated


def promote(root, values_path, receipt, expected_digest, fork, write=False):
    root = root.resolve()
    # No creation of environments, no local fixture changes, no symlink escapes.
    path = root / values_path
    parts = Path(values_path).parts
    if (len(parts) != 3 or parts[:2] != ("environments", "fork")
            or parts[2] != receipt.get("service", "") + ".yaml"
            or path.resolve() != path.absolute() or not path.is_file()):
        raise ValueError("Select an existing environments/fork/<service>.yaml without symlinks")
    original = path.read_text()
    values = yaml.load(original, Loader=UniqueLoader)
    updated = updated_values(values, receipt, expected_digest, fork)
    if updated == values:
        return ""
    result = yaml.safe_dump(updated, sort_keys=False, allow_unicode=True)
    diff = "".join(difflib.unified_diff(original.splitlines(True), result.splitlines(True),
                                        fromfile=str(values_path), tofile=str(values_path)))
    if write:
        # Fail if another writer edited any configuration between preview and application.
        if path.read_text() != original:
            raise ValueError("Values changed during promotion")
        path.write_text(result)
    return diff


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--values", required=True)
    parser.add_argument("--expected-digest", required=True, help="Current digest; empty string only for initial setup")
    parser.add_argument("--write", action="store_true", help="Without this flag print a diff only")
    args = parser.parse_args()
    fork = from_origin(ROOT.parents[1]).require_personal_publish()
    receipt = json.loads(args.receipt.read_text())
    print(promote(ROOT, args.values, receipt, args.expected_digest, fork, args.write) or "No image change")
    print("Configuration only; no Git push or Kubernetes deployment performed.")


if __name__ == "__main__":
    main()
