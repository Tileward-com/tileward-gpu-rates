#!/bin/bash
# Weekly job: re-read the providers' GPU prices; if any moved, push a branch for a pull request; always
# write a heartbeat; tell a person (through the Tileward watchdog's message path) when there is something to
# do or something wrong. Installed by box/install.sh, run by gpu-rates-refresh.timer.
#
#   run-weekly.sh                      the real run
#   GPU_RATES_PUSH=0 run-weekly.sh     a dry run: read, compare, print; push nothing, send nothing
#
# WHAT RUNS WHERE. The repository's Node code (refresh/run.mjs) runs in a throwaway container with no
# credentials, no Docker socket and a read-only root, so it can only fetch public pages and write into
# the scratch checkout it is given. Everything that holds a credential happens here, on the host:
# the deploy key (push a branch to this one repository; `main` is protected), and the notifier, a command
# that reads a message on stdin and delivers it from wherever the delivery credential already lives (the
# credential never travels here: the message travels there). GPU_RATES_NOTIFY names that command; the
# installer takes it from its environment and writes it into the unit, so this file names nothing internal.
#
# WHAT IT NEVER DOES. Push to main, merge, open the pull request itself (a workflow in the repository
# does that from the pushed branch), or edit anything but gpu-rates.json.
set -uo pipefail

DIR=${GPU_RATES_DIR:-/home/ubuntu/gpu-rates}
REPO=${GPU_RATES_REPO:-Tileward-com/tileward-gpu-rates}
REMOTE=${GPU_RATES_REMOTE:-git@github.com:$REPO.git}
KEY=${GPU_RATES_KEY:-/home/ubuntu/.ssh/gpu-rates-deploy}
IMAGE=${GPU_RATES_IMAGE:-node:22-slim}
RUNNER=${GPU_RATES_RUNNER:-docker}                 # docker | host (host: a node on PATH; used by the tests)
PUSH=${GPU_RATES_PUSH:-1}
API=${GPU_RATES_API:-https://api.github.com}
WEB=${GPU_RATES_WEB:-https://github.com}
NOTIFY=${GPU_RATES_NOTIFY:-}                        # command: message on stdin; exit 0 only if it was delivered
PR_WAIT=${GPU_RATES_PR_WAIT_SECONDS:-420}
AUTHOR_NAME="Tileward GPU rates"
AUTHOR_EMAIL="noreply@tileward.com"

STEP=start
RUN=$(date -u +%Y%m%dT%H%M%SZ)
WORK=""
HB=""

log() { printf '%s gpu-rates: %s\n' "$(date -u +%FT%TZ)" "$*"; }

# Send one message through the notifier. Anything but exit 0 means it was not delivered: a quiet channel
# must not read as success, so the caller turns a failure here into a failed run.
notify() {
  if [ "$PUSH" != 1 ]; then printf -- '---- dry run, would send:\n%s\n----\n' "$1"; return 0; fi
  printf '%s' "$1" | $NOTIFY >/dev/null
  local rc=$?
  [ "$rc" -eq 0 ] || echo "WARNING: the notification was not delivered (notifier exit $rc)" >&2
  return "$rc"
}

cleanup() {
  [ -n "$WORK" ] && git -C "${DIR:?}/repo" worktree remove --force "$WORK" >/dev/null 2>&1
  [ -n "$HB" ] && rm -rf -- "${HB:?}"
  [ -d "${DIR:?}/out" ] && find "$DIR/out" -mindepth 1 -maxdepth 1 -mtime +60 -exec rm -rf -- {} + 2>/dev/null
  return 0
}

# Any exit that is not a success tells a person, once, with where to look.
on_exit() {
  local rc=$?
  trap - EXIT
  if [ "$rc" -ne 0 ]; then
    notify "GPU rates refresh FAILED at step '$STEP' (exit $rc). On the host: journalctl -u gpu-rates-refresh -n 100" || true
  fi
  cleanup
  exit "$rc"
}
trap on_exit EXIT

die() { echo "gpu-rates: $*" >&2; exit 1; }

[ "$PUSH" != 1 ] || [ -n "$NOTIFY" ] || die "GPU_RATES_NOTIFY is not set: nothing would tell a person"
mkdir -p "$DIR/work" "$DIR/out" "$DIR/state" || die "cannot create $DIR"
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$DIR/known_hosts"

# ------------------------------------------------------------------------------------- the checkout
STEP=checkout
if [ ! -d "$DIR/repo/.git" ]; then git clone -q "$REMOTE" "$DIR/repo" || die "clone of $REMOTE failed"; fi
git -C "$DIR/repo" fetch -q --prune origin || die "fetch failed"
git -C "$DIR/repo" worktree prune
WORK="$DIR/work/$RUN"
OUT="$DIR/out/$RUN"
mkdir -p "$OUT"
git -C "$DIR/repo" worktree add -q --detach "$WORK" origin/main || die "cannot check out origin/main"

# ------------------------------------------------------------------------------------- the refresh
STEP=refresh
if [ "$RUNNER" = docker ]; then
  timeout -k 20 600 docker run --rm --name "gpu-rates-refresh-$$" \
    --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 1g --pids-limit 128 --tmpfs /tmp:rw,size=64m -e HOME=/tmp \
    -v "$WORK:/work" -v "$OUT:/out" -w /work "$IMAGE" \
    node refresh/run.mjs --write --report /out/report.json --heartbeat /out/heartbeat.json \
    >"$OUT/summary.txt" 2>"$OUT/stderr.txt"
else
  (cd "$WORK" && node refresh/run.mjs --write --report "$OUT/report.json" --heartbeat "$OUT/heartbeat.json") \
    >"$OUT/summary.txt" 2>"$OUT/stderr.txt"
fi
RC=$?
cat "$OUT/summary.txt"
cat "$OUT/stderr.txt" >&2
case "$RC" in
  0|10|11|12) ;;                                   # clean | change proposed | some unread | both
  *) docker rm -f "gpu-rates-refresh-$$" >/dev/null 2>&1; die "refresh exited $RC: $(tail -c 300 "$OUT/stderr.txt")" ;;
