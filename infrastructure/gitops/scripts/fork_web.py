"""Keep Core and Ops loopback forwards together; never reuse another listener."""

import socket
import subprocess
import tempfile
import time
from contextlib import ExitStack, contextmanager

FORWARDS = (("core-service", 18080, 8080), ("ops-service", 18001, 8000))


def forward_targets(core_port=18080, ops_port=18001):
    for port in (core_port, ops_port):
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError("Core/Ops ports must be integers between 1024 and 65535")
    if core_port == ops_port:
        raise ValueError("Core and Ops must use different local ports")
    return (("core-service", core_port, 8080), ("ops-service", ops_port, 8000))


def check_ports(targets=FORWARDS):
    sockets = []
    try:
        for _, port, _ in targets:
            listener = socket.socket()
            sockets.append(listener)
            try:
                listener.bind(("127.0.0.1", port))
            except OSError:
                raise ValueError(
                    f"Loopback port {port} is occupied; select another --core-port/--ops-port and match the Vite K8S_*_PORT settings"
                ) from None
    finally:
        for listener in sockets:
            listener.close()


def ensure_running(processes):
    if any(process.poll() is not None for process in processes):
        raise ValueError(
            "A Kubernetes web forward stopped; restart fork_cluster.py web after checking the Pod"
        )


@contextmanager
def forwards(nk, *, core_port=18080, ops_port=18001):
    targets = forward_targets(core_port, ops_port)
    check_ports(targets)
    processes, logs = [], []
    with ExitStack() as stack:
        try:
            for service, port, remote in targets:
                log = stack.enter_context(tempfile.TemporaryFile(mode="w+t"))
                logs.append(log)
                process = subprocess.Popen(
                    [str(part) for part in nk]
                    + [
                        "port-forward",
                        "--address",
                        "127.0.0.1",
                        "deployment/" + service,
                        f"{port}:{remote}",
                    ],
                    stdout=log,
                    stderr=log,
                )
                processes.append(process)
            deadline = time.monotonic() + 90
            while True:
                ensure_running(processes)
                ready = []
                for log, (_, port, remote) in zip(logs, targets):
                    log.seek(0)
                    ready.append(
                        f"Forwarding from 127.0.0.1:{port} -> {remote}" in log.read()
                    )
                if all(ready):
                    break
                if time.monotonic() >= deadline:
                    raise ValueError("Core/Ops port-forward readiness timed out")
                time.sleep(0.2)
            yield processes
        finally:
            for process in processes:
                if process.poll() is None:
                    process.terminate()
            for process in processes:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            stack.close()


def serve(nk, *, core_port=18080, ops_port=18001):
    with forwards(nk, core_port=core_port, ops_port=ops_port) as processes:
        print(
            f"Core 127.0.0.1:{core_port} and Ops 127.0.0.1:{ops_port} forward to this cluster. "
            "Ctrl+C stops both forwards.\n"
            "In another Bash/WSL terminal at the repository root, run:\n"
            f"K8S_CORE_PORT={core_port} K8S_OPS_PORT={ops_port} pnpm --dir frontend/web dev:k8s",
            flush=True,
        )
        while True:
            ensure_running(processes)
            time.sleep(0.5)
