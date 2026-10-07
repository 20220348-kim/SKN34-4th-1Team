"""Render independent Kubernetes evaluation releases; never read or alter a cluster."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import yaml
from deployment_candidate import HELM_VERSION, KUBE_VERSION

CHART = Path(__file__).resolve().parents[1] / "charts/govbiz-evaluation"
COMPONENTS = ("prefect", "evaluation-runner", "ops-artifacts")


def validate_bundle(values):
    """Check relationships that a single independent Helm release cannot check."""
    if set(values) != set(COMPONENTS):
        raise ValueError("All three independent evaluation releases are required")
    for component, value in values.items():
        if value.get("component") != component:
            raise ValueError("Evaluation component differs from its release")
    prefect, runner, artifacts = (values[name] for name in COMPONENTS)
    if runner["storage"] != artifacts["storage"]:
        raise ValueError("Runner and artifacts must share the same claim and node")
    if prefect["storage"]["existingClaim"] == runner["storage"]["existingClaim"]:
        raise ValueError("Prefect and evaluation results need separate claims")
    if artifacts["evidenceImage"] != runner["image"]:
        raise ValueError("Artifact fixtures must come from the exact runner image")
    if len({value.get("allowLocalImages", False) for value in values.values()}) != 1:
        raise ValueError("Local image mode must be consistent across releases")
    if runner.get("replicas", 0) == 1 and any(
        value.get("replicas", 0) != 1 for value in (prefect, artifacts)
    ):
        raise ValueError("A runner requires both Prefect and artifact replicas")


def render_bundle(values, namespace="govbiz-evaluation", helm="helm"):
    validate_bundle(values)
    version = subprocess.check_output(
        [helm, "version", "--template", "{{.Version}}"],
        text=True,
        stderr=subprocess.PIPE,
        timeout=15,
    ).strip()
    if version != HELM_VERSION:
        raise ValueError("Pinned Helm is required")
    resources = {}
    with tempfile.TemporaryDirectory(prefix="govbiz-evaluation-render-") as directory:
        for component in COMPONENTS:
            path = Path(directory) / (component + ".yaml")
            path.write_text(yaml.safe_dump(values[component]), encoding="utf-8")
            output = subprocess.check_output(
                [
                    helm,
                    "template",
                    component,
                    str(CHART),
                    "--namespace",
                    namespace,
                    "--kube-version",
                    KUBE_VERSION,
                    "--values",
                    str(path),
                ],
                stderr=subprocess.PIPE,
                timeout=30,
            )
            resources[component] = [row for row in yaml.safe_load_all(output) if row]
    return resources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--values-dir", type=Path, required=True)
    parser.add_argument("--namespace", default="govbiz-evaluation")
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    try:
        values = {
            name: yaml.safe_load(
                (args.values_dir / (name + ".yaml")).read_text(encoding="utf-8")
            )
            for name in COMPONENTS
        }
        resources = render_bundle(values, args.namespace, args.helm)
    except Exception as error:  # noqa: BLE001 - Helm output may contain private values.
        print(
            json.dumps(
                {
                    "status": "BLOCKED",
                    "errorType": type(error).__name__,
                    "clusterChanged": False,
                    "databaseChanged": False,
                }
            )
        )
        return 1
    print(
        json.dumps(
            {
                "status": "RENDERED_NOT_APPLIED",
                "components": {name: len(rows) for name, rows in resources.items()},
                "clusterChanged": False,
                "databaseChanged": False,
                "storageRestored": False,
                "runtimeVerified": False,
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
