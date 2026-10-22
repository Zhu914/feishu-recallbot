#!/usr/bin/env bash
# Remove files under outputs/ older than N days. Dry-run unless --apply is given.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUTS="$ROOT/outputs"
DAYS=15; APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1; shift;;
    --days) DAYS="$2"; shift 2;;
    *) echo "usage: $0 [--apply] [--days N]" >&2; exit 2;;
  esac
done
[[ -d "$OUTPUTS" ]] || exit 0
now=$(date +%s); threshold=$((now - DAYS * 86400))
while IFS= read -r f; do
  [[ "$(basename "$f")" == ".gitkeep" ]] && continue
  mt=$(stat -f "%m" "$f" 2>/dev/null || echo 0)
  if (( mt <= threshold )); then
    echo "delete: ${f#"$OUTPUTS"/}"
    [[ $APPLY == 1 ]] && rm -f "$f"
  fi
done < <(find "$OUTPUTS" -type f)
[[ $APPLY == 0 ]] && echo "dry run; pass --apply to delete"
