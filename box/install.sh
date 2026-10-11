#!/bin/bash
# Install the weekly GPU-rates refresh on a host that has Docker, git and curl. Run as root:  bash install.sh
# Safe to run again. Undo with uninstall.sh.
#
# GPU_RATES_NOTIFY must be set in the environment: the command that reads a message on stdin and delivers it
# (exit 0 only if delivered). It is written into the unit on this host and is not kept in the repository.
#
# It makes, and touches nothing else:
#   /usr/local/lib/gpu-rates/run-weekly.sh        the job (a copy of box/run-weekly.sh next to this file)
#   /etc/systemd/system/gpu-rates-refresh.{service,timer}
#   ~ubuntu/gpu-rates/                             the clone, scratch space and the pinned GitHub host keys
#   ~ubuntu/.ssh/gpu-rates-deploy                  an SSH key made on this host; the private half never leaves it
#
# THE ONE STEP A PERSON MUST TAKE: the first run stops at exit 3 and prints the new key's public half. Add it
# as a deploy key WITH WRITE ACCESS on the repository, then run this again. A deploy key is limited to that one
# repository, and `main` is protected, so the host can push a branch and nothing else.
set -uo pipefail

USER_NAME=${GPU_RATES_USER:-ubuntu}
REPO=${GPU_RATES_REPO:-Tileward-com/tileward-gpu-rates}
REMOTE=${GPU_RATES_REMOTE:-git@github.com:$REPO.git}
NODE_IMAGE=${GPU_RATES_NODE_IMAGE:-node:22-slim}
LIB=/usr/local/lib/gpu-rates
HERE=$(cd "$(dirname "$0")" && pwd)

[ "$(id -u)" = 0 ] || { echo "run this as root"; exit 1; }
HOME_DIR=$(getent passwd "$USER_NAME" | cut -d: -f6)
[ -n "$HOME_DIR" ] || { echo "no such user: $USER_NAME"; exit 1; }
DIR=${GPU_RATES_DIR:-$HOME_DIR/gpu-rates}
KEY=${GPU_RATES_KEY:-$HOME_DIR/.ssh/gpu-rates-deploy}
as_user() { runuser -u "$USER_NAME" -- "$@"; }

for c in docker git curl ssh-keygen timeout runuser systemd-run; do
  command -v "$c" >/dev/null || { echo "missing on this host: $c"; exit 1; }
done
as_user docker version >/dev/null 2>&1 || { echo "$USER_NAME cannot talk to Docker"; exit 1; }
[ -n "${GPU_RATES_NOTIFY:-}" ] || { echo "set GPU_RATES_NOTIFY to the command that delivers a message read on stdin"; exit 1; }
case "$GPU_RATES_NOTIFY" in *\"*|*%*|*\\*) echo 'GPU_RATES_NOTIFY must not contain ", % or a backslash (systemd would read them)'; exit 1;; esac
[ -f "$HERE/run-weekly.sh" ] || { echo "run-weekly.sh must sit next to install.sh"; exit 1; }

# ---------------------------------------------------------------- the key and GitHub's host keys
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
as_user mkdir -p "$DIR"
if [ ! -f "$KEY" ]; then
  as_user ssh-keygen -q -t ed25519 -N '' -C "gpu-rates refresh $(hostname -s)" -f "$KEY" || exit 1
  echo "made a new deploy key at $KEY"
fi
# GitHub's host keys, read over TLS from its API and pinned, so the first SSH connection trusts nobody new.
curl -fsS -m 30 https://api.github.com/meta \
  | sed -n 's/^ *"\(ssh-ed25519 [^"]*\|ecdsa-sha2-nistp256 [^"]*\|ssh-rsa [^"]*\)",\{0,1\}$/github.com \1/p' >"$DIR/known_hosts.new"
[ -s "$DIR/known_hosts.new" ] || { echo "could not read GitHub's host keys from api.github.com/meta"; exit 1; }
chown "$USER_NAME": "$DIR/known_hosts.new" && mv "$DIR/known_hosts.new" "$DIR/known_hosts"
SSH="ssh -i $KEY -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$DIR/known_hosts"

