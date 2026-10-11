"""Validate EKS image receipts and reject the retired direct deployment entry point."""

import os
import re

SOURCE = "ilil1/SKN34-4th-1Team"
TARGETS = (
    ("govbiz-msa", "ai-service", {"ai-service": "ai-service"}),
    ("govbiz-msa", "catalog-service", {"catalog-service": "catalog-service"}),
    ("govbiz-msa", "core-service", {"core-service": "core-service"}),
    (
        "govbiz-msa",
        "ops-service",
        {"ops-service": "ops-service", "ops-sync": "ops-service"},
    ),
    ("govbiz-evaluation", "ops-artifacts", {"ops-artifacts": "ops-service"}),
    (
        "govbiz-evaluation",
        "evaluation-runner",
        {"evaluation-runner": "evaluation-runner"},
    ),
)
COMPONENTS = {component for _, _, mapping in TARGETS for component in mapping.values()}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def validate(record, env=os.environ):
    require(
        record.get("schema") == 1 and record.get("repository") == SOURCE,
        "Untrusted release source",
    )
    require(
        re.fullmatch(r"[a-f0-9]{40}", record.get("sourceSha", "")),
        "Invalid release SHA",
    )
    for key, name in (
        ("account", "AWS_ACCOUNT_ID"),
        ("region", "AWS_REGION"),
        ("cluster", "EKS_CLUSTER_NAME"),
    ):
        require(
            record.get(key) == env.get(name) and bool(record.get(key)),
            "Release target mismatch: " + key,
        )
    require(
        re.fullmatch(r"[0-9]{12}", record["account"])
        and record["region"] == "ap-southeast-2",
        "Invalid AWS target",
    )
    require(
        re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", record["cluster"]),
        "Invalid cluster",
    )
    require(
        set(record.get("images", {})) == COMPONENTS, "Incomplete application images"
    )
    for component, image in record["images"].items():
        prefix = f"{record['account']}.dkr.ecr.{record['region']}.amazonaws.com/govbiz-demo/{component}@sha256:"
        require(
            isinstance(image, str)
            and image.startswith(prefix)
            and re.fullmatch(r"[a-f0-9]{64}", image[len(prefix) :]),
            "Only the expected ECR digest is allowed",
        )


def deploy(record):
    raise ValueError("Direct EKS deployment is disabled; use the Argo CD release workflow.")
