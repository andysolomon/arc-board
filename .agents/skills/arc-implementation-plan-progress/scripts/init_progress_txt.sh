#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 <plan-file> [progress-file]" >&2
  exit 1
fi

PLAN_FILE="$1"
PROGRESS_FILE="${2:-progress.txt}"

if [[ ! -f "$PLAN_FILE" ]]; then
  echo "Plan file not found: $PLAN_FILE" >&2
  exit 1
fi

TMP_NEW="$(mktemp)"
TMP_MERGED="$(mktemp)"
trap 'rm -f "$TMP_NEW" "$TMP_MERGED"' EXIT

TITLE="$(basename "$PLAN_FILE" .md)"
NOW="$(date "+%Y-%m-%d %H:%M:%S %Z")"

{
  echo "${TITLE} - Progress"
  echo "Generated: ${NOW}"
  echo
} > "$TMP_NEW"

# Capture phase headings like:
# - ## Phase 1 - Foundation
# - ## Phase A - Security
# - ## 1) Phase 1: Foundation
PHASES="$(rg '^\s*##\s+((Phase\s+[A-Za-z0-9]+)|([0-9]+\)\s+Phase\s+[A-Za-z0-9]+)).*$' "$PLAN_FILE" || true)"

if [[ -z "$PHASES" ]]; then
  # Fallback: any level-2 heading
  PHASES="$(rg '^\s*##\s+.+$' "$PLAN_FILE" || true)"
fi

if [[ -z "$PHASES" ]]; then
  echo "[ ] 1.0 - Plan review and task decomposition" >> "$TMP_NEW"
  echo "    [ ] 1.1 - Confirm milestones and dependencies" >> "$TMP_NEW"
else
  INDEX=1
  while IFS= read -r line; do
    heading="$(echo "$line" | sed -E 's/^[[:space:]]*##[[:space:]]+//')"
    echo "[ ] ${INDEX}.0 - ${heading}" >> "$TMP_NEW"
    echo "    [ ] ${INDEX}.1 - Define detailed implementation tasks" >> "$TMP_NEW"
    echo "    [ ] ${INDEX}.2 - Implement and verify deliverables" >> "$TMP_NEW"
    INDEX=$((INDEX + 1))
  done <<< "$PHASES"
fi

if [[ ! -f "$PROGRESS_FILE" ]]; then
  mv "$TMP_NEW" "$PROGRESS_FILE"
  echo "Created $PROGRESS_FILE"
  exit 0
fi

# Merge mode: preserve completed entries from existing file where labels match.
cp "$TMP_NEW" "$TMP_MERGED"
while IFS= read -r done_line; do
  label="$(echo "$done_line" | sed -E 's/^\[x\]\s*//')"
  if [[ -n "$label" ]]; then
    sed -i '' -E "s|^\[ \][[:space:]]*${label//\//\\/}$|[x] ${label}|" "$TMP_MERGED" || true
  fi
done < <(rg '^\[x\]\s+' "$PROGRESS_FILE" || true)

mv "$TMP_MERGED" "$PROGRESS_FILE"
echo "Updated $PROGRESS_FILE (completed items preserved where labels matched)"
