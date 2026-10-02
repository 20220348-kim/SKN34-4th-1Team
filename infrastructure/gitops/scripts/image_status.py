"""Compare running kind images with their references and declared source revisions."""

import json
import re
import subprocess

from check_msa import REPOSITORY_ROOT
from portfolio_cluster import run


def image_reference(reference):
    # Pod imageID can be a repo digest or a runtime-prefixed config digest.
    # Let CRI resolve it; Docker manifest IDs and CRI config IDs are not interchangeable.
    reference = reference.removeprefix("containerd://").removeprefix("docker-pullable://")
    if not reference or reference.startswith("-"):
        raise ValueError("Invalid image reference")
    return reference


def inspect_image(node, reference):
    reference = image_reference(reference)
    result = json.loads(
        run(
            ["docker", "exec", node, "crictl", "inspecti", reference],
            capture=True,
            timeout=15,
        )
    )
    identity = result.get("status", {}).get("id", "")
    if not isinstance(identity, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", identity):
        raise ValueError("Invalid CRI image identity")
    digests = result["status"].get("repoDigests", [])
    if not isinstance(digests, list) or any(
        not isinstance(value, str) or not re.fullmatch(r"[^\s@]+@sha256:[a-f0-9]{64}", value)
        for value in digests
    ):
        raise ValueError("Invalid CRI image digests")
    labels = result.get("info", {}).get("imageSpec", {}).get("config", {}).get("Labels") or {}
    revision_labels = ("org.opencontainers.image.revision", "dev.govbiz.source")
    revisions = {key: labels[key] for key in revision_labels if key in labels}
    valid = bool(revisions) and all(
        isinstance(value, str) and re.fullmatch(r"[a-f0-9]{40}", value)
        for value in revisions.values()
    )
    if valid and len(set(revisions.values())) == 1:
        return identity, next(iter(revisions.values())), list(revisions), digests
    # Arbitrary label contents and container configuration must never enter the report.
    return identity, None, [], digests


def compare_service_tree(root, service, revision):
    """Compare the service directory, including dirty and untracked files, without fetching."""
    if revision is None:
        return "UNKNOWN"
    command = ["git", "-C", str(root)]
    path = "backend/" + service
    try:
        result = subprocess.run(
            command + ["diff", "--quiet", "--no-ext-diff", "--no-textconv", revision, "--", path],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 1:
            return "CHANGED"
        if result.returncode != 0:
            return "UNKNOWN"
        untracked = run(
            command + ["ls-files", "--others", "--exclude-standard", "-z", "--", path],
            capture=True,
            timeout=15,
        )
        return "CHANGED" if untracked else "UNCHANGED"
    except (OSError, subprocess.SubprocessError):
        return "UNKNOWN"


def audit(settings, report):
    """Read metadata only after the caller verifies the dedicated cluster's ownership."""
    node = settings["cluster"] + "-control-plane"
    inspected, comparisons, observations = {}, {}, []
    service_matches = []
    for service in report["services"]:
        template = {item["name"]: item["image"] for item in service["containers"]}
        current = []
        for pod in service["pods"]:
            if pod["terminating"]:
                continue
            for container in pod["containers"]:
                item = {
                    "service": service["name"],
                    "pod": pod["name"],
                    "container": container["name"],
                    "image": container["image"],
                    "image_id": container["image_id"],
                    "reference_cri_id": None,
                    "running_cri_id": None,
                    "runtime_image_matches": False,
                    "declared_revision": None,
                    "revision_labels": [],
                    "service_tree_comparison": "UNKNOWN",
                    "issues": [],
                }
                current.append(item)
                if pod.get("node") != node:
                    item["issues"].append("POD_NODE_MISMATCH")
                    continue
                references = (template.get(container["name"]), container["image_id"])
                if not all(isinstance(ref, str) and ref for ref in references):
                    item["issues"].append("IMAGE_REFERENCE_MISSING")
                    continue
                for reference in references:
                    if reference not in inspected:
                        try:
                            tagged = inspected.get(references[0])
                            # An archive import can advertise repoDigests that are not separately
                            # registered CRI names. Exact digest membership still identifies the
                            # same immutable image; do not require that alias to be inspectable.
                            if tagged and image_reference(reference) in {tagged[0], *tagged[3]}:
                                inspected[reference] = tagged
                            else:
                                inspected[reference] = inspect_image(node, reference)
                        except (
                            OSError,
                            subprocess.SubprocessError,
                            ValueError,
                            TypeError,
                            AttributeError,
                        ):
                            inspected[reference] = None
                tagged, running = (inspected[ref] for ref in references)
                if tagged is None or running is None:
                    item["issues"].append("IMAGE_INSPECTION_FAILED")
                    continue
                item["reference_cri_id"], item["running_cri_id"] = tagged[0], running[0]
                item["runtime_image_matches"] = (
                    tagged[0] == running[0] and container["image"] == references[0]
                )
                if not item["runtime_image_matches"]:
                    item["issues"].append("RUNTIME_IMAGE_MISMATCH")
                # Read labels from the immutable running image, not the possibly moved tag.
                item["declared_revision"], item["revision_labels"] = running[1:3]
                key = (service["name"], running[1])
                if key not in comparisons:
                    comparisons[key] = compare_service_tree(REPOSITORY_ROOT, *key)
                item["service_tree_comparison"] = comparisons[key]
                if comparisons[key] != "UNCHANGED":
                    item["issues"].append("SERVICE_SOURCE_" + comparisons[key])
        observations.extend(current)
        service_matches.append(
            bool(current) and service["ready"] and all(c["runtime_image_matches"] for c in current)
        )
    return {
        "scope": "running_image_metadata",
        "runtime_images_match": bool(service_matches) and all(service_matches),
        "source_review_required": not observations
        or any(item["service_tree_comparison"] != "UNCHANGED" for item in observations),
        "containers": observations,
        # Labels are declarations, not attestations of the build inputs or resulting binary.
        "image_source_verified": False,
    }
