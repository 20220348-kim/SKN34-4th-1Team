"""Build local native Kubernetes smoke images sequentially, without push or real env files."""

import argparse
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
CONTEXTS = {
    "core-service": "backend/core-service",
    "catalog-service": "backend/catalog-service",
    "ai-service": "backend/ai-service",
    "ops-service": "backend/ops-service",
    "elasticsearch": "infrastructure/elasticsearch",
    "openai-stub": "infrastructure/stubs/openai",
    "bizinfo-stub": "infrastructure/stubs/bizinfo",
    "kstartup-stub": "infrastructure/stubs/kstartup",
    "public-notices-stub": "infrastructure/stubs/public-notices",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="Unique local tag, e.g. msa-20260920-001")
    parser.add_argument("--output", type=Path, required=True, help="New temporary JSON file outside the repository")
    args = parser.parse_args()
    if not re.fullmatch(r"msa-[a-z0-9][a-z0-9.-]{1,80}", args.tag):
        parser.error("Use a unique msa- prefixed tag")
    output = args.output.resolve()
    if output.is_relative_to(ROOT) or output.exists() or not output.parent.is_dir():
        parser.error("Output must be a new file in an existing temporary directory outside the repository")
    images = {name: f"govbiz-{name}:{args.tag}" for name in CONTEXTS}
    # Refuse to overwrite even a local image tag supplied by another task.
    for image in images.values():
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
            parser.error("Image tag already exists: " + image)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True))
    for name, context in CONTEXTS.items():
        print("Building " + name, flush=True)
        subprocess.run(["docker", "build", "--label", "org.opencontainers.image.revision=" + revision,
                        "--tag", images[name], str(ROOT / context)], check=True)
    identities = {name: json.loads(subprocess.check_output(["docker", "image", "inspect", image]))[0]["Id"]
                  for name, image in images.items()}
    with output.open("x") as file:
        json.dump({"images": images, "imageIds": identities, "revision": revision, "dirty": dirty}, file, indent=2)
    print("Local image manifest: " + str(output), flush=True)


if __name__ == "__main__":
    main()
