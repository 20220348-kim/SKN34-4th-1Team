"""Check the nested GitOps boundary and links inside the unified repository.

This is not a Kubernetes schema, cluster, or Argo CD deployment check.
"""

from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
REQUIRED = (
    "README.md",
    "argocd/README.md",
    "environments/README.md",
    "docs/repository-transition.md",
)
MOVED = (
    ".gitmodules",
    ".env.example",
    "compose.yaml",
    "compose.django.yaml",
    "compose.existing-data.yaml",
    "scripts/check-compose.py",
    "infrastructure/scripts/check-compose.py",
    ".github/workflows",
)


def index_errors(entries):
    errors = []
    for entry in entries:
        metadata, path = entry.split("\t", 1)
        if metadata.split()[0] == "160000":
            errors.append(f"Application submodule still tracked: {path}")
        elif path.startswith("services/"):
            errors.append(f"Application source still tracked: {path}")
    return errors


def file_errors(root, repository_root=None):
    root = root.resolve()
    repository_root = root if repository_root is None else repository_root.resolve()
    errors = []
    for name in REQUIRED:
        if not (root / name).is_file():
            errors.append(f"Missing repository guide: {name}")
    for name in MOVED:
        if (root / name).exists():
            errors.append(f"Configuration belongs at the unified repository root, not inside GitOps: {name}")
    documents = list(root.glob("*.md"))
    for name in ("docs", "argocd", "environments"):
        documents.extend((root / name).rglob("*.md"))
    for document in documents:
        # Do not inspect ignored legacy services, .env files, or network resources.
        for link in re.findall(r"\[[^\]]*\]\(([^\s)]+)\)", document.read_text(encoding="utf-8")):
            parsed = urlsplit(link.strip("<>"))
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            target = (document.parent / unquote(parsed.path)).resolve()
            if not target.is_relative_to(repository_root) or not target.exists():
                errors.append(f"Broken or external local link in {document.relative_to(root)}: {link}")
    return errors


def main():
    index = subprocess.run(
        ["git", "ls-files", "--stage", "-z", "--", "."],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    errors = index_errors(entry for entry in index.split("\0") if entry)
    errors.extend(file_errors(ROOT, ROOT.parents[1]))
    if errors:
        raise SystemExit("\n".join(errors))
    print("PASS: nested GitOps boundary and unified-repository documentation links.")
    print("This boundary check does not validate Kubernetes resources or Argo CD runtime; run their separate checks.")


if __name__ == "__main__":
    main()