esac
[ -s "$OUT/heartbeat.json" ] && [ -s "$OUT/report.json" ] || die "the refresh wrote no report"
log "refresh status code $RC"

# ----------------------------------------------------------------------------------------- heartbeat
# Written every run, before anything else is pushed, and honest: it says how many rows were READ, so a run
# that could only reach one provider does not look like a run that found nothing to change. The report
# rides along: the workflow that opens the pull request quotes it.
STEP=heartbeat
if [ "$PUSH" = 1 ]; then
  HB="$DIR/work/hb-$RUN"
  mkdir -p "$HB" && cp "$OUT/heartbeat.json" "$OUT/report.json" "$HB/" || die "cannot stage the heartbeat"
  git -C "$HB" init -q && git -C "$HB" checkout -q -b agent-heartbeat \
    && git -C "$HB" add -A \
    && git -C "$HB" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" commit -q -m "Heartbeat" \
    && git -C "$HB" push -q --force "$REMOTE" agent-heartbeat || die "heartbeat push failed"
fi

# ----------------------------------------------------------------------------------- what to tell people
unread_lines() { grep '^  not read ' "$OUT/summary.txt" | cut -c1-220 | head -10; }

case "$RC" in
  0) log "every row read, nothing to change"; exit 0 ;;

  11)
    STEP=notify
    notify "$(printf 'GPU prices: some rows could not be read, so this week is not a clean check. No change is proposed from the rest.\n\n%s' "$(unread_lines)")" || exit 1
    exit 0 ;;

  10|12)
    STEP=branch
    BRANCH="refresh/box-$(date -u +%F)"
    # Committed on a detached HEAD and pushed by name: no local branch is left behind to collide with the
    # next run's (a rerun on the same day would otherwise fail on "branch already exists").
    git -C "$WORK" add gpu-rates.json
    N=$(git -C "$WORK" diff --cached --numstat -- gpu-rates.json | awk '{print $1}')
    [ -n "$N" ] && [ "$N" -gt 0 ] || die "the report says prices changed but gpu-rates.json did not"
    git -C "$WORK" -c user.name="$AUTHOR_NAME" -c user.email="$AUTHOR_EMAIL" commit -q -m "GPU rates refresh: $N changed" || die "commit failed"
    TREE=$(git -C "$WORK" rev-parse 'HEAD^{tree}')   # the content, not the commit: every run makes a new commit

    if [ "$PUSH" != 1 ]; then
      STEP=notify
      notify "$(printf 'GPU prices: %s changed (dry run, nothing pushed).\n\n%s' "$N" "$(grep '^  changed ' "$OUT/summary.txt" | sed 's/   \[.*$//' | head -12)")"
      exit 0
    fi

    if [ "$(cat "$DIR/state/last-notified" 2>/dev/null)" = "$BRANCH $TREE" ]; then log "already pushed and notified for $BRANCH with this content"; exit 0; fi
    STEP=push
    git -C "$WORK" push -q --force "$REMOTE" "HEAD:refs/heads/$BRANCH" || die "push of $BRANCH failed"

    # The pull request is opened by a workflow in the repository, from this branch. Wait for it, so the
    # message carries the link a person taps.
    STEP=wait-for-pr
    PR_URL=""
    waited=0
    while :; do
      if [ -n "${GPU_RATES_FIND_PR:-}" ]; then PR_URL=$($GPU_RATES_FIND_PR "$BRANCH" 2>/dev/null)
      else
        PR_URL=$(curl -fsS -m 20 "$API/repos/$REPO/pulls?state=open&head=${REPO%%/*}:$BRANCH" 2>/dev/null \
          | sed -n 's|^    "html_url": "\(https://[^"]*/pull/[0-9]*\)".*|\1|p' | head -1)
      fi
      [ -n "$PR_URL" ] && break
      [ "$waited" -ge "$PR_WAIT" ] && break
      sleep 15; waited=$((waited + 15))
    done

    STEP=notify
    CHANGED=$(grep '^  changed ' "$OUT/summary.txt" | sed 's/   \[.*$//' | head -12)
    UNREAD=$(unread_lines)
    if [ -n "$PR_URL" ]; then
      MSG=$(printf 'GPU prices: %s changed. Review it, then merge to publish or close to reject:\n%s\n\n%s' "$N" "$PR_URL" "$CHANGED")
    else
      MSG=$(printf 'GPU prices: %s changed, but no pull request appeared for %s after %ss. Open it from the branch:\n%s/%s/compare/main...%s?expand=1\nWorkflow runs: %s/%s/actions\n\n%s' \
        "$N" "$BRANCH" "$PR_WAIT" "$WEB" "$REPO" "$BRANCH" "$WEB" "$REPO" "$CHANGED")
    fi
    [ -n "$UNREAD" ] && MSG=$(printf '%s\n\nNot read this week (kept at their previous price):\n%s' "$MSG" "$UNREAD")
    notify "$MSG" || exit 1
    echo "$BRANCH $TREE" >"$DIR/state/last-notified"
    exit 0 ;;
esac
