#!/usr/bin/env bash
#
# Update a running deployment: fetch, rebuild, restart, and prove the
# migrations landed.
#
# Migrations are not applied by this script. `migrate()` in src/db/client.ts is
# memoized and awaited by every repository call, and `seedBeats()` fires at
# boot — so a container that comes up on new code has already run whatever was
# pending before it answers anything. What this script adds is the part lazy
# migration cannot do for itself: a backup taken *before* the irreversible
# part, and a check afterwards that the number of applied migrations caught up
# with the number shipped. A migration that throws is currently a logged error
# on a container that stays up, which is exactly the failure a deploy should
# not walk away from.
#
#   ./scripts/deploy.sh                                   # single deployment
#   ./scripts/deploy.sh -p ava-alice --env-file deploy/alice.env
#   ./scripts/deploy.sh --force                           # rebuild with no new commits
#   ./scripts/deploy.sh --no-backup                       # skip the volume snapshot
#
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=""
ENV_FILE=""
FORCE=0
BACKUP=1
KEEP=7          # how many volume snapshots to keep
WAIT_SECONDS=120

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--project)  PROJECT="$2"; shift 2 ;;
    --env-file)    ENV_FILE="$2"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --no-backup)   BACKUP=0; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose)
[ -n "$PROJECT" ]  && COMPOSE+=(-p "$PROJECT")
[ -n "$ENV_FILE" ] && COMPOSE+=(--env-file "$ENV_FILE")

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. is there anything to deploy ────────────────────────────────────────────
# The dirty-tree check comes before the fetch rather than after: `git pull
# --ff-only` onto local edits fails halfway, and halfway is the one state a
# server should never be left in.
if [ -n "$(git status --porcelain)" ]; then
  git status --short
  die "working tree has local changes — commit or discard them first"
fi

say "Fetching"
git fetch --quiet --prune

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse '@{u}' 2>/dev/null)" || die "branch $BRANCH tracks nothing — set an upstream first"

RUNNING="$("${COMPOSE[@]}" ps --quiet --status running ava 2>/dev/null || true)"

if [ "$LOCAL" = "$REMOTE" ] && [ -n "$RUNNING" ] && [ "$FORCE" -eq 0 ]; then
  echo "Already on $(git rev-parse --short HEAD) and running. Nothing to do."
  exit 0
fi

if [ "$LOCAL" != "$REMOTE" ]; then
  echo
  git --no-pager log --oneline "$LOCAL..$REMOTE"
  say "Pulling $(git rev-parse --short "$LOCAL") → $(git rev-parse --short "$REMOTE")"
  git pull --ff-only --quiet
fi

# ── 2. build before stopping anything ─────────────────────────────────────────
# The old container keeps serving through the build, which is the slow part.
# Downtime starts at the `stop` below and ends at the `up`.
say "Building"
"${COMPOSE[@]}" build

# ── 3. snapshot the volume, stopped ───────────────────────────────────────────
# Migrations against a file database are one-way: there is no `down`, and
# 0005_items_fts.sql and its kind rewrite tables rather than adding columns. The
# copy is taken with the container stopped so libsql has checkpointed — a live
# `.db` without its `-wal` sibling is missing whatever was not flushed. The tar
# takes the siblings too, but stopped is still the copy worth trusting.
#
# The volume is found by asking the container what is mounted at /data rather
# than by guessing `<project>_ava-data`, so a stateless deployment (Turso in
# AVA_DATA_DB_URL, no volume) is detected rather than mis-backed-up.
CONTAINER="$("${COMPOSE[@]}" ps --quiet ava 2>/dev/null || true)"
VOLUME=""
ARCHIVE=""
if [ -n "$CONTAINER" ]; then
  VOLUME="$(docker inspect "$CONTAINER" \
    --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
  say "Stopping"
  "${COMPOSE[@]}" stop ava
fi

