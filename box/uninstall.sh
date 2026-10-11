#!/bin/bash
# Take the weekly GPU-rates refresh off this host. Run as root:  bash uninstall.sh
# Stops and removes the timer, the service and the installed script. It leaves the clone, the logs and the
# SSH key in ~ubuntu/gpu-rates and ~ubuntu/.ssh/gpu-rates-deploy so nothing is lost; it prints what to remove by
# hand, including the deploy key on GitHub, which is the one thing that still grants access.
set -uo pipefail
[ "$(id -u)" = 0 ] || { echo "run this as root"; exit 1; }

systemctl disable --now gpu-rates-refresh.timer 2>/dev/null
systemctl stop gpu-rates-refresh.service 2>/dev/null
rm -f /etc/systemd/system/gpu-rates-refresh.service /etc/systemd/system/gpu-rates-refresh.timer
rm -f /usr/local/lib/gpu-rates/run-weekly.sh
rmdir /usr/local/lib/gpu-rates 2>/dev/null
systemctl daemon-reload
systemctl reset-failed gpu-rates-refresh.service 2>/dev/null

echo "removed the timer, the service and /usr/local/lib/gpu-rates."
echo "still there, on purpose: ~ubuntu/gpu-rates (clone, logs) and ~ubuntu/.ssh/gpu-rates-deploy{,.pub}."
echo "to revoke access, delete the deploy key on GitHub: Settings > Deploy keys of the repository (its title names this host)."
