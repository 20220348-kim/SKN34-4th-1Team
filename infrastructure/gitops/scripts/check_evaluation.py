"""Render independent Kubernetes evaluation releases; never read or alter a cluster."""

import argparse
import ipaddress
import json
import re
import subprocess
import tempfile
from pathlib import Path

import yaml
from deployment_candidate import HELM_VERSION, KUBE_VERSION

CHART = Path(__file__).resolve().parents[1] / "charts/govbiz-evaluation"
COMPONENTS = ("prefect", "evaluation-runner", "ops-artifacts")
OPS_ORIGIN = "http://ops-service.govbiz-msa.svc.cluster.local:8000"
LANGFUSE_ORIGIN = "http://langfuse-web.govbiz-observability.svc.cluster.local:3000"


def runner_egress(runner):
    """Allow the current Kubernetes peers and one exact Compose Langfuse address."""
    if runner.get("opsApiUrl") != OPS_ORIGIN:
        raise ValueError("Runner Ops URL must match its Kubernetes egress peer")
    origin = runner.get("langfuseUrl", "")
    if origin == LANGFUSE_ORIGIN:
        langfuse = {
            "namespaceSelector": {
                "matchLabels": {"kubernetes.io/metadata.name": "govbiz-observability"}
            },
            "podSelector": {"matchLabels": {"app.kubernetes.io/name": "langfuse-web"}},
        }
    else:
        match = re.fullmatch(r"http://([0-9.]+):3000", origin)
        if not match:
            raise ValueError(
                "Use the Langfuse Kubernetes origin or an RFC1918 IPv4 origin on port 3000"
            )
        address = ipaddress.IPv4Address(match[1])
        if not any(
            address in ipaddress.IPv4Network(cidr)
            for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
        ):
            raise ValueError("Compose Langfuse requires an RFC1918 IPv4 address")
        langfuse = {"ipBlock": {"cidr": str(address) + "/32"}}
    return [
        {
            "to": [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": "kube-system"}
                    },
                    "podSelector": {"matchLabels": {"k8s-app": "kube-dns"}},
                }
            ],
            "ports": [{"protocol": "UDP", "port": 53}, {"protocol": "TCP", "port": 53}],
        },
        {
            "to": [
                {"podSelector": {"matchLabels": {"app.kubernetes.io/name": "prefect"}}}
            ],
            "ports": [{"protocol": "TCP", "port": 4200}],
        },
        {
            "to": [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": "govbiz-msa"}
                    },
                    "podSelector": {
                        "matchLabels": {"app.kubernetes.io/name": "ops-service"}
                    },
                }
            ],
            "ports": [{"protocol": "TCP", "port": 8000}],
        },
        {"to": [langfuse], "ports": [{"protocol": "TCP", "port": 3000}]},
    ]


def validate_bundle(values):
    """Check relationships that a single independent Helm release cannot check."""
    if set(values) != set(COMPONENTS):
        raise ValueError("All three independent evaluation releases are required")
    for component, value in values.items():
        if value.get("component") != component:
            raise ValueError("Evaluation component differs from its release")
    prefect, runner, artifacts = (values[name] for name in COMPONENTS)
    runner_egress(runner["runner"])
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


def render_bundle(values, namespace="govbiz-evaluation", helm="helm", *, chart=CHART):
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
                    str(chart),
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