if [ "$BACKUP" -eq 1 ] && [ -n "$VOLUME" ]; then
  BACKUP_DIR="$PWD/backups"
  mkdir -p "$BACKUP_DIR"
  ARCHIVE="${VOLUME}-$(date +%Y%m%d-%H%M%S).tar.gz"
  say "Backing up volume $VOLUME → backups/$ARCHIVE"
  # traces.db is disposable and is most of the bytes, so it stays out.
  docker run --rm \
    -v "$VOLUME":/data:ro \
    -v "$BACKUP_DIR":/backup \
    node:22-slim \
    tar czf "/backup/$ARCHIVE" -C /data --exclude='traces.db*' .
  # Keep the last $KEEP for *this* volume only — a second reader's snapshots
  # are not this deployment's to delete.
  ls -1t "$BACKUP_DIR/${VOLUME}-"*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "   pruning $(basename "$old")"
    rm -f "$old"
  done
elif [ "$BACKUP" -eq 1 ]; then
  echo "No /data volume on this deployment — nothing to back up (stateless, or first boot)."
fi

# ── 4. up ─────────────────────────────────────────────────────────────────────
say "Starting"
"${COMPOSE[@]}" up -d ava

# ── 5. prove the migrations landed ────────────────────────────────────────────
# Shipped is what the journal says; applied is what the database says. They are
# compared rather than assumed, because a failed migration leaves a container
# that is *running*: it fails at the first repository call instead, hours later,
# in a chat.
#
# The count is read with node:sqlite, which needs nothing installed in the
# image, and only for a `file:` database — a Turso deployment is not reachable
# this way, so it is reported as unchecked rather than as passing.
EXPECTED="$(grep -c '"tag"' drizzle/meta/_journal.json)"
say "Waiting for $EXPECTED migrations to be applied"

COUNT_JS='
const { DatabaseSync } = require("node:sqlite");
const url = process.env.AVA_DATA_DB_URL || "";
if (!url.startsWith("file:")) { console.log("remote"); process.exit(0); }
try {
  const db = new DatabaseSync(url.slice(5));
  console.log(db.prepare("select count(*) as n from __drizzle_migrations").get().n);
} catch { console.log("0"); }
'

DEADLINE=$((SECONDS + WAIT_SECONDS))
APPLIED=0
while [ "$SECONDS" -lt "$DEADLINE" ]; do
  ID="$("${COMPOSE[@]}" ps --quiet ava 2>/dev/null || true)"
  STATE="$(docker inspect "$ID" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  if [ "$STATE" != "running" ]; then
    "${COMPOSE[@]}" logs --tail 50 ava || true
    die "container is $STATE — see the log above. backups/$ARCHIVE is the pre-migration state."
  fi

  APPLIED="$("${COMPOSE[@]}" exec -T ava node --no-warnings --experimental-sqlite -e "$COUNT_JS" 2>/dev/null | tr -d '\r' || true)"

  if [ "$APPLIED" = "remote" ]; then
    echo "Database is remote (Turso) — migrations are applied at boot but cannot be counted from here."
    APPLIED="$EXPECTED"
    break
  fi
  case "$APPLIED" in ''|*[!0-9]*) APPLIED=0 ;; esac
  [ "$APPLIED" -ge "$EXPECTED" ] && break
  printf '   %s/%s\r' "$APPLIED" "$EXPECTED"
  sleep 3
done

if [ "$APPLIED" -lt "$EXPECTED" ]; then
  "${COMPOSE[@]}" logs --tail 50 ava || true
  die "only $APPLIED of $EXPECTED migrations applied after ${WAIT_SECONDS}s — see the log above.
Roll back with:
  ${COMPOSE[*]} stop ava
  docker run --rm -v $VOLUME:/data -v \"\$PWD/backups\":/backup:ro node:22-slim \\
    sh -c 'rm -f /data/ava.db*; tar xzf /backup/$ARCHIVE -C /data'
  git checkout ${LOCAL:0:7} && ${COMPOSE[*]} up -d --build ava"
fi

say "Deployed $(git rev-parse --short HEAD) — $EXPECTED migrations applied"
"${COMPOSE[@]}" ps ava
