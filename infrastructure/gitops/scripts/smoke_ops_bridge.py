"""Disposable kind/Compose HTTP smoke, optionally including a free Kubernetes evaluation."""

import argparse
import hashlib
import json
import os
import re
import secrets
import subprocess
import tempfile
import uuid
from pathlib import Path

import ops_bridge
from check_msa import NAMESPACE, REPOSITORY_ROOT, ROOT

PROBE = r"""
import hashlib,json,os,time
from urllib.error import HTTPError,URLError
from urllib.request import Request,build_opener,ProxyHandler,HTTPRedirectHandler
class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None
http=build_opener(ProxyHandler({}),NoRedirect())
artifact="http://ops-compose-artifacts:8010"
headers={"Authorization":"Bearer "+os.environ["LLMOPS_ARTIFACT_TOKEN"]}
deadline=time.monotonic()+90
while True:
    try:
        stage="PREFECT_HTTP"
        with http.open("http://ops-compose-prefect:4200/api/health",timeout=3) as response:
            assert response.status==200
        stage="ARTIFACT_HTTP"
        with http.open(Request(artifact+"/v1/status",headers=headers),timeout=3) as response:
            assert json.load(response)=={"schema_version":1,"results_readable":True}
        break
    except (HTTPError,URLError,OSError) as error:
        if time.monotonic()>deadline:
            code=str(error.code) if isinstance(error,HTTPError) else type(getattr(error,"reason",error)).__name__.upper()
            raise SystemExit("BRIDGE_"+stage+"_"+code) from None
        time.sleep(2)
for request,expected in [(Request(artifact+"/v1/status"),401),
                         (Request(artifact+"/v1/status",headers={"Authorization":"Bearer incorrect"}),401),
                         (Request(artifact+"/v1/status",headers=headers,method="POST"),405)]:
    try:
        http.open(request,timeout=3)
        raise SystemExit("Artifact authorization/read-only check failed")
    except HTTPError as error:
        assert error.code==expected
with http.open(Request(artifact+"/v1/evidence/"+os.environ["EVIDENCE_FILE"],headers=headers),timeout=3) as response:
    raw=response.read(8*1024*1024+1)
    assert len(raw)<=8*1024*1024
    assert hashlib.sha256(raw).hexdigest()==os.environ["EVIDENCE_SHA256"]
print(json.dumps({"prefect_http":True,"artifact_http":True,"artifact_auth_rejected":True,
                  "artifact_read_only":True,"evidence_sha256":True,"evaluation_executed":False,"model_api_calls":0}))
"""


def compose_environment(keys):
    """Explicit test dotenv values must win over inherited real credentials/routes."""
    return {
        key: value
        for key, value in os.environ.items()
        if key not in keys and not key.startswith("COMPOSE_")
    }


