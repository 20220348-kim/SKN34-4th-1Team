"""Keep Core and Ops loopback forwards together; never reuse another listener."""

import socket
import subprocess
import tempfile
import time
from contextlib import ExitStack, contextmanager

FORWARDS = (("core-service", 18080, 8080), ("ops-service", 18001, 8000))


def check_ports():
    sockets = []
    try:
        for _, port, _ in FORWARDS:
            listener = socket.socket()
            sockets.append(listener)
            try:
                listener.bind(("127.0.0.1", port))
            except OSError:
                raise ValueError(
                    f"Loopback port {port} is occupied; stop or reconfigure its owner explicitly"
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
def forwards(nk):
    check_ports()
    processes, logs = [], []
    with ExitStack() as stack:
        try:
            for service, port, remote in FORWARDS:
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
                for log, (_, port, remote) in zip(logs, FORWARDS):
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


def serve(nk):
    with forwards(nk) as processes:
        print(
            "Core 127.0.0.1:18080 and Ops 127.0.0.1:18001 forward to this cluster. "
            "Start Vite with --mode portfolio; Ctrl+C stops both forwards.",
            flush=True,
        )
        while True:
            ensure_running(processes)
            time.sleep(0.5)
