"""One inventory for merge checks and publication; skipped work is not success."""

import json
import os
import sys

WORKFLOW_JOBS = {
    "ci.yml": {
        "frontend": ("Web and shared",),
        "mobile": ("Mobile",),
        "core-service": ("Core API",),
        "ai-service": ("AI Service",),
        "container-integration": ("Container integration",),
    },
    "catalog-ci.yml": {
        "catalog-service": ("Catalog clean build and boundaries",),
        "catalog-integration": (
            "Catalog to Core HTTP projection with offline fixtures",
        ),
    },
    "ops-ci.yml": {
        "checks": ("Ops checks and MySQL tests",),
        "docker": ("Ops container integration",),
    },
    "infra-ci.yml": {
        "fork-identity": (
            "Fork identity (ubuntu-24.04)",
            "Fork identity (macos-15-intel)",
            "Fork identity (windows-2025)",
        ),
        "repository": ("repository",),
        "kubernetes-manifests": ("kubernetes-manifests",),
        "helm-gitops": ("helm-gitops",),
    },
    "llmops-ci.yml": {"integration": ("Saved capture pipeline with local servers",)},
}
SUMMARY_NAMES = dict(
    zip(
        WORKFLOW_JOBS,
        (
            "Required CI / GovBiz",
            "Required CI / Catalog",
            "Required CI / Ops",
            "Required CI / Infra",
            "Required CI / LLMOps",
        ),
    )
)
WORKFLOWS = {
    filename: tuple(name for names in jobs.values() for name in names)
    + (SUMMARY_NAMES[filename],)
    for filename, jobs in WORKFLOW_JOBS.items()
}


def check_results(filename, needs):
    expected = set(WORKFLOW_JOBS[filename])
    if not isinstance(needs, dict) or set(needs) != expected:
        raise ValueError("Required CI dependencies are missing or unexpected")
    failed = sorted(
        name
        for name, job in needs.items()
        if not isinstance(job, dict) or job.get("result") != "success"
    )
    if failed:
        raise ValueError("Required CI did not succeed: " + ", ".join(failed))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 2:
            raise ValueError("Specify one workflow filename")
        check_results(sys.argv[1], json.loads(os.environ["NEEDS_JSON"]))
    except (ValueError, KeyError) as error:
        sys.exit(str(error))
    print("Every required dependency completed successfully.")
