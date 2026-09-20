"""Fail closed on portfolio registry, environment and Argo boundaries."""
import argparse
import json
import re
import subprocess

import yaml

from check_msa import ROOT, SERVICES, NAMESPACE, REPOSITORY_URL, REPOSITORY_BRANCH, CHART_PATH, policy_errors


def errors(root=ROOT, helm="helm"):
    problems = []
    expected = {"server": "https://kubernetes.default.svc", "namespace": NAMESPACE}
    project = yaml.safe_load((root / "argocd/portfolio/project.yaml").read_text())["spec"]
    if (project["destinations"] != [expected] or project["clusterResourceWhitelist"]
            or project["sourceRepos"] != [REPOSITORY_URL]
            or project["namespaceResourceWhitelist"] != [{"group": "apps", "kind": "Deployment"}, {"group": "", "kind": "Service"}]):
        problems.append("Portfolio Argo permissions widened")
    apps = list(yaml.safe_load_all((root / "argocd/portfolio/applications.yaml").read_text()))
    if len(apps) != 4 or {a["metadata"]["name"] for a in apps} != {"govbiz-portfolio-" + s for s in SERVICES}:
        problems.append("Expected exactly four portfolio Applications")
    for app in apps:
        service = app["metadata"]["name"].removeprefix("govbiz-portfolio-")
        spec = app["spec"]
        if (spec["project"] != "govbiz-portfolio" or spec["destination"] != expected
                or spec["source"] != {"repoURL": project["sourceRepos"][0], "targetRevision": REPOSITORY_BRANCH,
                    "path": CHART_PATH, "helm": {"releaseName": service,
                    "valueFiles": [f"../../environments/portfolio/{service}.yaml"]}}
                or spec["syncPolicy"] != {"automated": {"enabled": False, "prune": False, "selfHeal": False},
                    "syncOptions": ["FailOnSharedResource=true"],
                    "retry": {"limit": 5, "backoff": {"duration": "10s", "factor": 2, "maxDuration": "3m"}}}):
            problems.append("Unexpected portfolio Argo source/sync policy")
    record = json.loads((root / "environments/portfolio/release.json").read_text())
    for service in SERVICES:
        path = root / f"environments/portfolio/{service}.yaml"
        values = yaml.safe_load(path.read_text())
        image = values["image"]
        if (values["localMode"] is not False or values["serviceName"] != service
                or image["repository"] != "ghcr.io/govbiz-team/govbiz-" + service
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", image["digest"])
                or image.get("tag") or image["pullPolicy"] != "IfNotPresent"
                or values["imagePullSecrets"] != [{"name": "ghcr-pull"}]
                or record["images"][service] != image["repository"] + "@" + image["digest"]):
            problems.append(service + ": unverified registry/digest/pull credential reference")
        if service == "ai-service" and values["env"].get("OPENAI_BASE_URL") != "http://disabled-openai.invalid/v1":
            problems.append("Real paid AI was not authorized for this portfolio deployment")
        if service == "catalog-service" and any(values["env"].get(s + "_SYNC_ENABLED") != "false"
                for s in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")):
            problems.append("Real data collection must be configured separately")
        result = subprocess.check_output([helm, "template", service, str(root / "charts/govbiz-service"),
                                         "-n", NAMESPACE, "-f", str(path)], text=True, timeout=30)
        problems.extend(policy_errors(service, list(yaml.safe_load_all(result))))
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    problems = errors(helm=args.helm)
    if problems:
        raise SystemExit("\n".join(problems))
    print("PASS: historical portfolio digest references and disabled Argo auto-sync template")
    print("Private images and bootstrap are not configured for this repository or its forks.")


if __name__ == "__main__":
    main()
