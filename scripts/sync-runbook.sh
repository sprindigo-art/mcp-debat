#!/bin/bash
# sync-runbook.sh — TARGET-LOCKED: sync exactly ONE runbook to MCP Debat server.
# Usage: sync-runbook.sh /path/to/RUNBOOK_target.md
# Runs background (non-blocking). Validates input. Logs to /tmp/sync-runbook.log.

REMOTE="ubuntu@config.mindkeepr.com:/var/www/mcp/debat/runbooks/"
SSH_KEY="/home/kali/.ssh/aligno_key"
LOCKFILE="/tmp/sync-runbook.lock"
LOGFILE="/tmp/sync-runbook.log"
ALLOWED_DIR="/home/kali/Desktop/mcp-memori/runbooks"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOGFILE"; }

# --- Validation ---
FILEPATH="$1"
if [ -z "$FILEPATH" ]; then
  log "FAIL: no argument provided"
  exit 0
fi

BASENAME=$(basename "$FILEPATH")

if [[ "$BASENAME" != RUNBOOK_*.md ]]; then
  log "SKIP: not a RUNBOOK file: $BASENAME"
  exit 0
fi

REALDIR=$(cd "$(dirname "$FILEPATH")" 2>/dev/null && pwd)
if [ "$REALDIR" != "$ALLOWED_DIR" ]; then
  log "FAIL: path not in allowed dir: $REALDIR (expected $ALLOWED_DIR)"
  exit 0
fi

if [ ! -f "$FILEPATH" ]; then
  log "FAIL: file not found: $FILEPATH"
  exit 0
fi

# --- Background sync (non-blocking) ---
(
  if [ -f "$LOCKFILE" ]; then
    log "SKIP: sync already in progress (lockfile exists)"
    exit 0
  fi
  touch "$LOCKFILE"
  sleep 3

  rsync -az \
    -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=no" \
    "$FILEPATH" \
    "$REMOTE" 2>/dev/null

  RSYNC_EXIT=$?
  rm -f "$LOCKFILE"

  if [ $RSYNC_EXIT -eq 0 ]; then
    log "OK: synced $BASENAME ($(stat -c%s "$FILEPATH") bytes)"
  else
    log "FAIL: rsync exit $RSYNC_EXIT for $BASENAME"
  fi
) &
disown

exit 0