def execute(command, *, data=None, timeout=600, env=None):
    return subprocess.run(
        [str(item) for item in command],
        input=data,
        env=env,
        text=True,
        capture_output=True,
        check=True,
        timeout=timeout,
    ).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kind", default="kind")
    parser.add_argument(
        "--ops-image",
        help="Optional existing local Ops image; otherwise build current source",
    )
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument(
        "--evaluate",
        action="store_true",
        help="Also run isolated Kubernetes Ops evaluation and restart checks",
    )
    parser.add_argument("--helm", default="helm")
    parser.add_argument(
        "--evaluation-runtime",
        action="store_true",
        help="After --evaluate, restore and run all three evaluation components in Kubernetes",
    )
    args = parser.parse_args()
    if args.evaluation_runtime and not args.evaluate:
        parser.error("--evaluation-runtime requires --evaluate")
    if args.report.exists():
        parser.error("Report must be a new file")
    if "v0.33.0" not in execute([args.kind, "version"]):
        parser.error("Use pinned kind v0.33.0")
    identity = uuid.uuid4().hex[:10]
    project = "govbiz-bridge-smoke-" + identity
    cluster = "govbiz-bridge-smoke-" + identity
    settings = {
        "cluster": cluster,
        "stateId": uuid.uuid4().hex,
        "repository": "bridge-smoke/local",
        "namespace": NAMESPACE,
        "mode": "dev",
    }
    if cluster in execute([args.kind, "get", "clusters"]).splitlines():
        parser.error("Generated cluster already exists; refusing adoption")
    if any(
        item["Name"] == project
        for item in json.loads(
            execute(["docker", "compose", "ls", "--all", "--format", "json"])
        )
    ):
        parser.error("Generated Compose project already exists; refusing adoption")
    report = {
        "scope": "kubernetes_ops_evaluation" if args.evaluate else "kind_compose_http",
        "cluster": cluster,
        "compose_project": project,
        "evaluation_executed": False,
        "model_api_calls": 0,
        "status": "FAIL",
    }
    compose_started = cluster_started = False
    image = None
    directory = REPOSITORY_ROOT / "infrastructure/llmops"
    with tempfile.TemporaryDirectory(prefix=project + "-") as temporary:
        state = Path(temporary)
        names = (
            "compose.yaml",
            "compose.ops.yaml",
            "compose.artifacts.yaml",
            "compose.kind.yaml",
        )
        keys = set(
            re.findall(
                r"\$\{([A-Z][A-Z0-9_]*)",
                "\n".join((directory / name).read_text() for name in names),
            )
        )
        compose_env = compose_environment(keys)
        token = secrets.token_hex(32)
        env = state / ".env"
        env.write_text(
            "".join(
                key
                + "="
                + (
                    token
                    if key == "LLMOPS_ARTIFACT_TOKEN"
                    else "pk-lf-" + secrets.token_hex(16)
                    if key == "LANGFUSE_PUBLIC_KEY"
                    else "sk-lf-" + secrets.token_hex(32)
                    if key == "LANGFUSE_SECRET_KEY"
                    else secrets.token_hex(32)
                )
                + "\n"
                for key in keys
                if not key.startswith("GOVBIZ_OPS_BRIDGE_")
            )
            + ops_bridge.environment(settings)
        )
        os.chmod(env, 0o600)
        overlay = state / "smoke.yaml"
        overlay.write_text(
            "services:\n  prefect:\n    ports: !reset []\n  langfuse-web:\n    ports: !reset []\n"
            + (
                "  ops-artifacts:\n    image: " + json.dumps(args.ops_image) + "\n"
                if args.ops_image
                else ""
            )
        )
        compose = ["docker", "compose", "--project-name", project, "--env-file", env]
        for name in names:
            compose += ["-f", directory / name]
        compose += ["-f", overlay, "--profile", "evaluation"]
        kube = [
            "kubectl",
            "--kubeconfig",
            state / "kubeconfig",
            "--context",
            "kind-" + cluster,
        ]
        nk = kube + ["-n", NAMESPACE]
        try:
            print(
                "Starting isolated Compose Prefect and read-only artifact server",
                flush=True,
            )
            compose_started = True
            execute(
                compose
                + [
                    "up",
                    "-d",
                    "--no-deps",
                    *([] if args.ops_image else ["--build"]),
                    "prefect",
                    "ops-artifacts",
                ],
                timeout=900,
                env=compose_env,
            )
            artifact_id = execute(
                compose + ["ps", "-q", "ops-artifacts"], env=compose_env
            ).strip()
            image_id = execute(
                ["docker", "inspect", "--format", "{{.Image}}", artifact_id]
            ).strip()
            image = "govbiz-ops-service:bridge-" + identity
            execute(["docker", "image", "tag", image_id, image])
            print(
                "Creating isolated kind cluster and loading the local probe image",
                flush=True,
            )
            cluster_started = True
            execute(
                [
                    args.kind,
                    "create",
                    "cluster",
                    "--name",
                    cluster,
                    "--config",
                    ROOT / "kind/local.yaml",
                    "--kubeconfig",
                    state / "kubeconfig",
                    "--wait",
                    "180s",
                ],
                timeout=300,
            )
            execute(
                [args.kind, "load", "docker-image", image, "--name", cluster],
                timeout=300,
            )
            for resource in (
                {
                    "apiVersion": "v1",
                    "kind": "Namespace",
                    "metadata": {"name": NAMESPACE},
                },
                {
                    "apiVersion": "v1",
                    "kind": "ConfigMap",
                    "metadata": {"name": "govbiz-owner", "namespace": "kube-system"},
                    "data": {
                        "repository": settings["repository"],
                        "stateId": settings["stateId"],
                    },
                },
                {
                    "apiVersion": "v1",
                    "kind": "Secret",
                    "metadata": {"name": "ops-bridge-probe", "namespace": NAMESPACE},
                    "stringData": {"LLMOPS_ARTIFACT_TOKEN": token},
                },
            ):
                execute(kube + ["create", "-f", "-"], data=json.dumps(resource))
            ops_bridge.connect(state, settings, project)
            ops_bridge.connect(state, settings, project, check=True)
            # Simulate a stale route while preserving the owned Service identity.
            execute(
                nk
                + [
                    "patch",
                    "endpointslice",
                    "ops-compose-artifacts",
                    "--type=json",
                    "-p",
                    json.dumps(
                        [
                            {
                                "op": "replace",
                                "path": "/endpoints/0/addresses/0",
                                "value": "192.0.2.1",
                            }
                        ]
                    ),
                ]
            )
            try:
                ops_bridge.connect(state, settings, project, check=True)
            except ValueError as error:
                if "address changed" not in str(error):
                    raise
            else:
                raise ValueError("Stale route was not rejected")
            ops_bridge.connect(state, settings, project)
            ops_bridge.connect(state, settings, project, check=True)
            report["stale_route_rejected_and_refreshed"] = True
            fixture = json.loads(
                (
                    REPOSITORY_ROOT
                    / "backend/ops-service/apps/evaluations/capture_catalog.json"
                ).read_text()
            )[0]["fixture"]
            digest = hashlib.sha256(
                (
                    REPOSITORY_ROOT / "evaluation/support-program-evidence" / fixture
                ).read_bytes()
            ).hexdigest()
            probe = {
                "apiVersion": "v1",
                "kind": "Pod",
                "metadata": {"name": "ops-bridge-probe", "namespace": NAMESPACE},
                "spec": {
                    "automountServiceAccountToken": False,
                    "restartPolicy": "Never",
                    "securityContext": {
                        "runAsNonRoot": True,
                        "runAsUser": 10001,
                        "seccompProfile": {"type": "RuntimeDefault"},
                    },
                    "containers": [
                        {
                            "name": "probe",
                            "image": image,
                            "imagePullPolicy": "Never",
                            "command": ["python", "-c", "import time; time.sleep(600)"],
                            "securityContext": {
                                "readOnlyRootFilesystem": True,
                                "allowPrivilegeEscalation": False,
                                "capabilities": {"drop": ["ALL"]},
                            },
                            "resources": {
                                "requests": {"cpu": "10m", "memory": "32Mi"},
                                "limits": {"cpu": "200m", "memory": "128Mi"},
                            },
                            "env": [
                                {
                                    "name": "LLMOPS_ARTIFACT_TOKEN",
                                    "valueFrom": {
                                        "secretKeyRef": {
                                            "name": "ops-bridge-probe",
                                            "key": "LLMOPS_ARTIFACT_TOKEN",
                                        }
                                    },
                                },
                                {"name": "EVIDENCE_FILE", "value": fixture},
                                {"name": "EVIDENCE_SHA256", "value": digest},
                            ],
                        }
                    ],
                },
            }
            execute(kube + ["create", "-f", "-"], data=json.dumps(probe))
            execute(
                nk
                + [
                    "wait",
                    "--for=condition=Ready",
                    "pod/ops-bridge-probe",
                    "--timeout=90s",
                ],
                timeout=110,
            )
            report["checks"] = json.loads(
                execute(
                    nk + ["exec", "-i", "ops-bridge-probe", "--", "python", "-"],
                    data=PROBE,
                    timeout=120,
                )
            )
            if args.evaluate:
                from smoke_ops_evaluation import verify

                verify(
                    state,
                    settings,
                    compose,
                    compose_env,
                    image,
                    args.kind,
                    args.helm,
                    report,
                    evaluation_runtime=args.evaluation_runtime,
                )
            report["status"] = "PASS"
            print(
                "PASS: real Pod DNS, Prefect HTTP, artifact authentication/read-only access and evidence SHA-256",
                flush=True,
            )
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report["error"] = type(error).__name__
            # Record command identity only. Secret JSON, env files and response bodies are never reported.
            if isinstance(error, subprocess.CalledProcessError):
                report["failed_command"] = [str(part) for part in error.cmd]
                report["probe_errors"] = re.findall(
                    r"BRIDGE_[A-Z_0-9]+", error.stderr or ""
                )
                print(
                    "Smoke failed: "
                    + ", ".join(
                        report["probe_errors"] or ["inspect failed_command in report"]
                    ),
                    flush=True,
                )
            raise
        finally:
            cleanup_errors = []
            if cluster_started:
                try:
                    execute(
                        [args.kind, "delete", "cluster", "--name", cluster], timeout=180
                    )
                except (OSError, subprocess.SubprocessError):
                    cleanup_errors.append("kind cluster")
            if compose_started:
                try:
                    execute(
                        compose + ["down", "--volumes"], timeout=180, env=compose_env
                    )
                except (OSError, subprocess.SubprocessError):
                    cleanup_errors.append("isolated Compose fixtures")
            if image:
                try:
                    execute(["docker", "image", "rm", image], timeout=60)
                except (OSError, subprocess.SubprocessError):
                    cleanup_errors.append("temporary probe image tag")
            report["cleanup_errors"] = cleanup_errors
            if cleanup_errors:
                report["status"] = "FAIL"
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, indent=2) + "\n")
            if cleanup_errors:
                raise RuntimeError(
                    "Smoke cleanup failed; inspect only the reported fixture identities"
                )


if __name__ == "__main__":
    main()
