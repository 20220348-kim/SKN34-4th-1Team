"""Read verified storage Pods over private, temporary loopback forwards."""

import base64
import hashlib
import json
import re
import subprocess
import tempfile
import time
from contextlib import contextmanager
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from uuid import UUID

import evaluation_release as release
import network_status
import ops_volume_restore_probe as probe

FILES = (
    "request.json",
    "evaluation/manifest.json",
    "evaluation/comparison.json",
    "evaluation/report.html",
)


def require_pod(kube, expected):
    pod = release.pvc_restore.run(
        kube
        + [
            "--request-timeout=15s",
            "-n",
            release.NAMESPACE,
            "get",
            "pod",
            expected["name"],
            "-o",
            "json",
        ]
    )
    meta = pod["metadata"]
    containers = {
        row["name"]: {
            key: row[key] for key in ("imageID", "containerID", "restartCount")
        }
        for field in ("containerStatuses", "initContainerStatuses")
        for row in pod.get("status", {}).get(field, [])
    }
    if (
        meta.get("uid") != expected["uid"]
        or meta.get("name") != expected["name"]
        or meta.get("namespace") != release.NAMESPACE
        or not network_status.pod_ready(pod)
        or release.digest(release.encoded(pod["spec"])) != expected["specSha256"]
        or containers != expected["containers"]
    ):
        raise ValueError("Storage HTTP target changed or is no longer ready")


@contextmanager
def forward(kube, expected, remote):
    """Use kubectl's allocated port, never an existing listener or a Service selector."""
    if remote not in (4200, 8010) or not re.fullmatch(
        r"[a-z0-9][a-z0-9.-]{0,252}", expected["name"]
    ):
        raise ValueError("Invalid storage forward target")
    require_pod(kube, expected)
    process = None
    with tempfile.TemporaryFile(mode="w+t") as log:
        try:
            process = subprocess.Popen(
                [str(p) for p in kube]
                + [
                    "-n",
                    release.NAMESPACE,
                    "port-forward",
                    "--address=127.0.0.1",
                    "pod/" + expected["name"],
                    f"0:{remote}",
                ],
                stdout=log,
                stderr=log,
            )
            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    raise ValueError("Storage forward exited before readiness")
                log.seek(0)
                ports = re.findall(
                    rf"^Forwarding from 127\.0\.0\.1:(\d+) -> {remote}$",
                    log.read(4096),
                    re.MULTILINE,
                )
                if len(ports) == 1 and 1024 <= int(ports[0]) <= 65535:
                    break
                if time.monotonic() >= deadline:
                    raise TimeoutError("Storage forward readiness timed out")
                time.sleep(0.1)
            require_pod(kube, expected)
            yield int(ports[0]), process
            if process.poll() is not None:
                raise ValueError("Storage forward stopped during verification")
            require_pod(kube, expected)
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def response(port, path, token=None, *, limit=8 * 1024 * 1024):
    # Redirects/proxies must never receive the artifact token or report contents.
    class NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None

    if (
        type(port) is not int
        or not 1024 <= port <= 65535
        or not path.startswith(("/api/", "/v1/"))
        or any(c in path for c in ("\r", "\n", "\\", "#"))
    ):
        raise ValueError("Invalid storage HTTP route")
    if token is not None and not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("Invalid artifact token")
    request = Request(
        f"http://127.0.0.1:{port}" + path,
        method="GET",
        headers={} if token is None else {"Authorization": "Bearer " + token},
    )
    deadline = time.monotonic() + 10
    try:
        incoming = build_opener(ProxyHandler({}), NoRedirect()).open(request, timeout=3)
    except HTTPError as error:
        incoming = error
    with incoming:
        chunks, size = [], 0
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError("Storage response deadline exceeded")
            chunk = incoming.read1(min(65536, limit + 1 - size))
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                raise ValueError("Storage response exceeds its limit")
            chunks.append(chunk)
        raw = b"".join(chunks)
        if incoming.headers.get("Content-Length") is not None and incoming.headers[
            "Content-Length"
        ] != str(size):
            raise ValueError("Storage response length differs")
        return incoming.status, incoming.headers, raw