if ! as_user env GIT_SSH_COMMAND="$SSH" git ls-remote "$REMOTE" HEAD >/dev/null 2>&1; then
  echo
  echo "GitHub does not accept this host's key yet. Add it as a deploy key WITH WRITE ACCESS on $REPO:"
  echo
  cat "$KEY.pub"
  as_user ssh-keygen -lf "$KEY.pub"
  echo
  echo "then run this script again."
  exit 3
fi

# ---------------------------------------------------------------------- the clone, and write access
[ -d "$DIR/repo/.git" ] || as_user env GIT_SSH_COMMAND="$SSH" git clone -q "$REMOTE" "$DIR/repo" || exit 1
as_user env GIT_SSH_COMMAND="$SSH" git -C "$DIR/repo" fetch -q origin || exit 1
# A dry-run push asks GitHub's receive-pack for permission without sending anything: a read-only key fails here.
as_user env GIT_SSH_COMMAND="$SSH" git -C "$DIR/repo" push --dry-run -q origin origin/main:refs/heads/refresh/box-install-check >/dev/null 2>&1 \
  || { echo "the key can read $REPO but not write to it: the deploy key needs write access"; exit 3; }

# --------------------------------------------------------------------------- the image, pinned by digest
as_user env DOCKER_CONFIG="$DIR/.docker" docker pull -q "$NODE_IMAGE" >/dev/null || { echo "could not pull $NODE_IMAGE"; exit 1; }
IMAGE_REF=$(as_user env DOCKER_CONFIG="$DIR/.docker" docker image inspect --format '{{index .RepoDigests 0}}' "$NODE_IMAGE")
[ -n "$IMAGE_REF" ] || { echo "no digest for $NODE_IMAGE"; exit 1; }
echo "node image: $IMAGE_REF"

# ---------------------------------------------------------------------------------- the job and its timer
install -d -m 755 "$LIB"
install -m 755 "$HERE/run-weekly.sh" "$LIB/run-weekly.sh"
echo "installed $LIB/run-weekly.sh (sha256 $(sha256sum "$LIB/run-weekly.sh" | cut -d' ' -f1))"

cat >/etc/systemd/system/gpu-rates-refresh.service <<UNIT
[Unit]
Description=Re-read provider GPU prices and propose changes ($REPO)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
User=$USER_NAME
Environment=GPU_RATES_DIR=$DIR
Environment=GPU_RATES_KEY=$KEY
Environment=GPU_RATES_IMAGE=$IMAGE_REF
Environment=DOCKER_CONFIG=$DIR/.docker
Environment="GPU_RATES_NOTIFY=$GPU_RATES_NOTIFY"
ExecStart=$LIB/run-weekly.sh
TimeoutStartSec=20min
Nice=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DIR
UNIT

cat >/etc/systemd/system/gpu-rates-refresh.timer <<UNIT
[Unit]
Description=Weekly GPU rates refresh

[Timer]
OnCalendar=Mon *-*-* 07:00:00 UTC
RandomizedDelaySec=300
Persistent=true
Unit=gpu-rates-refresh.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload

# ------------------------------------------------------------------ prove it under the same sandbox, pushing nothing
echo "dry run under the unit's sandbox (reads the providers, compares, pushes and sends nothing)..."
systemd-run --wait --collect --pipe \
  -p User="$USER_NAME" -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectSystem=strict -p ProtectHome=read-only \
  -p ReadWritePaths="$DIR" \
  -E GPU_RATES_PUSH=0 -E GPU_RATES_DIR="$DIR" -E GPU_RATES_KEY="$KEY" -E GPU_RATES_IMAGE="$IMAGE_REF" -E DOCKER_CONFIG="$DIR/.docker" \
  "$LIB/run-weekly.sh"
RC=$?
if [ "$RC" -ne 0 ]; then echo "the dry run failed (exit $RC): the timer was NOT enabled"; exit 1; fi

systemctl enable --now gpu-rates-refresh.timer || exit 1
echo
systemctl list-timers gpu-rates-refresh.timer --no-pager
echo "installed. Undo with: bash uninstall.sh"
