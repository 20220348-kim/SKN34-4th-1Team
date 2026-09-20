"""Offline Helm/Argo policy checks. Not a cluster or GitOps sync test."""

import argparse
from pathlib import Path
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parents[1]
REPOSITORY_URL = "https://github.com/SKNETWORKS-FAMILY-AICAMP/SKN34-4th-1Team.git"
REPOSITORY_BRANCH = "main"
CHART_PATH = "infrastructure/gitops/charts/govbiz-service"
SERVICES = ("core-service", "catalog-service", "ai-service", "ops-service")
NAMESPACE = "govbiz-msa"


def render(service, helm="helm", extra=()):
    result = subprocess.run(
        [helm, "template", service, str(ROOT / "charts/govbiz-service"),
         "--namespace", NAMESPACE, "--values", str(ROOT / f"environments/local-msa/{service}.yaml"),
         *extra], check=True, capture_output=True, text=True, timeout=30,
    )
    return list(yaml.safe_load_all(result.stdout))


def policy_errors(service, resources):
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(f"{service}: {message}")

    by_kind = {r["kind"]: r for r in resources}
    require(len(resources) == 2 and set(by_kind) == {"Deployment", "Service"},
            "one service release must own only Deployment and Service")
    if set(by_kind) != {"Deployment", "Service"}:
        return errors
    for item in resources:
        require(item["metadata"]["name"] == service, "wrong resource name")
        require(item["metadata"]["namespace"] == NAMESPACE, "wrong namespace")
    spec = by_kind["Deployment"]["spec"]
    require(spec["replicas"] == 1 and spec["strategy"] == {"type": "Recreate"},
            "single writer must not overlap during rollout")
    pod = spec["template"]["spec"]
    require(pod["automountServiceAccountToken"] is False, "API token must not be mounted")
    require(pod["securityContext"]["runAsNonRoot"] is True, "non-root required")
    require(not any(k in pod for k in ("hostNetwork", "hostPID", "hostIPC")), "host isolation required")
    require(not any("hostPath" in v for v in pod["volumes"]), "no host data mounts")
    container = pod["containers"][0]
    require(len(pod["containers"]) == 1 and container["name"] == service, "wrong container")
    require(container["securityContext"]["readOnlyRootFilesystem"] is True, "read-only image required")
    require(not container["securityContext"]["allowPrivilegeEscalation"], "privilege escalation forbidden")
    require(not container["image"].endswith(":latest"), "mutable latest tag forbidden")
    for probe in ("startupProbe", "readinessProbe", "livenessProbe"):
        require(bool(container.get(probe)), f"missing {probe}")
    for budget in ("requests", "limits"):
        require(set(container["resources"][budget]) >= {"cpu", "memory"}, f"missing {budget}")
    env = {e["name"]: e.get("value") for e in container["env"]}
    secret_names = {e["valueFrom"]["secretKeyRef"]["name"] for e in container["env"] if "valueFrom" in e}
    require(secret_names == {service.removesuffix("-service") + "-runtime"}, "service-scoped secret required")
    if service == "core-service":
        require(env.get("CATALOG_PROJECTION_ENABLED") == "true", "Core must use Catalog")
        require(env.get("CATALOG_SERVICE_URL") == "http://catalog-service:8081", "wrong Catalog endpoint")
        for source in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE"):
            require(env.get(source + "_SYNC_ENABLED") == "false", "Core source writer enabled")
        require(env.get("SUPPORT_PROGRAM_INDEX_ENABLED") == "false", "Core index writer enabled")
        require("catalog-mysql" not in str(env), "Core must not access Catalog DB")
    if service == "catalog-service":
        require("core-mysql" not in str(env), "Catalog must not access Core DB")
    if service == "ai-service":
        require(not any("DATASOURCE" in key or key.startswith("DB_") for key in env), "AI must not get SQL credentials")
    network = by_kind["Service"]["spec"]
    require(network["type"] == "ClusterIP", "internal service required")
    require(network["selector"] == spec["template"]["metadata"]["labels"], "Service must select its own pods")
    return errors


def argo_errors(root=ROOT):
    project = yaml.safe_load((root / "argocd/local/project.yaml").read_text())["spec"]
    apps = list(yaml.safe_load_all((root / "argocd/local/applications.yaml").read_text()))
    errors = []
    if project["sourceRepos"] != [REPOSITORY_URL]:
        errors.append("Argo source repository scope widened")
    expected_destination = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    if project["destinations"] != [expected_destination] or project["clusterResourceWhitelist"]:
        errors.append("Argo destination/cluster permission scope widened")
    if project["namespaceResourceWhitelist"] != [{"group": "apps", "kind": "Deployment"}, {"group": "", "kind": "Service"}]:
        errors.append("Argo resource scope widened")
    if {app["metadata"]["name"] for app in apps} != {"govbiz-" + s for s in SERVICES} or len(apps) != 4:
        errors.append("Expected four independent Argo Applications")
    for app in apps:
        service = app["metadata"]["name"].removeprefix("govbiz-")
        spec = app["spec"]
        source = spec["source"]
        if spec["project"] != "govbiz-local-msa" or spec["destination"] != expected_destination:
            errors.append("Application escaped local project")
        if source["repoURL"] != project["sourceRepos"][0] or source["path"] != CHART_PATH or source["targetRevision"] != REPOSITORY_BRANCH:
            errors.append("Application source mismatch")
        if source["helm"] != {"releaseName": service, "valueFiles": [f"../../environments/local-msa/{service}.yaml"]}:
            errors.append("Application must render exactly one service values file")
        if spec.get("syncPolicy") != {"syncOptions": ["FailOnSharedResource=true"]}:
            errors.append("Initial sync must be manual without prune or self-heal")
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    errors = argo_errors()
    for service in SERVICES:
        errors.extend(policy_errors(service, render(service, args.helm)))
    if errors:
        raise SystemExit("\n".join(errors))
    print("PASS: four isolated Helm releases, data/writer ownership and restricted Argo definitions")
    print("Not a runtime, NetworkPolicy enforcement, authentication or GitOps sync proof.")


if __name__ == "__main__":
    main()