def verify(kube, pods, expected, entries, token):
    """GET only: compare completed records and four registered artifacts per run."""
    probe.expected_runs(expected)
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("Invalid artifact token")
    files = {}
    for request, row in expected.items():
        for name in FILES:
            file = entries[request + "/" + name]
            if (
                file["kind"] != "file"
                or not 0 < file["size"] <= 8 * 1024 * 1024
                or not re.fullmatch(r"[a-f0-9]{64}", file["sha256"])
            ):
                raise ValueError("Completed artifact is missing or exceeds its limit")
            if (
                name == "evaluation/report.html"
                and file["sha256"] != row["report_sha256"]
            ):
                raise ValueError(
                    "Completed report differs from the authenticated evidence"
                )
            files[request + "/" + name] = file
    deadline = time.monotonic() + 120

    def read(port, process, path, credential=None, *, artifact=False):
        if time.monotonic() >= deadline or process.poll() is not None:
            raise ValueError("Storage HTTP session expired or stopped")
        status, headers, raw = response(port, path, credential)
        if artifact and (
            headers.get("Cache-Control") != "no-store"
            or headers.get("X-Content-Type-Options") != "nosniff"
            or headers.get("Content-Length") != str(len(raw))
        ):
            raise ValueError("Artifact response protection headers differ")
        return status, raw

    with forward(kube, pods["ops-artifacts"], 8010) as (port, process):
        invalid = ("A" if token[0] != "A" else "B") + token[1:]
        paths = ["/v1/status"] + ["/v1/results/" + path for path in files]
        for path in paths:
            for credential in (None, invalid):
                status, raw = read(port, process, path, credential, artifact=True)
                if status != 401 or json.loads(raw) != {
                    "code": "ARTIFACT_AUTH_REQUIRED"
                }:
                    raise ValueError(
                        "Artifact server accepted unauthenticated or invalid credentials"
                    )
            status, raw = read(port, process, path, token, artifact=True)
            if status != 200:
                raise ValueError("Authenticated artifact retrieval failed")
            if path == "/v1/status":
                if json.loads(raw) != {"schema_version": 1, "results_readable": True}:
                    raise ValueError("Artifact storage health response differs")
            else:
                file = files[path.removeprefix("/v1/results/")]
                if (
                    len(raw) != file["size"]
                    or hashlib.sha256(raw).hexdigest() != file["sha256"]
                ):
                    raise ValueError(
                        "HTTP artifact differs from its authenticated archive"
                    )

    local = probe.prefect_runs(expected)
    with forward(kube, pods["prefect"], 4200) as (port, process):

        def prefect(path):
            status, raw = read(port, process, "/api" + path)
            if status != 200:
                raise ValueError("Prefect HTTP retrieval failed")
            return json.loads(raw)

        if prefect("/health") is not True:
            raise ValueError("Prefect health response differs")
        for request, row in local.items():
            flow = prefect("/flow_runs/" + row["flow_id"])
            marker = json.loads(
                base64.b64decode(
                    entries[request + "/request.json"]["data"], validate=True
                )
            )
            if (
                flow["id"] != row["flow_id"]
                or flow["state_type"] != "COMPLETED"
                or flow["state"]["type"] != "COMPLETED"
                or any(
                    flow["parameters"].get(key) != marker.get(key)
                    for key in (
                        "request_id",
                        "dataset_id",
                        "execution_mode",
                        "execution_spec",
                        "execution_spec_sha256",
                    )
                )
            ):
                raise ValueError("Prefect completed execution differs from the archive")
            deployment_id = str(UUID(flow["deployment_id"]))
            deployment = prefect("/deployments/" + deployment_id)
            if (
                deployment["id"] != deployment_id
                or deployment["flow_id"] != flow["flow_id"]
            ):
                raise ValueError("Prefect deployment linkage differs")
            history = prefect("/flow_run_states/?flow_run_id=" + row["flow_id"])
            states = [s for s in history if s["id"] == flow["state"]["id"]]
            if (
                len(states) != 1
                or states[0]["type"] != "COMPLETED"
                or states[0]["state_details"]["flow_run_id"] != flow["id"]
            ):
                raise ValueError("Prefect completed state history differs")
    return {
        "status": "VERIFIED",
        "scope": "pod_loopback_port_forward",
        "matchedReports": len(expected),
        "matchedArtifacts": len(files),
        "matchedPrefectExecutions": len(local),
        "sharedReviewCopies": len(expected) - len(local),
        "artifactAuthenticationVerified": True,
        "prefectHealthVerified": True,
        "forwardsClosed": True,
        "modelApiCalls": 0,
    }
