#!/usr/bin/env bash
set -euo pipefail

# Midline Journal — Safe Restore Script (from rclone / Google Drive or local backup folder)
#
# Usage:
#   # Restore from rclone remote (default: gdrive:MidlineBackup)
#   RCLONE_REMOTE="gdrive:MidlineBackup" ./scripts/restore.sh
#
#   # Restore from a local backup folder containing midline.db (and optional uploads/)
#   ./scripts/restore.sh --from /path/to/backup-folder
#
# Optional flags:
#   --yes   Skip interactive confirmation prompt
#
# IMPORTANT: Stop Midline before restoring (e.g., `docker compose down` or `systemctl --user stop midline`).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="${DATA_DIR:-$PROJECT_DIR/data}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive:MidlineBackup}"
LOCAL_SOURCE=""
AUTO_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from)
      LOCAL_SOURCE="${2:-}"
      shift 2
      ;;
    --yes|-y)
      AUTO_YES=1
      shift
      ;;
    -h|--help)
      sed -n '3,16p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Guard: refuse to overwrite while Midline server is running
if pgrep -f "server/dist/index.js" >/dev/null 2>&1; then
  echo "Error: Midline appears to be running." >&2
  echo "Please stop it first before restoring:" >&2
  echo "  Docker:  docker compose down" >&2
  echo "  Systemd: systemctl --user stop midline" >&2
  exit 1
fi

if [ -z "$LOCAL_SOURCE" ] && ! command -v rclone >/dev/null 2>&1; then
  echo "Error: rclone is not installed. Install rclone or use '--from /path/to/local/backup'." >&2
  exit 1
fi

SOURCE_DESC="${LOCAL_SOURCE:-$RCLONE_REMOTE}"
echo "Restore source: $SOURCE_DESC"
echo "Target data dir: $DATA_DIR"

if [ "$AUTO_YES" -ne 1 ]; then
  read -r -p "This will replace the current data in '$DATA_DIR' (a safety copy will be kept). Continue? [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Restore cancelled."; exit 0 ;;
  esac
fi

STAGE_DIR="$(mktemp -d -t midline-restore-XXXXXX)"
cleanup() { rm -rf "$STAGE_DIR"; }
trap cleanup EXIT

# Step 1: Fetch backup into staging directory first (so a failed download never harms existing data)
if [ -n "$LOCAL_SOURCE" ]; then
  if [ ! -f "$LOCAL_SOURCE/midline.db" ]; then
    echo "Error: $LOCAL_SOURCE/midline.db not found." >&2
    exit 1
  fi
  echo "Copying database from local backup..."
  cp "$LOCAL_SOURCE/midline.db" "$STAGE_DIR/midline.db"
  if [ -d "$LOCAL_SOURCE/uploads" ]; then
    echo "Copying photos from local backup..."
    mkdir -p "$STAGE_DIR/uploads"
    cp -a "$LOCAL_SOURCE/uploads/." "$STAGE_DIR/uploads/"
  fi
else
  echo "Downloading database from $RCLONE_REMOTE/midline.db..."
  rclone copyto "$RCLONE_REMOTE/midline.db" "$STAGE_DIR/midline.db"

  echo "Downloading photos from $RCLONE_REMOTE/uploads (if present)..."
  mkdir -p "$STAGE_DIR/uploads"
  rclone copy "$RCLONE_REMOTE/uploads" "$STAGE_DIR/uploads" || true
fi

# Step 2: Verify SQLite integrity before swapping in
if command -v sqlite3 >/dev/null 2>&1; then
  echo "Verifying SQLite database integrity..."
  CHECK="$(sqlite3 "$STAGE_DIR/midline.db" "PRAGMA integrity_check;")"
  if [ "$CHECK" != "ok" ]; then
    echo "Error: Restored database failed integrity check: $CHECK" >&2
    exit 1
  fi
  echo "Integrity check passed (ok)."
fi

# Step 3: Save safety backup of existing local data (if present)
if [ -f "$DATA_DIR/midline.db" ]; then
  SAFETY_DIR="${DATA_DIR}.pre-restore-$(date +%Y%m%d-%H%M%S)"
  echo "Saving safety backup of existing data to $SAFETY_DIR..."
  cp -a "$DATA_DIR" "$SAFETY_DIR"
fi

# Step 4: Swap restored files into DATA_DIR and clear stale WAL/SHM sidecars
mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/thumbs"
rm -f "$DATA_DIR/midline.db-wal" "$DATA_DIR/midline.db-shm"
cp "$STAGE_DIR/midline.db" "$DATA_DIR/midline.db"

if [ -d "$STAGE_DIR/uploads" ] && [ "$(ls -A "$STAGE_DIR/uploads" 2>/dev/null)" ]; then
  cp -a "$STAGE_DIR/uploads/." "$DATA_DIR/uploads/"
fi

echo ""
echo "Restore complete!"
echo "Start Midline again:"
echo "  Docker:  docker compose up -d"
echo "  Systemd: systemctl --user start midline"
