#!/bin/sh
set -eu

# Use a supplied artifact runtime without installing packages in the application.
: "${ARTIFACT_NODE:?Set ARTIFACT_NODE to the bundled Node executable}"
: "${ARTIFACT_NODE_MODULES:?Set ARTIFACT_NODE_MODULES to the bundled node_modules directory}"
case "${1:-}" in
  build-review-workbook.mjs|extract-review-csv.mjs) review_tool="$1" ;;
  *) echo "Usage: run-workbook-tool.sh build-review-workbook.mjs|extract-review-csv.mjs ARGS..." >&2; exit 2 ;;
esac
shift
test -x "$ARTIFACT_NODE"
test -d "$ARTIFACT_NODE_MODULES/@oai/artifact-tool"
review_script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
review_runtime=$(mktemp -d "${TMPDIR:-/tmp}/govbiz-review.XXXXXX")
cleanup() {
  rm -f "$review_runtime/tool.mjs" "$review_runtime/node_modules"
  rmdir "$review_runtime"
}
trap cleanup EXIT HUP INT TERM
ln -s "$ARTIFACT_NODE_MODULES" "$review_runtime/node_modules"
ln -s "$review_script_dir/$review_tool" "$review_runtime/tool.mjs"
"$ARTIFACT_NODE" --preserve-symlinks-main "$review_runtime/tool.mjs" "$@"
