"""Execute the reviewed Ops Job before applying app workloads outside Argo CD."""

import yaml


def run_migration(job, kube, namespaced, execute):
    name = "ops-service-migrate"
    if job.get("kind") != "Job" or job.get("metadata", {}).get("name") != name:
        raise ValueError("Expected the reviewed Ops migration Job")
    existing = execute(
        namespaced + ["get", "job", name, "--ignore-not-found", "-o", "name"],
        capture=True,
    )
    if existing.strip():
        raise ValueError(
            "Inspect the existing Ops migration Job and explicitly remove it before retry"
        )
    execute(kube + ["create", "-f", "-"], data=yaml.safe_dump(job))
    # A failure leaves the Job for inspection and prevents the caller applying apps.
    execute(
        namespaced
        + ["wait", "--for=condition=complete", "job/" + name, "--timeout=360s"]
    )
    execute(namespaced + ["delete", "job", name, "--wait=true"])
