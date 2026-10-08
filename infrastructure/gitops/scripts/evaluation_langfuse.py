"""Read-only project authentication inside the existing owned Langfuse container."""

import ipaddress
import json
import re

import ops_state_snapshot as snapshot

# Use Langfuse's existing Node runtime. No arbitrary URL, redirect, proxy, model call,
# ingestion, new container, mounted file or command-line credential is involved.
AUTH_PROBE = r"""
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
function get(address, authorization) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: address, port: 3000, path: '/api/public/projects', method: 'GET',
      headers: authorization ? {Authorization: authorization} : {},
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16384) request.destroy(new Error('response_limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('response_aborted')));
      response.on('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks)}));
    });
    const timer = setTimeout(() => request.destroy(new Error('deadline')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}
(async () => {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const local = Object.values(os.networkInterfaces()).flat();
  if (!local.some(row => row.family === 'IPv4' && row.address === input.address && !row.internal))
    throw new Error('address_mismatch');
  const anonymous = await get(input.address);
  if (![401, 403].includes(anonymous.status)) throw new Error('anonymous_not_rejected');
  const pair = input.publicKey + ':' + input.secretKey;
  const authorization = 'Basic ' + Buffer.from(pair).toString('base64');
  const response = await get(input.address, authorization);
  if (response.status !== 200) throw new Error('authentication_failed');
  const body = JSON.parse(response.body.toString('utf8'));
  if (!Array.isArray(body.data) || body.data.length !== 1 || body.data[0]?.id !== input.projectId)
    throw new Error('project_mismatch');
  process.stdout.write(JSON.stringify({
    status: 'VERIFIED', anonymousRejected: true, projectMatched: true,
  }));
})().catch(() => {
  process.stdout.write(JSON.stringify({status: 'BLOCKED'}));
  process.exitCode = 1;
});
"""


def verify(project, credentials):
    """Validate original keys against the owned Compose container's own API."""
    if not isinstance(project, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
        raise ValueError("Invalid source Compose project")
    for name in ("LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
        value = credentials.get(name)
        if (
            not isinstance(value, str)
            or not 16 <= len(value) <= 4096
            or any(c.isspace() or ord(c) < 32 or c == ":" for c in value)
        ):
            raise ValueError("Invalid source Langfuse credentials")

    def observe():
        identities = (
            snapshot.storage.run(
                [
                    "docker",
                    "ps",
                    "--no-trunc",
                    "--filter",
                    "label=com.docker.compose.project=" + project,
                    "--filter",
                    "label=com.docker.compose.service=langfuse-web",
                    "--format",
                    "{{.ID}}",
                ],
                timeout=15,
            )
            .decode()
            .split()
        )
        if len(identities) != 1 or not re.fullmatch(r"[a-f0-9]{64}", identities[0]):
            raise ValueError("One running source Langfuse container is required")
        item = snapshot.storage.inspect(identities[0])
        labels = item["Config"].get("Labels") or {}
        env = snapshot.storage.environment(item)
        project_id = env.get("LANGFUSE_INIT_PROJECT_ID", "")
        network = item["NetworkSettings"]["Networks"].get(project + "_default", {})
        address = ipaddress.ip_address(network.get("IPAddress", ""))
        if (
            item["Id"] != identities[0]
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", item["Image"])
            or item["State"].get("Running") is not True
            or item["State"].get("Paused")
            or item["State"].get("Restarting")
            or labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != "langfuse-web"
            or str(labels.get("com.docker.compose.oneoff", "false")).lower() != "false"
            or len(env) != len(item["Config"]["Env"])
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", project_id)
            or address.version != 4
            or not address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_unspecified
            or address.is_multicast
            or not re.fullmatch(r"[a-f0-9]{64}", network.get("NetworkID", ""))
        ):
            raise ValueError("Source Langfuse identity or initialized project differs")
        return {
            "containerId": item["Id"],
            "image": item["Image"],
            "projectId": project_id,
            "startedAt": item["State"].get("StartedAt"),
            "restartCount": item.get("RestartCount"),
            "address": str(address),
            "networkId": network["NetworkID"],
        }

    before = observe()
    result = json.loads(
        snapshot.storage.run(
            ["docker", "exec", "-i", before["containerId"], "node", "-e", AUTH_PROBE],
            data=json.dumps(
                {
                    "publicKey": credentials["LANGFUSE_PUBLIC_KEY"],
                    "secretKey": credentials["LANGFUSE_SECRET_KEY"],
                    "projectId": before["projectId"],
                    "address": before["address"],
                }
            ).encode(),
            timeout=15,
        )
    )
    if result != {"status": "VERIFIED", "anonymousRejected": True, "projectMatched": True}:
        raise ValueError("Langfuse authentication did not verify the source project")
    if observe() != before:
        raise ValueError("Source Langfuse changed during authentication")
    return {
        "status": "VERIFIED",
        "scope": "compose_langfuse_container_authentication",
        "source": before,
        "anonymousRejected": True,
        "projectMatched": True,
        "kubernetesRouteVerified": False,
        "modelApiCalls": 0,
    }
