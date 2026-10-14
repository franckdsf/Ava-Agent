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
#   ./scripts/deploy.sh --auto weekly                     # deploy, then re-run Sundays 02:00
#   ./scripts/deploy.sh --auto off                        # remove the schedule, deploy nothing
#
# The first deploy on a fresh box is the same command: with no container yet
# there is nothing to stop or back up, and the build and the up run as usual.
#
# `--auto` writes one crontab line per Compose project, tagged so a re-run
# replaces it rather than adding a second. It is installed only after a deploy
# succeeds, so a schedule never exists for a setup that has not worked once.
# Sunday 02:00 in AGENT_TIMEZONE, converted to the server's zone, is clear of
# every hour the app schedules itself (prune 04:00, the Monday reviews
# 05:00/06:00, the pipelines from 08:00) — a restart mid-run would cut one
# short. A run with nothing new pulls nothing and logs one line.
#
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT=""
ENV_FILE=""
FORCE=0
BACKUP=1
AUTO=""
KEEP=7          # how many volume snapshots to keep
WAIT_SECONDS=120

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--project)  PROJECT="$2"; shift 2 ;;
    --env-file)    ENV_FILE="$2"; shift 2 ;;
    --force)       FORCE=1; shift ;;
    --no-backup)   BACKUP=0; shift ;;
    --auto)        AUTO="${2:-}"; shift 2 || shift ;;
    -h|--help)     sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

COMPOSE=(docker compose)
[ -n "$PROJECT" ]  && COMPOSE+=(-p "$PROJECT")
[ -n "$ENV_FILE" ] && COMPOSE+=(--env-file "$ENV_FILE")

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. schedule ───────────────────────────────────────────────────────────────
# The tag is what makes the line replaceable: `ava-alice` and `ava-bob` on one
# box each own one line, and neither run touches the other's. PATH is frozen
# into the line because cron's own is /usr/bin:/bin, and a docker installed
# anywhere else would be "command not found" every night with nobody watching.
case "$AUTO" in
  ''|weekly|off) ;;
  *) die "--auto takes weekly or off (got '$AUTO')" ;;
esac
CRON_TAG="# ava-deploy:${PROJECT:-default}"

if [ -n "$AUTO" ]; then
  command -v crontab >/dev/null || die "crontab not found — install cron first (Debian/Ubuntu: sudo apt install cron)"
fi

# Replaces this project's line with $1, or drops it when $1 is empty. The rest
# of the crontab is read in full before anything is written: piping
# `crontab -l` straight into `crontab -` races, and what loses is every other
# line the reader had.
write_cron() {
  local others
  others="$(crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true)"
  { [ -z "$others" ] || printf '%s\n' "$others"; [ -z "${1:-}" ] || printf '%s\n' "$1"; } | crontab -
}

# Minute of the week, Sunday 00:00 = 0, of the current instant in zone $1 — or
# in the server's own zone when $1 is empty (TZ="" would mean UTC, not local).
minute_of_week() {
  local d h m
  if [ -n "$1" ]; then read -r d h m < <(TZ="$1" date '+%w %H %M')
  else read -r d h m < <(date '+%w %H %M'); fi
  echo $(( d * 1440 + 10#$h * 60 + 10#$m ))
}

install_schedule() {
  [ -n "$AUTO" ] || return 0
  local args="" line tz server delta at dow hour min
  [ -n "$PROJECT" ]  && args+=" -p $(printf '%q' "$PROJECT")"
  [ -n "$ENV_FILE" ] && args+=" --env-file $(printf '%q' "$ENV_FILE")"

  # The app fires its schedules in AGENT_TIMEZONE; cron fires in the server's
  # zone, which on a VPS is usually UTC. Sunday 02:00 is meant in the reader's
  # zone, so it is converted here — once, at install. A DST change on either
  # side moves it by an hour at most, to 01:00 or 03:00, still clear of 04:00.
  tz="$(grep -E '^AGENT_TIMEZONE=' "${ENV_FILE:-.env}" | tail -n 1 | cut -d= -f2- | tr -d "\"'\r")"
  tz="${tz:-Europe/Paris}"   # the default docker-compose.yml applies
  if [ -d /usr/share/zoneinfo ] && [ ! -f "/usr/share/zoneinfo/$tz" ]; then
    die "AGENT_TIMEZONE=$tz is not a known time zone — schedule not installed"
  fi
  server="$(minute_of_week "")"
  delta=$(( server - $(minute_of_week "$tz") ))
  at=$(( ((2 * 60 + delta) % 10080 + 10080) % 10080 ))
  dow=$(( at / 1440 )); hour=$(( at % 1440 / 60 )); min=$(( at % 60 ))

  line="$min $hour * * $dow cd $(printf '%q' "$PWD") && PATH=$(printf '%q' "$PATH") ./scripts/deploy.sh$args >> deploy${PROJECT:+-$PROJECT}.log 2>&1 $CRON_TAG"
  # cron turns an unescaped % into a newline, which would cut the command short.
  case "$line" in *%*) die "a path contains '%', which cron cannot take — schedule not installed" ;; esac
  write_cron "$line"
  say "Scheduled every Sunday at 02:00 $tz — log in deploy${PROJECT:+-$PROJECT}.log"
}

if [ "$AUTO" = "off" ]; then
  write_cron ""
  echo "Removed the ${PROJECT:-default} deploy schedule. Nothing deployed."
  exit 0
fi

# ── 0b. preconditions ─────────────────────────────────────────────────────────
# Compose reads ./.env silently when it exists and boots with blanks when it
# does not; zod then names the missing variable, but only in a container log.
if [ -n "$ENV_FILE" ]; then
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found"
else
  [ -f .env ] || die ".env not found — run \`pnpm setup\` on a machine with Node, then copy .env here"
fi

# One deploy at a time per checkout: a cron run and a hand run would pull and
# build over each other. The lock lives in .git so it can never dirty the tree.
if command -v flock >/dev/null; then
  exec 9>"$(git rev-parse --git-dir)/deploy.lock"
  flock -n 9 || die "another deploy is already running in this checkout"
fi

# Under cron nothing can answer a prompt, so a git that would ask for a password
# or a host-key confirmation fails at once instead of hanging every night.
if [ ! -t 0 ]; then
  export GIT_TERMINAL_PROMPT=0
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes}"
fi

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
  echo "$(date '+%F %T') Already on $(git rev-parse --short HEAD) and running. Nothing to do."
  install_schedule
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
install_schedule
