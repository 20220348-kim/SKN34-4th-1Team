#!/usr/bin/env python3
"""Render the reviewed host script as an SSM document (no AWS writes)."""
import json
from pathlib import Path


def document():
    image = '^$|^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/govbiz/{service}@sha256:[0-9a-f]{64}$'
    parameters = {
        'Mode': {'allowedValues': ['check', 'deploy'], 'default': 'check'},
        'Commit': {'allowedPattern': '^$|^[0-9a-f]{40}$', 'default': ''},
        'CoreImage': {'allowedPattern': image.replace('{service}', 'core-service'), 'default': ''},
        'AiImage': {'allowedPattern': image.replace('{service}', 'ai-service'), 'default': ''},
    }
    for parameter in parameters.values():
        parameter.update(type='String', interpolationType='ENV_VAR')
    script = Path(__file__).with_name('deploy_host.py').read_text()
    return {'schemaVersion': '2.2', 'description': 'GovBiz image-only backend release; stateful services and host secrets preserved',
            'parameters': parameters, 'mainSteps': [{'action': 'aws:runShellScript', 'name': 'DeployBackend',
            'inputs': {'timeoutSeconds': '1800', 'runCommand': ["python3 - <<'GOVBIZ_HOST_PY'\n" + script + '\nGOVBIZ_HOST_PY']}}]}


if __name__ == '__main__':
    print(json.dumps(document()))
