#!/usr/bin/env bash
# ClinePass Bridge - self-bootstrapping launcher (macOS / Linux).
# Run:  chmod +x start-bridge.sh && ./start-bridge.sh
# It will, in order:
#   1. Install Bun if missing
#   2. Install the Cline CLI (npm i -g cline) if missing
#   3. Log in to ClinePass (cline auth) if no stored credentials
#   4. Start the bridge, WAIT until it answers health checks,
#      then open the dashboard. If it never becomes healthy,
#      this script prints the error and exits non-zero.
# Ctrl+C or close the terminal to stop.
set -u
cd "$(dirname "$0")"

log() { echo "[launcher] $*"; }
fail() { log "ERROR: $*"; exit 1; }

[ -f "clinepass-bridge.ts" ] || fail "clinepass-bridge.ts not found next to this script. Unzip ALL files into one folder and try again."

# ---------- 1. Bun ----------
if ! command -v bun >/dev/null 2>&1; then
  log "Bun not found - installing... (this takes about a minute)"
  curl -fsSL https://bun.sh/install | bash || fail "Bun install failed. See https://bun.sh"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "Bun installed but not on PATH ($BUN_INSTALL/bin). Add it and re-run."
  log "Bun installed."
fi

# ---------- 2. Cline CLI ----------
if ! command -v cline >/dev/null 2>&1; then
  log "Cline CLI not found - installing via npm..."
  command -v npm >/dev/null 2>&1 || fail "npm not found. Install Node.js LTS (https://nodejs.org), then re-run."
  npm i -g cline || fail "'npm i -g cline' failed. Check the npm output above, then re-run."
  command -v cline >/dev/null 2>&1 || fail "cline installed but not on PATH. Check your npm global bin dir, then re-run."
  log "Cline CLI installed."
fi

# ---------- 3. ClinePass login ----------
if [ ! -f "$HOME/.cline/data/settings/providers.json" ]; then
  log "No Cline credentials found - starting login."
  log "A browser window will open: approve the device code there, then return here."
  cline auth --provider cline-pass || fail "Login failed. Re-run this script and approve the code."
  [ -f "$HOME/.cline/data/settings/providers.json" ] || fail "Login did not complete (no credentials file). Re-run and approve the code."
  log "Logged in."
fi

# ---------- 4. Launch (health-gated) ----------
freeport() {
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids="$(lsof -ti:8081 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      { log "Freeing port 8081 (PID $pids)..."; kill -9 $pids 2>/dev/null || true; }
    fi
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k 8081/tcp 2>/dev/null || true
  fi
}

freeport
sleep 2

log "Starting bridge in the background to verify it comes up..."
rm -f bridge.log
bun clinepass-bridge.ts > bridge.log 2>&1 &
BG_PID=$!

READY=0
for _ in $(seq 1 45); do
  if curl -sf -o /dev/null http://localhost:8081/health 2>/dev/null; then READY=1; break; fi
  sleep 2
done

if [ "$READY" != 1 ]; then
  log "ERROR: the bridge did not answer within ~90 seconds."
  if [ -f bridge.log ]; then
    log "Last lines of bridge.log:"; tail -n 20 bridge.log
  else
    log "No bridge.log was written - Bun may have failed to start."
    log "Try running by hand for the full error:  bun clinepass-bridge.ts"
  fi
  kill "$BG_PID" 2>/dev/null || true
  freeport
  exit 1
fi

log "Bridge is up - opening dashboard at http://localhost:8081/"
URL="http://localhost:8081/"
if command -v open >/dev/null 2>&1; then
  open "$URL" 2>/dev/null &
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" 2>/dev/null &
fi

# Hand over to a foreground instance so logs are visible here and
# Ctrl+C / closing the terminal stops the server.
kill "$BG_PID" 2>/dev/null || true
wait "$BG_PID" 2>/dev/null || true
sleep 3

crashes=0
while true; do
  log "Starting bridge... (Ctrl+C to stop)"
  bun clinepass-bridge.ts
  code=$?
  crashes=$((crashes + 1))
  log "Bridge exited with code $code (consecutive exit #$crashes)."
  if [ "$crashes" -ge 5 ]; then
    log "The bridge keeps exiting right away. Check the error above,"
    log "or force a token refresh from the dashboard. Press Enter to keep"
    log "retrying, or Ctrl+C to stop."
    read -r _
    crashes=0
  fi
  sleep 3
done
