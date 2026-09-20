"""Fail closed on portfolio registry, environment and Argo boundaries."""
import argparse
import json
import re
import subprocess

import yaml

from check_msa import ROOT, SERVICES, NAMESPACE, REPOSITORY_URL, REPOSITORY_BRANCH, CHART_PATH, policy_errors


def free_runtime_errors(service, values):
    """The shared bootstrap does not authorize paid APIs or external side effects.

    Check these invariants independently of the template so editing both a
    template and its copied fork values cannot accidentally enable paid calls.
    """
    env = values.get("env", {})
    problems = []
    disabled = []
    if service == "ai-service" and env.get("OPENAI_BASE_URL") != "http://disabled-openai.invalid/v1":
        problems.append(service + ": paid OpenAI endpoint is not allowed in the shared local bootstrap")
    if service in {"core-service", "catalog-service"}:
        disabled += [source + "_SYNC_ENABLED" for source in ("BIZINFO", "KSTARTUP", "MSIT", "CNTRADE_NOTICE")]
        disabled += ["SUPPORT_PROGRAM_INDEX_ENABLED"]
    if service == "core-service":
        disabled += ["ACCOUNT_DEV_LOGIN_ENABLED", "ACCOUNT_PASSWORD_RESET_MAIL_ENABLED", "APPLICATION_FORM_ANALYSIS_ENABLED",
                     "DAILY_REPORT_ENABLED", "DAILY_REPORT_MAIL_ENABLED", "ASSISTANT_AGENT_ENABLED"]
        disabled += [name for name in env if name.endswith("_QUEUE_ENABLED")]
    if any(env.get(name) != "false" for name in disabled):
        problems.append(service + ": external collection, privileged dev login, mail, queues and paid jobs must stay disabled")
    if any(name.startswith("SMTP_") for name in env):
        problems.append(service + ": SMTP is not configured by the shared local bootstrap")
    return problems


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


def fork_errors(fork, root=ROOT, helm="helm"):
    """Check personal release identities and the safe local-runtime Helm contract.

    The checked-in historical portfolio is a settings template only: its image
    digests are never accepted for another account's bootstrap.
    """
    from sync_images import validate_record

    directory = root / "environments/fork"
    record_path = directory / "release.json"
    if not record_path.is_file():
        return ["No verified personal release exists. Enable private image CI in your fork, wait for promotion, then pull the resulting commit."]
    problems = []
    try:
        record = json.loads(record_path.read_text())
        validate_record(record, fork)
        for service in SERVICES:
            path = directory / (service + ".yaml")
            values = yaml.safe_load(path.read_text())
            problems.extend(free_runtime_errors(service, values))
            expected = yaml.safe_load((root / f"environments/portfolio/{service}.yaml").read_text())
            reference = record["images"][service]
            repository, digest = reference.split("@")
            expected["image"] = {"repository": repository, "digest": digest, "tag": "", "pullPolicy": "IfNotPresent"}
            if values != expected:
                problems.append(service + ": personal values differ from the safe local-runtime contract or verified digest")
                continue
            rendered = subprocess.check_output([helm, "template", service, str(root / "charts/govbiz-service"),
                                                "-n", NAMESPACE, "-f", str(path)], text=True, timeout=30)
            problems.extend(policy_errors(service, list(yaml.safe_load_all(rendered))))
    except (ValueError, KeyError, TypeError, FileNotFoundError) as error:
        problems.append("Invalid personal release: " + str(error))
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default="helm")
    args = parser.parse_args()
    problems = errors(helm=args.helm)
    if problems:
        raise SystemExit("\n".join(problems))
    print("PASS: historical portfolio digest references and disabled Argo auto-sync template")
    print("Historical template check only; personal release/bootstrap verification uses fork_cluster.py separately.")


if __name__ == "__main__":
    main()
