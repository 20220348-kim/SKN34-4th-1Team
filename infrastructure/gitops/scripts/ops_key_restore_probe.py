"""Exercise recovered Ops keys inside an isolated, networkless Ops image."""

import hashlib
import hmac
import json
import os
import secrets
import sys
from pathlib import Path

SALT = "govbiz-ops-runtime-key-recovery-v1"


def exercise(action, keys, proof=None):
    from django.conf import settings
    from django.core import signing

    from apps.evaluations.artifact_server import application

    # Never inherit model credentials, database routes or Django fallback keys.
    os.environ.clear()
    settings.configure(SECRET_KEY=keys["django"], SECRET_KEY_FALLBACKS=[])
    nonce = secrets.token_hex(32) if action == "capture" else proof["nonce"]
    tags = {
        name: hmac.new(
            value.encode(), (SALT + "\n" + nonce + "\n" + name).encode(), hashlib.sha256
        ).hexdigest()
        for name, value in keys.items()
        if value
    }
    if action == "capture":
        signed = signing.dumps({"nonce": nonce}, key=keys["django"], salt=SALT)
    elif action == "verify":
        if set(tags) != set(proof["tags"]) or any(
            not hmac.compare_digest(value, proof["tags"][name]) for name, value in tags.items()
        ):
            raise ValueError("Recovered key differs")
        signed = proof["django_signature"]
    else:
        raise ValueError("Unsupported key probe")
    if signing.loads(signed, key=keys["django"], salt=SALT, fallback_keys=[]) != {"nonce": nonce}:
        raise ValueError("Django signature recovery failed")
    try:
        signing.loads(signed, key=secrets.token_hex(32), salt=SALT, fallback_keys=[])
    except signing.BadSignature:
        pass
    else:
        raise ValueError("Wrong Django key was accepted")
    root = Path("/tmp/key-probe")
    root.mkdir()
    app = application(root, root, keys["artifact"])
    for token, expected in (
        (keys["artifact"], "200 OK"),
        ("wrong-token", "401 Unauthorized"),
        ("", "401 Unauthorized"),
    ):
        statuses = []
        body = b"".join(
            app(
                {
                    "HTTP_AUTHORIZATION": "Bearer " + token,
                    "REQUEST_METHOD": "GET",
                    "QUERY_STRING": "",
                    "PATH_INFO": "/v1/status",
                },
                lambda status, headers, statuses=statuses: statuses.append(status),
            )
        )
        if statuses != [expected] or (
            expected == "200 OK"
            and json.loads(body) != {"schema_version": 1, "results_readable": True}
        ):
            raise ValueError("Recovered artifact token was not enforced")
    if action == "capture":
        return {"nonce": nonce, "tags": tags, "django_signature": signed}
    return {
        "status": "VERIFIED",
        "django_signature_verified": True,
        "artifact_wsgi_auth_verified": True,
        "key_count": len(tags),
    }


if __name__ == "__main__":
    try:
        value = json.load(sys.stdin)
        result = exercise(sys.argv[1], value["keys"], value.get("proof"))
        print(json.dumps(result))
    except Exception:
        # Private stdin must never appear in traceback or container logs.
        sys.exit(1)
