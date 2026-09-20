"""Build and smoke-test the default Gunicorn image without external network or DB access."""

import json
import subprocess
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def docker(*arguments, capture=False, check=True):
    return subprocess.run(
        ["docker", *arguments],
        check=check,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def request(container, path, host="localhost"):
    # Execute inside a network-isolated container; no host ports or real env files are used.
    code = """
import json, sys, urllib.error, urllib.request
request = urllib.request.Request('http://127.0.0.1:8000' + sys.argv[1],
                                 headers={'Host': sys.argv[2]})
try:
    response = urllib.request.urlopen(request, timeout=5)
except urllib.error.HTTPError as error:
    response = error
with response:
    print(json.dumps({'status': response.status, 'body': response.read().decode()}))
"""
    result = docker("exec", container, "python", "-c", code, path, host, capture=True)
    return json.loads(result.stdout)


def main():
    name = "govbiz-ops-service-image-check-" + uuid.uuid4().hex[:12]
    image = name + ":test"
    built = False
    created = False
    try:
        docker("build", "--tag", image, str(ROOT))
        built = True
        config = json.loads(docker("image", "inspect", image, capture=True).stdout)[0]["Config"]
        require(config["User"] == "10001:10001", "Image must declare a numeric non-root user.")
        require(config["Cmd"][0] == "gunicorn", "Image default command must run Gunicorn.")
        docker(
            "run",
            "--detach",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges:true",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=16m,uid=10001,gid=10001,mode=1770",
            "--env",
            "DJANGO_SECRET_KEY=image-test-only-no-production-secret-2026",
            "--env",
            "DJANGO_DEBUG=false",
            "--env",
            "DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1",
            "--env",
            "DB_PASSWORD=image-test-only-no-database",
            "--env",
            "DB_HOST=127.0.0.1",
            "--env",
            "DB_PORT=9",
            image,
        )
        created = True
        deadline = time.monotonic() + 30
        while True:
            try:
                response = request(name, "/api/v1/health")
                require(response["status"] == 200, "Gunicorn liveness did not return 200.")
                break
            except subprocess.CalledProcessError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Gunicorn did not start within 30 seconds.") from None
                time.sleep(0.5)
        require(
            json.loads(response["body"]) == {"status": "UP", "service": "govbiz-ops-service"},
            "The public liveness response changed.",
        )
        readiness = request(name, "/api/v1/health/ready")
        require(readiness["status"] == 503, "Readiness must fail when its DB is unavailable.")
        require(
            json.loads(readiness["body"]) == {"status": "DOWN", "checks": {"database": "DOWN"}},
            "Readiness must not expose database errors.",
        )
        require(
            request(name, "/api/v1/health", "unrecognized.invalid")["status"] == 400,
            "The image must reject hosts outside DJANGO_ALLOWED_HOSTS.",
        )
        require(
            docker("exec", name, "id", "-u", capture=True).stdout.strip() == "10001",
            "The running process must not use root.",
        )
        docker("stop", "--time", "30", name)
        state = json.loads(docker("inspect", name, capture=True).stdout)[0]["State"]
        require(state["ExitCode"] == 0, "Gunicorn did not terminate gracefully.")
        print("Gunicorn image: non-root/read-only, health, DB failure, Host and SIGTERM OK.")
    except BaseException:
        if created:
            docker("logs", name, check=False)
        raise
    finally:
        # Only this invocation's random, fixture-only container/image may be removed.
        if created:
            docker("rm", "--force", name, check=False)
        if built:
            docker("image", "rm", image, check=False)


if __name__ == "__main__":
    main()
