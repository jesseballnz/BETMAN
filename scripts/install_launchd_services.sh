#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
SERVER_LABEL="nz.betman.server"
POLLER_LABEL="nz.betman.poller"
SERVER_PLIST="${LAUNCH_AGENTS_DIR}/${SERVER_LABEL}.plist"
POLLER_PLIST="${LAUNCH_AGENTS_DIR}/${POLLER_LABEL}.plist"
UID_VALUE="$(id -u)"

mkdir -p "$LAUNCH_AGENTS_DIR" "$ROOT_DIR/logs"

write_plist() {
  local label="$1"
  local program="$2"
  local stdout_path="$3"
  local stderr_path="$4"
  local plist_path="$5"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${program}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${ROOT_DIR}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${stdout_path}</string>

  <key>StandardErrorPath</key>
  <string>${stderr_path}</string>
</dict>
</plist>
PLIST
}

launchctl_bootstrap() {
  local plist_path="$1"
  launchctl bootout "gui/${UID_VALUE}" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID_VALUE}" "$plist_path"
}

launchctl_bootout() {
  local plist_path="$1"
  launchctl bootout "gui/${UID_VALUE}" "$plist_path" >/dev/null 2>&1 || true
}

print_status() {
  echo "BETMAN launchd status"
  echo "- server plist: $SERVER_PLIST"
  echo "- poller plist: $POLLER_PLIST"
  echo
  launchctl print "gui/${UID_VALUE}/${SERVER_LABEL}" 2>/dev/null | sed -n '1,40p' || echo "server: not loaded"
  echo
  launchctl print "gui/${UID_VALUE}/${POLLER_LABEL}" 2>/dev/null | sed -n '1,40p' || echo "poller: not loaded"
}

print_usage() {
  cat <<USAGE
Usage:
  ./scripts/install_launchd_services.sh write    # write/update plist files only
  ./scripts/install_launchd_services.sh install  # write plist files and load them into launchd
  ./scripts/install_launchd_services.sh uninstall
  ./scripts/install_launchd_services.sh status
  ./scripts/install_launchd_services.sh print

This creates real macOS launchd user agents with KeepAlive + RunAtLoad so BETMAN
restarts after crashes and after user login/reboot.
USAGE
}

write_all() {
  write_plist "$SERVER_LABEL" \
    "$ROOT_DIR/scripts/betman_server_launcher.sh" \
    "$ROOT_DIR/logs/launchd-server.out.log" \
    "$ROOT_DIR/logs/launchd-server.err.log" \
    "$SERVER_PLIST"

  write_plist "$POLLER_LABEL" \
    "$ROOT_DIR/scripts/betman_poller_launcher.sh" \
    "$ROOT_DIR/logs/launchd-poller.out.log" \
    "$ROOT_DIR/logs/launchd-poller.err.log" \
    "$POLLER_PLIST"

  chmod 644 "$SERVER_PLIST" "$POLLER_PLIST"
  chmod 755 "$ROOT_DIR/scripts/betman_server_launcher.sh" "$ROOT_DIR/scripts/betman_poller_launcher.sh" "$ROOT_DIR/scripts/betman_env.sh"

  echo "Wrote:"
  echo "- $SERVER_PLIST"
  echo "- $POLLER_PLIST"
}

ACTION="${1:-install}"
case "$ACTION" in
  write)
    write_all
    ;;
  install)
    write_all
    launchctl_bootstrap "$SERVER_PLIST"
    launchctl_bootstrap "$POLLER_PLIST"
    print_status
    ;;
  uninstall)
    launchctl_bootout "$SERVER_PLIST"
    launchctl_bootout "$POLLER_PLIST"
    echo "Unloaded ${SERVER_LABEL} and ${POLLER_LABEL}"
    ;;
  status)
    print_status
    ;;
  print)
    echo "$SERVER_PLIST"
    echo "$POLLER_PLIST"
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
